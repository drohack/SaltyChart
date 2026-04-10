"""
Local GPU-accelerated subtitle translation for SaltyChart.

Translates anime trailers locally using Whisper large-v3 on your GPU,
then uploads results to your SaltyChart server.  Much faster and higher
quality than the server-side CPU translation.

Requirements:
  pip install faster-whisper yt-dlp easyocr sentence-transformers Pillow

  For GPU (recommended):
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126

Notes:
  - Medium and large models use full-audio transcription (no chunking) for
    better translation quality. Only the small model uses chunking.
  - Burned-in subtitle detection runs automatically after each translation.
    Compares OCR text from video frames to Whisper translations using hybrid
    fuzzy + semantic matching. Videos with burned-in subs are flagged so the
    frontend defaults subtitles to off.

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
  --force            Force re-translation even if cached
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
    """Download audio as WAV and extract video stream URL for frame grabs.
    Returns (audio_path, duration, video_url).  video_url is the direct URL
    to the highest-quality <=720p video stream (used by burned-in detection
    to avoid a redundant yt-dlp call)."""
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

    # Extract direct video URL for frame extraction (avoids second yt-dlp call)
    video_url = None
    formats = [
        f for f in info.get("formats", [])
        if f.get("vcodec", "none") != "none" and f.get("height", 0) <= 720
    ]
    if formats:
        formats.sort(key=lambda f: f.get("height", 0))
        video_url = formats[-1]["url"]

    return full_audio, duration, video_url


def generate_chunks(duration: float):
    """Generate chunk boundaries with ramp-up strategy.
    Only used for the small model (use_chunking=True). Medium/large skip chunking."""
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
    """Extract a single audio chunk via ffmpeg. Only used for small model chunking."""
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

def translate_video(model, video_id: str, use_chunking: bool = True):
    """Translate a video, return (segments, video_url).

    segments: list of {start, end, text} dicts.
    video_url: direct URL to <=720p video stream (for burned-in detection).

    use_chunking=False transcribes the full audio in one pass — better quality
    (Whisper has full context) but requires more memory. Recommended for medium
    and large models on GPU. The small model on the server should use chunking.
    """
    tmpdir = tempfile.mkdtemp()
    try:
        full_audio, duration, video_url = download_audio(video_id, tmpdir)

        if not use_chunking:
            # Full-audio pass — better translations due to full context
            segs, _ = model.transcribe(
                full_audio, language="ja", task="translate",
                vad_filter=True, beam_size=5,
                condition_on_previous_text=True,
            )
            segments = []
            for seg in segs:
                text = seg.text.strip()
                if text:
                    segments.append({
                        "start": round(seg.start, 2),
                        "end": round(seg.end, 2),
                        "text": text,
                    })
            return segments, video_url

        # Chunked pass — for small model / CPU / low memory
        from concurrent.futures import ThreadPoolExecutor, Future
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

        return segments, video_url
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Burned-in subtitle detection
# ---------------------------------------------------------------------------

_ocr_reader = None
_sem_model = None

def _get_ocr_reader():
    """Lazy-init singleton easyocr Reader (avoids reloading model per video)."""
    global _ocr_reader
    if _ocr_reader is None:
        import easyocr
        _ocr_reader = easyocr.Reader(["en"], gpu=True, verbose=False)
    return _ocr_reader


def _get_sem_model():
    """Lazy-init singleton sentence-transformers model for semantic matching."""
    global _sem_model
    if _sem_model is None:
        from sentence_transformers import SentenceTransformer
        _sem_model = SentenceTransformer("all-MiniLM-L6-v2")
    return _sem_model


def _normalize(text: str) -> str:
    """Lowercase, strip punctuation, collapse whitespace for fuzzy comparison."""
    import re
    return re.sub(r"[^a-z0-9 ]", "", text.lower()).strip()


def _clean_ocr(text: str) -> str:
    """Fix common OCR misreads and remove garbage fragments."""
    # Common character substitutions
    text = text.replace("0", "o").replace("1l", "ll").replace(" l ", " I ")
    # Remove short garbage tokens (1-2 chars that aren't real English words)
    real_short = {"i", "a", "to", "is", "it", "in", "on", "no", "do", "my", "me",
                  "we", "he", "so", "or", "an", "at", "if", "up", "am", "be", "go"}
    words = text.split()
    cleaned = [w for w in words if len(w) > 2 or w.lower() in real_short]
    return " ".join(cleaned)


def _fuzzy_match(ocr_text: str, whisper_text: str) -> float:
    """Return similarity ratio (0-1) between OCR and Whisper text."""
    from difflib import SequenceMatcher
    a = _normalize(ocr_text)
    b = _normalize(whisper_text)
    if not a or not b:
        return 0.0
    return SequenceMatcher(None, a, b).ratio()


def _semantic_match(ocr_text: str, whisper_text: str) -> float:
    """Return cosine similarity (0-1) of sentence embeddings."""
    from sentence_transformers import util as stu
    if not ocr_text or not whisper_text:
        return 0.0
    model = _get_sem_model()
    emb = model.encode([ocr_text, whisper_text])
    return max(0.0, float(stu.cos_sim(emb[0], emb[1])))


def detect_burned_in_subs(video_id: str, segments: list, video_url: str = None) -> bool:
    """Detect burned-in English subtitles by comparing OCR text (easyocr) from
    video frames to Whisper's translations using hybrid fuzzy string + semantic
    similarity matching.  Samples up to 7 frames at speech timestamps, crops
    the bottom 25%, and flags the video if 2+ distinct subtitle lines match.

    video_url: direct URL to <=720p video stream (from download_audio).
               If not provided, fetches it via yt-dlp (slower).
    """
    from PIL import Image

    if not segments:
        return False

    # Generate candidate timestamps: midpoint of short segments, and evenly
    # spaced points through long ones. Also sample near segment boundaries
    # where subtitle text is most likely visible.
    candidates = set()
    for seg in segments:
        dur = seg["end"] - seg["start"]
        if dur > 10:
            # Sample every ~4s through long segments
            steps = max(3, int(dur / 4))
            for i in range(1, steps):
                candidates.add(round(seg["start"] + dur * i / steps, 1))
        else:
            candidates.add(round((seg["start"] + seg["end"]) / 2, 1))
        # Also sample 1s before the end (subs often linger at segment end)
        if dur > 3:
            candidates.add(round(seg["end"] - 1, 1))

    # Pick up to 7 timestamps, at least 2s apart.
    chosen = []
    for t in sorted(candidates):
        if all(abs(t - c["mid"]) > 2 for c in chosen):
            chosen.append({"mid": t})
        if len(chosen) >= 7:
            break
    if not chosen:
        chosen = [{"mid": (segments[0]["start"] + segments[0]["end"]) / 2}]

    print(f"[local] Checking for burned-in subs at {[f'{c['mid']:.1f}s' for c in chosen]}...")

    # Get direct video URL if not already provided (avoids redundant yt-dlp call)
    if not video_url:
        try:
            import yt_dlp
            with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}) as ydl:
                info = ydl.extract_info(
                    f"https://www.youtube.com/watch?v={video_id}", download=False
                )
                formats = [
                    f for f in info["formats"]
                    if f.get("vcodec", "none") != "none" and f.get("height", 0) <= 720
                ]
                formats.sort(key=lambda f: f.get("height", 0))
                if not formats:
                    print("[local] No suitable video format for burned-in check")
                    return False
                video_url = formats[-1]["url"]
        except Exception as e:
            print(f"[local] Could not get video URL for burned-in check: {e}")
            return False

    # Extract frames in parallel (ffmpeg is I/O bound, threading works well)
    tmpdir = tempfile.mkdtemp()
    try:
        from concurrent.futures import ThreadPoolExecutor

        def _grab_frame(i, ts):
            out = os.path.join(tmpdir, f"frame_{i}.jpg")
            kwargs = dict(
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL, check=True, timeout=30,
            )
            if sys.platform == "win32":
                kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
            subprocess.run(
                ["ffmpeg", "-y", "-ss", str(ts), "-i", video_url,
                 "-frames:v", "1", "-q:v", "2", out], **kwargs)
            return out

        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(_grab_frame, i, c["mid"]) for i, c in enumerate(chosen)]
            frame_paths = [f.result() for f in futures]

        reader = _get_ocr_reader()

        matches = 0
        matched_texts = []  # track matched OCR text to avoid counting the same line twice
        for i, path in enumerate(frame_paths):
            img = Image.open(path)
            w, h = img.size
            cropped = img.crop((0, int(h * 0.75), w, h))
            cropped_path = os.path.join(tmpdir, f"crop_{i}.jpg")
            cropped.save(cropped_path)

            results = reader.readtext(cropped_path)
            ocr_raw = " ".join(text for (_, text, conf) in results if conf > 0.3)
            ocr_text = _clean_ocr(ocr_raw)

            # Compare OCR text against ALL full-audio whisper segments
            best_fz, best_sem = 0.0, 0.0
            for seg in segments:
                fz = _fuzzy_match(ocr_text, seg["text"])
                sem = _semantic_match(ocr_text, seg["text"])
                if max(fz, sem) > max(best_fz, best_sem):
                    best_fz, best_sem = fz, sem
            score = max(best_fz, best_sem)

            if score >= 0.40:
                # Skip if this OCR text is too similar to an already-matched line
                is_duplicate = any(_fuzzy_match(ocr_text, prev) > 0.6 for prev in matched_texts)
                if is_duplicate:
                    print(f"  Frame {i} ({chosen[i]['mid']:.1f}s): DUPE  (fz={best_fz:.0%} sem={best_sem:.0%}) ocr=\"{ocr_text}\"")
                    continue
                matches += 1
                matched_texts.append(ocr_text)
                print(f"  Frame {i} ({chosen[i]['mid']:.1f}s): MATCH (fz={best_fz:.0%} sem={best_sem:.0%}) ocr=\"{ocr_text}\"")
                if matches >= 2:
                    print(f"[local] Burned-in subs: yes ({matches}/{len(chosen)} frames, early exit)")
                    return True
            else:
                print(f"  Frame {i} ({chosen[i]['mid']:.1f}s): no match (fz={best_fz:.0%} sem={best_sem:.0%})")

        result = matches >= 2
        print(f"[local] Burned-in subs: {'yes' if result else 'no'} ({matches}/{len(chosen)} frames)")
        return result
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


def upload_segments(server: str, token: str, video_id: str, media_id: int, model_name: str, segments: list, has_burned_in: bool = False, force: bool = False) -> dict:
    """Upload translated segments to the server."""
    body = json.dumps({
        "videoId": video_id,
        "mediaId": media_id,
        "modelName": model_name,
        "segments": segments,
        "hasBurnedInSubs": has_burned_in,
        "force": force,
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
    parser.add_argument("--force", action="store_true", help="Force re-translation even if cached")
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
                "torch", "--index-url", "https://download.pytorch.org/whl/cu126",
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
        use_chunking = args.model == "small"
        segments, video_url = translate_video(model, args.video, use_chunking=use_chunking)
        elapsed = time.time() - start_time
        print(f"[local] Translated: {len(segments)} segments in {elapsed:.1f}s")
        print()
        for seg in segments:
            print(f"  [{seg['start']:6.1f}s - {seg['end']:6.1f}s] {seg['text']}")

        # Check for burned-in subtitles
        has_burned_in = False
        if segments:
            try:
                has_burned_in = detect_burned_in_subs(args.video, segments, video_url=video_url)
            except Exception as e:
                print(f"[local] Burned-in detection failed: {e}")

        if not args.no_upload and token:
            print()
            result = upload_segments(server, token, args.video, 0, args.model, segments, has_burned_in, args.force)
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
        if args.force:
            uncached.append((show, "forced"))
        else:
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
    use_chunking = args.model == "small"
    for i, (show, reason) in enumerate(uncached):
        vid = show["trailer"]["id"]
        title = get_title(show)
        print(f"[{i + 1}/{len(uncached)}] {title} ({vid}) [{reason}]...")

        try:
            start_time = time.time()
            segments, video_url = translate_video(model, vid, use_chunking=use_chunking)
            elapsed = time.time() - start_time
            print(f"  Translated: {len(segments)} segments in {elapsed:.1f}s")

            # Check for burned-in subtitles
            has_burned_in = False
            if segments:
                try:
                    has_burned_in = detect_burned_in_subs(vid, segments, video_url=video_url)
                except Exception as e:
                    print(f"  Burned-in detection failed: {e}")

            # Upload to server
            result = upload_segments(server, token, vid, show["id"], args.model, segments, has_burned_in, args.force)
            print(f"  Uploaded: {result.get('action', 'ok')}")
            translated += 1

        except Exception as e:
            print(f"  ERROR: {e}")
            errors += 1

    print()
    print(f"[local] Complete: {translated} translated, {errors} errors"
          + (f", {len(uncached) - translated - errors} remaining" if len(uncached) - translated - errors > 0 else ""))

    if log_file:
        log_file.write(f"\nRun ended: {datetime.now().isoformat()}\n")
        log_file.close()


if __name__ == "__main__":
    main()
