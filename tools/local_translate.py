"""
Local GPU-accelerated subtitle translation for SaltyChart.

Translates anime trailers locally using Whisper large-v3 on your GPU,
then uploads results to your SaltyChart server.  Much faster and higher
quality than the server-side CPU translation.

Requirements:
  pip install faster-whisper yt-dlp

  For GPU (recommended):
    pip install nvidia-cublas-cu12 nvidia-cudnn-cu12
    (or install CUDA toolkit separately)

Usage:
  # Translate all eligible trailers for the upcoming season
  python local_translate.py --server http://YOUR_SERVER:8085 -u USERNAME -p PASSWORD

  # Specify season/year
  python local_translate.py --server http://192.168.1.X:8085 -u user -p pass --season SPRING --year 2026

  # Dry run (list trailers without translating)
  python local_translate.py --server http://192.168.1.X:8085 -u user -p pass --dry-run

  # Translate a single video (no AniList fetch needed)
  python local_translate.py --server http://192.168.1.X:8085 --video 9OWMV9XrZ8k --no-upload

  # Force CPU / different model
  python local_translate.py --server http://192.168.1.X:8085 -u user -p pass --device cpu --model medium

  # Use a JWT token directly instead of username/password
  python local_translate.py --server http://192.168.1.X:8085 --token YOUR_JWT

Flags:
  --server URL       SaltyChart server URL (required)
  -u, --username     Login username
  -p, --password     Login password
  --token            JWT token (alternative to username/password)
  --season           WINTER, SPRING, SUMMER, FALL (default: auto-detect next)
  --year             e.g. 2026 (default: auto-detect)
  --model            Whisper model (default: large-v3)
  --device           cuda or cpu (default: auto-detect)
  --video            Translate a single YouTube video ID (skips AniList)
  --no-upload        Translate locally without uploading to server
  --dry-run          List eligible trailers without translating
  --log [PATH]       Log output to file (default: tools/logs/translate.log)
  --within-days N    Exit if next season is more than N days away

Windows wrapper: tools/translate.bat (uses py -3.13)
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile
import shutil
import time
import urllib.request
from datetime import datetime


# ---------------------------------------------------------------------------
# AniList
# ---------------------------------------------------------------------------

ANILIST_URL = "https://graphql.anilist.co"

ANILIST_QUERY = """
query ($page: Int, $perPage: Int, $season: MediaSeason, $seasonYear: Int) {
  Page(page: $page, perPage: $perPage) {
    pageInfo { hasNextPage }
    media(season: $season, seasonYear: $seasonYear, type: ANIME) {
      id
      title { romaji english }
      isAdult
      format
      trailer { id site }
      relations { edges { relationType } }
    }
  }
}
"""

ELIGIBLE_FORMATS = {"TV", "TV_SHORT", "OVA", "ONA", "SPECIAL"}
SEQUEL_RELATIONS = {"SEQUEL", "PREQUEL", "SIDE_STORY", "SPINOFF"}


def fetch_season_anime(season: str, year: int) -> list:
    """Fetch all anime for a season from AniList (paginated)."""
    all_media = []
    page = 1

    while True:
        variables = {"page": page, "perPage": 50, "season": season, "seasonYear": year}
        body = json.dumps({"query": ANILIST_QUERY, "variables": variables}).encode()
        req = urllib.request.Request(
            ANILIST_URL,
            data=body,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                "User-Agent": "SaltyChart/1.0 (local-translate)",
            },
        )
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    data = json.loads(resp.read().decode())
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  [ERROR] AniList failed after 3 attempts: {e}")
                    return all_media
                time.sleep((attempt + 1) * 5)

        page_data = data.get("data", {}).get("Page", {})
        all_media.extend(page_data.get("media", []))
        if not page_data.get("pageInfo", {}).get("hasNextPage", False):
            break
        page += 1
        time.sleep(1)

    return all_media


def is_sequel(show: dict) -> bool:
    edges = show.get("relations", {}).get("edges", [])
    return any(e.get("relationType") in SEQUEL_RELATIONS for e in edges)


def get_title(show: dict) -> str:
    t = show.get("title", {})
    return t.get("english") or t.get("romaji") or str(show.get("id", "?"))


def filter_eligible(anime_list: list) -> list:
    eligible = []
    for show in anime_list:
        if show.get("format") not in ELIGIBLE_FORMATS:
            continue
        if show.get("isAdult"):
            continue
        if is_sequel(show):
            continue
        trailer = show.get("trailer")
        if not trailer or trailer.get("site") != "youtube" or not trailer.get("id"):
            continue
        eligible.append(show)
    return eligible


# ---------------------------------------------------------------------------
# Season detection
# ---------------------------------------------------------------------------

SEASONS = ["WINTER", "SPRING", "SUMMER", "FALL"]


def next_season_info() -> tuple:
    now = datetime.now()
    month = now.month
    if month <= 3:
        current = "WINTER"
    elif month <= 6:
        current = "SPRING"
    elif month <= 9:
        current = "SUMMER"
    else:
        current = "FALL"
    idx = SEASONS.index(current)
    next_idx = (idx + 1) % 4
    return SEASONS[next_idx], now.year + (1 if next_idx == 0 else 0)


# Approximate first day of each season
SEASON_START_MONTH = {"WINTER": 1, "SPRING": 4, "SUMMER": 7, "FALL": 10}


def days_until_next_season() -> int:
    """Return approximate days until the next anime season starts."""
    season, year = next_season_info()
    start = datetime(year, SEASON_START_MONTH[season], 1)
    return (start - datetime.now()).days


# ---------------------------------------------------------------------------
# Audio download & chunking (self-contained, no backend imports)
# ---------------------------------------------------------------------------

def download_audio(video_id: str, tmpdir: str):
    """Download full audio as WAV. Returns (path, duration)."""
    import yt_dlp

    full_audio = os.path.join(tmpdir, "full.wav")
    ydl_opts = {
        "format": "worstaudio",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
        "outtmpl": os.path.join(tmpdir, "full.%(ext)s"),
    }
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=True
        )
        duration = info.get("duration", 120)
    return full_audio, duration


def generate_chunks(duration: float):
    """Generate chunk boundaries with ramp-up strategy."""
    RAMP = [5, 5, 10, 10]
    CHUNK_SIZE = 20
    chunks, start, i = [], 0, 0
    while start < duration:
        size = RAMP[i] if i < len(RAMP) else CHUNK_SIZE
        i += 1
        end = min(start + size, duration)
        chunks.append((start, end))
        start = end
    return chunks


def extract_chunk(chunk_start, chunk_end, tmpdir, full_audio):
    """Extract a single audio chunk via ffmpeg."""
    chunk_path = os.path.join(tmpdir, f"chunk_{chunk_start}.wav")
    cmd = ["ffmpeg", "-y", "-ss", str(chunk_start)]
    if chunk_end is not None:
        cmd += ["-t", str(chunk_end - chunk_start)]
    cmd += ["-i", full_audio, "-ac", "1", "-ar", "16000", "-f", "wav", chunk_path]
    subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=30)
    return chunk_path


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------

def translate_video(model, video_id: str):
    """Translate a video, return list of segment dicts."""
    from concurrent.futures import ThreadPoolExecutor, Future

    tmpdir = tempfile.mkdtemp()
    try:
        full_audio, duration = download_audio(video_id, tmpdir)
        chunks = generate_chunks(duration)
        segments = []

        with ThreadPoolExecutor(max_workers=1) as pool:
            next_future: Future = pool.submit(extract_chunk, chunks[0][0], chunks[0][1], tmpdir, full_audio)

            for i, (chunk_start, chunk_end) in enumerate(chunks):
                chunk_path = next_future.result()
                if i + 1 < len(chunks):
                    next_future = pool.submit(extract_chunk, chunks[i + 1][0], chunks[i + 1][1], tmpdir, full_audio)
                try:
                    segs, _ = model.transcribe(
                        chunk_path, language="ja", task="translate",
                        vad_filter=True, beam_size=5,
                        condition_on_previous_text=True,
                    )
                    for seg in segs:
                        text = seg.text.strip()
                        if text:
                            segments.append({
                                "start": round(seg.start + chunk_start, 2),
                                "end": round(seg.end + chunk_start, 2),
                                "text": text,
                            })
                finally:
                    if os.path.exists(chunk_path):
                        os.unlink(chunk_path)

        return segments
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Server communication
# ---------------------------------------------------------------------------

MODEL_RANK = {"tiny": 0, "base": 1, "small": 2, "medium": 3, "large-v2": 4, "large-v3": 5}


def check_server_cache(server: str, video_id: str, model_name: str) -> tuple:
    """Check server cache. Returns (is_cached_at_or_above_model, cached_model_name)."""
    try:
        req = urllib.request.Request(
            f"{server}/api/translate/check?videoId={video_id}",
            headers={"User-Agent": "SaltyChart/1.0 (local-translate)"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        if not data.get("hasCachedSegments"):
            return False, None
        cached_model = data.get("modelName") or "small"
        cached_rank = MODEL_RANK.get(cached_model, 0)
        target_rank = MODEL_RANK.get(model_name, 5)
        return cached_rank >= target_rank, cached_model
    except Exception:
        return False, None


def login(server: str, username: str, password: str) -> str:
    """Log in and return JWT token."""
    body = json.dumps({"username": username, "password": password}).encode()
    req = urllib.request.Request(
        f"{server}/api/auth/login",
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        data = json.loads(resp.read().decode())
    if "token" not in data:
        raise Exception(f"Login failed: {data.get('error', 'unknown error')}")
    return data["token"]


def upload_segments(server: str, token: str, video_id: str, media_id: int, model_name: str, segments: list) -> dict:
    """Upload translated segments to the server."""
    body = json.dumps({
        "videoId": video_id,
        "mediaId": media_id,
        "modelName": model_name,
        "segments": segments,
    }).encode()
    req = urllib.request.Request(
        f"{server}/api/translate/upload",
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode())


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Local GPU subtitle translation for SaltyChart")
    parser.add_argument("--server", required=True, help="SaltyChart server URL (e.g. http://192.168.1.X:8085)")
    parser.add_argument("--username", "-u", type=str, help="SaltyChart username")
    parser.add_argument("--password", "-p", type=str, help="SaltyChart password")
    parser.add_argument("--token", type=str, help="JWT auth token (alternative to username/password)")
    parser.add_argument("--season", type=str, help="Season: WINTER, SPRING, SUMMER, FALL")
    parser.add_argument("--year", type=int, help="Year (e.g. 2026)")
    parser.add_argument("--model", type=str, default="large-v3", help="Whisper model (default: large-v3)")
    parser.add_argument("--device", type=str, default=None, help="Device: cuda, cpu (default: auto-detect)")
    parser.add_argument("--dry-run", action="store_true", help="List trailers without translating")
    parser.add_argument("--video", type=str, help="Translate a single YouTube video ID (skip AniList fetch)")
    parser.add_argument("--no-upload", action="store_true", help="Translate but don't upload to server")
    parser.add_argument("--log", type=str, nargs="?", const=os.path.join(os.path.dirname(__file__), "logs", "translate.log"),
                        help="Log output to file (default: tools/logs/translate.log)")
    parser.add_argument("--within-days", type=int, default=None, metavar="N",
                        help="Exit if next season is more than N days away")
    args = parser.parse_args()

    # --- File logging ---
    log_file = None
    if args.log:
        log_path = args.log
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        log_file = open(log_path, "a", encoding="utf-8")
        log_file.write(f"\n{'='*60}\n")
        log_file.write(f"Run started: {datetime.now().isoformat()}\n")
        log_file.write(f"{'='*60}\n")

        import builtins
        _original_print = builtins.print
        def tee_print(*args, **kwargs):
            _original_print(*args, **kwargs)
            _original_print(*args, **{**kwargs, "file": log_file, "flush": True})
        builtins.print = tee_print

    # --- Within-days gate ---
    if args.within_days is not None:
        days = days_until_next_season()
        if days > args.within_days:
            season, year = next_season_info()
            print(f"[local] Next season ({season} {year}) is {days} days away (threshold: {args.within_days}). Exiting.")
            if log_file:
                log_file.close()
            return
        else:
            season, year = next_season_info()
            print(f"[local] Next season ({season} {year}) is {days} days away — within {args.within_days}-day window, proceeding.")

    server = args.server.rstrip("/")

    # Authenticate (optional for --video --no-upload)
    token = args.token
    if not token and args.username and args.password:
        print(f"[local] Logging in as {args.username}...")
        try:
            token = login(server, args.username, args.password)
            print(f"[local] Authenticated.")
        except Exception as e:
            print(f"[local] Login failed: {e}")
            sys.exit(1)
    if not token and not args.no_upload and not (args.video and args.no_upload):
        if not args.username or not args.password:
            parser.error("Provide --username and --password, or --token (not needed with --video --no-upload)")

    # Determine season
    if args.season and args.year:
        season, year = args.season.upper(), args.year
    else:
        season, year = next_season_info()

    # Detect device — auto-install GPU dependencies if missing
    device = args.device
    if not device:
        try:
            import torch
            if not torch.cuda.is_available():
                raise RuntimeError("CUDA not available")
            device = "cuda"
        except (ImportError, RuntimeError):
            # Try installing PyTorch with CUDA support
            print("[local] PyTorch CUDA not found. Installing...")
            import subprocess as _sp
            _sp.check_call([
                sys.executable, "-m", "pip", "install", "-q",
                "torch", "--index-url", "https://download.pytorch.org/whl/cu121",
            ])
            import torch
            device = "cuda" if torch.cuda.is_available() else "cpu"

    if device == "cuda":
        import torch
        gpu_name = torch.cuda.get_device_name(0)
        gpu_mem = torch.cuda.get_device_properties(0).total_memory / 1024**3
        print(f"[local] GPU: {gpu_name} ({gpu_mem:.0f}GB VRAM)")

    compute_type = "float16" if device == "cuda" else "int8"

    print(f"[local] Server: {server}")
    print(f"[local] Model:  {args.model} ({compute_type} on {device})")
    if device == "cpu":
        print(f"[local] WARNING: Running on CPU — this will be slow. Install CUDA for GPU acceleration.")
    print()

    # Single video mode
    if args.video:
        print(f"[local] Single video mode: {args.video}")
        print(f"[local] Loading Whisper {args.model} model ({compute_type})...")
        from faster_whisper import WhisperModel
        model = WhisperModel(args.model, device=device, compute_type=compute_type)
        print("[local] Model loaded.")
        print()

        start_time = time.time()
        segments = translate_video(model, args.video)
        elapsed = time.time() - start_time
        print(f"[local] Translated: {len(segments)} segments in {elapsed:.1f}s")
        print()
        for seg in segments:
            print(f"  [{seg['start']:6.1f}s - {seg['end']:6.1f}s] {seg['text']}")

        if not args.no_upload and token:
            print()
            result = upload_segments(server, token, args.video, 0, args.model, segments)
            print(f"[local] Uploaded: {result.get('action', 'ok')}")
        elif args.no_upload:
            print()
            print("[local] --no-upload: skipping upload")
        return

    print(f"[local] Season: {season} {year}")

    # Fetch anime
    print("[local] Fetching anime list from AniList...")
    anime = fetch_season_anime(season, year)
    print(f"[local] Found {len(anime)} total anime for {season} {year}")

    eligible = filter_eligible(anime)
    print(f"[local] {len(eligible)} eligible trailers")
    print()

    # Check server cache
    uncached = []
    for show in eligible:
        vid = show["trailer"]["id"]
        is_cached, cached_model = check_server_cache(server, vid, args.model)
        if is_cached:
            print(f"  [SKIP] {get_title(show)} ({vid}) — cached ({cached_model})")
        else:
            reason = f"upgrade from {cached_model}" if cached_model else "not cached"
            uncached.append((show, reason))

    print()
    print(f"[local] {len(uncached)} trailers need translation ({len(eligible) - len(uncached)} cached)")
    print()

    if args.dry_run:
        print("[local] DRY RUN — trailers that would be translated:")
        for show, reason in uncached:
            vid = show["trailer"]["id"]
            print(f"  {show['format']:10s} {get_title(show)} ({vid}) [{reason}]")
        return

    if not uncached:
        print("[local] All trailers already cached. Done!")
        return

    # Load model
    print(f"[local] Loading Whisper {args.model} model ({compute_type})...")
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    print("[local] Model loaded.")
    print()

    # Translate and upload
    translated = 0
    errors = 0
    for i, (show, reason) in enumerate(uncached):
        vid = show["trailer"]["id"]
        title = get_title(show)
        print(f"[{i + 1}/{len(uncached)}] {title} ({vid}) [{reason}]...")

        try:
            start_time = time.time()
            segments = translate_video(model, vid)
            elapsed = time.time() - start_time
            print(f"  Translated: {len(segments)} segments in {elapsed:.1f}s")

            # Upload to server
            result = upload_segments(server, token, vid, show["id"], args.model, segments)
            print(f"  Uploaded: {result.get('action', 'ok')}")
            translated += 1

        except Exception as e:
            print(f"  ERROR: {e}")
            errors += 1

    print()
    print(f"[local] Complete: {translated} translated, {errors} errors"
          + (f", {len(uncached) - translated - errors} remaining" if len(uncached) - translated - errors > 0 else ""))

    if log_file:
        log_file.close()


if __name__ == "__main__":
    main()
