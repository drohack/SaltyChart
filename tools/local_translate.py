"""
Local GPU-accelerated subtitle translation for SaltyChart.

Translates anime trailers locally using Whisper large-v3 on your GPU,
then uploads results to your SaltyChart server.  Much faster and higher
quality than the server-side CPU translation.

Requirements:
  pip install faster-whisper yt-dlp easyocr sentence-transformers Pillow demucs
  Ollama installed + `ollama pull qwen3.5:9b`  (split-pipeline translator; it's the
  Ollama vision build, so its ~1.2 GB vision encoder sits unused in RAM, but it
  benchmarks clearly better than text-only qwen3:8b — see CLAUDE.md)

  For GPU (recommended):
    pip install torch torchvision --index-url https://download.pytorch.org/whl/cu126
  Do NOT install torchcodec — torchaudio routes through it and it breaks
  faster-whisper's decoder; audio I/O here uses the ffmpeg binary instead.

Pipeline (the champion config from the bake-off — see CLAUDE.md):
  bestaudio -> Demucs vocal separation -> large-v3 transcribe(ja, beam10 +
  rep_penalty1.2 + vad_min300) -> qwen3.5:9b translate (via Ollama). Uploaded as
  modelName 'large-v3-split' (rank 6, above plain 'large-v3'). The script starts
  Ollama if it isn't running and stops it (+ unloads the model) when done.
  --legacy-translate forces the old end-to-end Whisper translate (tagged
  'large-v3'); the same fallback runs automatically if Ollama is unavailable.

Notes:
  - Only the full-audio (large) path uses the split pipeline; the small model
    keeps the legacy chunked end-to-end translate.
  - Burned-in subtitle detection runs automatically after each translation.
    Compares OCR text (easyocr on CPU) from video frames to the translated
    segments using hybrid fuzzy + semantic matching. Videos with burned-in subs
    are flagged so the frontend defaults subtitles to off.

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
  --within-days N    Exit if next season is more than N days away (not used
                     in translate.bat — runs always, covering 3 seasons)
  --legacy-translate Use old end-to-end Whisper translate (skip Demucs + Qwen)
  --translate-model  Ollama model for the split translator (default: qwen3.5:9b)
  --ollama-host      Ollama server URL (default: http://127.0.0.1:11434)
  --keep-ollama      Leave Ollama running after the run (default: stop it)

Windows wrapper: tools/translate.bat (uses py -3.13)
"""

import argparse
import gc
import json
import os
import subprocess
import sys
import tempfile
import shutil
import time
import urllib.request
from datetime import datetime

# Swappable pipeline stages (Demucs vocal separation, Ollama qwen3.5 translation)
# shared with the bake-off harness. Sits next to this file in tools/.
import bench_pipeline as bp


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
    """Local translate runs on the user's stronger PC, so we translate ALL
    anime with YouTube trailers — including movies, sequels, TV_SHORT, and 18+.
    The server's batch script still filters to the narrower set."""
    eligible = []
    for show in anime_list:
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


def get_seasons_to_process() -> list:
    """Return [(season, year), ...] covering prev, current-displayed, and next season.

    The app defaults to showing the upcoming season 76 days before it starts,
    so users browse 3 seasons of content. This ensures all of them are cached.
    """
    current, year = next_season_info()
    idx = SEASONS.index(current)

    prev_idx = (idx - 1) % 4
    prev_year = year - (1 if prev_idx == 3 else 0)   # WINTER→FALL wraps back a year

    next_idx = (idx + 1) % 4
    next_year = year + (1 if next_idx == 0 else 0)   # FALL→WINTER wraps forward a year

    return [
        (SEASONS[prev_idx], prev_year),
        (current, year),
        (SEASONS[next_idx], next_year),
    ]


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

# YouTube auth (set from the CLI in main). Bulk downloads trip YouTube's "Sign in
# to confirm you're not a bot" wall; yt-dlp needs cookies to get past it.
_COOKIES_FROM_BROWSER = None   # e.g. "edge", "chrome", "firefox"
_COOKIES_FILE = None           # path to a Netscape cookies.txt


def _cookie_opts():
    """yt-dlp options for YouTube auth, per the CLI flags (empty if none set)."""
    opts = {}
    if _COOKIES_FROM_BROWSER:
        opts["cookiesfrombrowser"] = (_COOKIES_FROM_BROWSER,)
    if _COOKIES_FILE:
        opts["cookiefile"] = _COOKIES_FILE
    return opts


class BotBlockError(Exception):
    """YouTube returned a 'confirm you're not a bot' challenge. Raised so the run
    aborts immediately instead of hammering YouTube with the remaining downloads
    (which only deepens the block)."""


def _is_bot_block(msg: str) -> bool:
    m = (msg or "").lower()
    return ("confirm you" in m and "not a bot" in m) or "sign in to confirm" in m


def download_audio(video_id: str, tmpdir: str):
    """Download audio as WAV and extract video stream URL for frame grabs.
    Returns (audio_path, duration, video_url).  video_url is the direct URL
    to the highest-quality <=720p video stream (used by burned-in detection
    to avoid a redundant yt-dlp call)."""
    import yt_dlp

    full_audio = os.path.join(tmpdir, "full.wav")
    ydl_opts = {
        # bestaudio: Demucs vocal separation needs full-band audio (separating
        # low-quality audio hurt in benchmarking). Whisper resamples to 16 kHz
        # regardless, so there's no downside for the transcription step.
        "format": "bestaudio",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
        "outtmpl": os.path.join(tmpdir, "full.%(ext)s"),
        # ~1.5s between the metadata/API calls yt-dlp makes per video (yt-dlp's
        # own recommended anti-rate-limit setting); the between-trailer gap is
        # handled by --download-delay in the serial Phase-1 loop.
        "sleep_interval_requests": 1.5,
        **_cookie_opts(),
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
    kwargs = dict(
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        check=True, timeout=30,
    )
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    subprocess.run(cmd, **kwargs)
    if not os.path.exists(chunk_path) or os.path.getsize(chunk_path) == 0:
        raise RuntimeError(f"ffmpeg chunk extraction failed: {chunk_path}")
    return chunk_path


# ---------------------------------------------------------------------------
# Translation
# ---------------------------------------------------------------------------

def _whisper_segments(segs_gen, offset: float = 0.0):
    """faster-whisper segment generator → [{start, end, text}], using word-level
    start/end (eliminates pre-speech lead-in). offset shifts a chunk into global time."""
    out = []
    for seg in segs_gen:
        text = seg.text.strip()
        if not text:
            continue
        w = seg.words
        out.append({
            "start": round((w[0].start if w else seg.start) + offset, 2),
            "end":   round((w[-1].end  if w else seg.end)   + offset, 2),
            "text": text,
        })
    return out


def translate_video(model, video_id: str, use_chunking: bool = True, *,
                    title: str = None, split: bool = True,
                    translate_model: str = "qwen3.5:9b",
                    ollama_host: str = "http://127.0.0.1:11434",
                    ollama_ready: bool = False):
    """Translate a video → (segments, video_url, used_split).

    Champion split pipeline (split=True, full-audio): Demucs vocal separation →
    large-v3 transcribe(ja, beam10+rep_penalty1.2+vad_min300) → qwen3.5 translate.
    Falls back to end-to-end Whisper translate (on the separated vocals) if Ollama
    isn't ready or anything fails. `used_split` tells the caller which modelName
    tag to upload (large-v3-split vs large-v3).

    use_chunking=True (small model / CPU) keeps the legacy chunked e2e-translate
    path unchanged.
    """
    tmpdir = tempfile.mkdtemp()
    try:
        full_audio, duration, video_url = download_audio(video_id, tmpdir)

        if not use_chunking and split:
            # --- Champion split pipeline ---
            audio_for_asr = full_audio
            try:
                audio_for_asr = bp.separate_vocals(full_audio)
            except Exception as e:
                print(f"  [warn] vocal separation failed ({e}); using raw audio")
            finally:
                bp.release_demucs()  # free Demucs VRAM before ASR + translate

            if ollama_ready:
                try:
                    segs, _ = model.transcribe(
                        audio_for_asr, language="ja", task="transcribe",
                        beam_size=10, repetition_penalty=1.2,
                        vad_filter=True, vad_parameters={"min_speech_duration_ms": 300},
                        condition_on_previous_text=True, word_timestamps=True,
                    )
                    ja = _whisper_segments(segs)
                    en = bp.translate_ollama_qwen(
                        ja, model=translate_model, host=ollama_host,
                        context=title, keep_alive=0)
                    return en, video_url, True
                except Exception as e:
                    print(f"  [warn] split translate failed ({e}); falling back to Whisper translate")

            # Fallback: end-to-end Whisper translate on the separated vocals
            segs, _ = model.transcribe(
                audio_for_asr, language="ja", task="translate",
                vad_filter=True, beam_size=10,
                condition_on_previous_text=True, word_timestamps=True,
            )
            return _whisper_segments(segs), video_url, False

        if not use_chunking:
            # Legacy full-audio e2e translate (--legacy-translate) on raw audio
            segs, _ = model.transcribe(
                full_audio, language="ja", task="translate",
                vad_filter=True, beam_size=10,
                condition_on_previous_text=True, word_timestamps=True,
            )
            return _whisper_segments(segs), video_url, False

        # Chunked pass — for small model / CPU / low memory (legacy e2e translate)
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
                        word_timestamps=True,
                    )
                    segments.extend(_whisper_segments(segs, offset=chunk_start))
                finally:
                    if os.path.exists(chunk_path):
                        os.unlink(chunk_path)

        return segments, video_url, False
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


# ---------------------------------------------------------------------------
# Phased split-pipeline stages (one model resident at a time — fits 10 GB)
# ---------------------------------------------------------------------------

def _download_audio_to_tmp(video_id: str):
    """Phase-1a unit (parallelizable): download bestaudio into a fresh tmpdir.
    Pure network I/O — safe to run in parallel threads. Demucs separation runs
    later in phase 1b (GPU, sequential). Returns (tmpdir, full_audio, video_url)."""
    tmpdir = tempfile.mkdtemp()
    full_audio, _duration, video_url = download_audio(video_id, tmpdir)
    return tmpdir, full_audio, video_url


def _transcribe_jp(model, audio_path: str):
    """Phase-2 unit: large-v3 Japanese transcription with champion decode params."""
    segs, _ = model.transcribe(
        audio_path, language="ja", task="transcribe",
        beam_size=10, repetition_penalty=1.2,
        vad_filter=True, vad_parameters={"min_speech_duration_ms": 300},
        condition_on_previous_text=True, word_timestamps=True,
    )
    return _whisper_segments(segs)


# ---------------------------------------------------------------------------
# Burned-in subtitle detection
# ---------------------------------------------------------------------------

_ocr_reader = None
_sem_model = None

def _get_ocr_reader():
    """Lazy-init singleton easyocr Reader (avoids reloading model per video).
    Runs on GPU: the phased run keeps peak VRAM ~6.4 GB, so the ~1 GB OCR model
    fits comfortably (phase-3 total ~7.4 GB), and keeping OCR off the CPU avoids
    adding system-RAM / CPU load."""
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

# large-v3-split (rank 6) = the champion pipeline (Demucs vocals + large-v3
# transcribe + qwen3.5 translate). Outranks plain large-v3 (the e2e fallback /
# legacy path) so existing large-v3 subs auto-upgrade. Keep in sync with the
# server's MODEL_RANK in backend/src/routes/translate.ts.
MODEL_RANK = {"tiny": 0, "base": 1, "small": 2, "medium": 3, "large-v2": 4,
              "large-v3": 5, "large-v3-split": 6}


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
# Ollama lifecycle — start the server if needed, unload model + stop when done
# ---------------------------------------------------------------------------

def _ollama_up(host: str) -> bool:
    try:
        with urllib.request.urlopen(f"{host}/api/version", timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def _ollama_has_model(host: str, model: str) -> bool:
    try:
        with urllib.request.urlopen(f"{host}/api/tags", timeout=5) as r:
            data = json.loads(r.read().decode())
        return any(m.get("name") == model for m in data.get("models", []))
    except Exception:
        return False


def ensure_ollama_running(host: str, model: str):
    """Ensure Ollama is serving and `model` is present; start `ollama serve` if
    it's down. Returns (ready, proc): ready=False → caller falls back to Whisper
    translate; proc is the serve process if we started it (so we can stop it)."""
    proc = None
    if not _ollama_up(host):
        if not shutil.which("ollama"):
            print("[local] Ollama not installed — using Whisper translate.")
            return False, None
        print("[local] Starting Ollama server...")
        kwargs = dict(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            proc = subprocess.Popen(["ollama", "serve"], **kwargs)
        except Exception as e:
            print(f"[local] Could not start Ollama ({e}) — using Whisper translate.")
            return False, None
        for _ in range(30):
            if _ollama_up(host):
                break
            time.sleep(1)
        else:
            print("[local] Ollama did not start in time — using Whisper translate.")
            return False, proc
    if not _ollama_has_model(host, model):
        print(f"[local] Ollama model '{model}' not found (try: ollama pull {model}) — using Whisper translate.")
        return False, proc
    print(f"[local] Ollama ready ({model}).")
    return True, proc


def unload_ollama_model(host: str, model: str):
    """Unload a model from VRAM but leave the server running (so it can reload
    cheaply later). Used between seasons so a still-warm translator doesn't
    co-reside with the next season's Demucs/Whisper."""
    if shutil.which("ollama") and _ollama_up(host):
        kwargs = dict(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            subprocess.run(["ollama", "stop", model], **kwargs)
        except Exception:
            pass


def shutdown_ollama(host: str, model: str, proc, keep: bool = False):
    """Unload the model (free VRAM) and stop the serve process if we started it,
    so the system is left clean."""
    if keep:
        return
    if shutil.which("ollama") and _ollama_up(host):
        kwargs = dict(stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20)
        if sys.platform == "win32":
            kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
        try:
            subprocess.run(["ollama", "stop", model], **kwargs)
        except Exception:
            pass
    if proc is not None:
        try:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except Exception:
                proc.kill()
            print("[local] Stopped Ollama server.")
        except Exception:
            pass


# ---------------------------------------------------------------------------
# VRAM monitor (diagnostic) — samples total GPU memory and interleaves it with
# the phase log so a peak can be attributed to Demucs / Whisper / translate.
# ---------------------------------------------------------------------------

def _vram_used_mb():
    """Total GPU memory in use (MB) via nvidia-smi, or -1 if unavailable.
    Uses nvidia-smi (not torch) so it captures ctranslate2 + Ollama + Demucs too."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=5)
        return int(out.stdout.strip().splitlines()[0])
    except Exception:
        return -1


def start_vram_monitor(interval=0.5):
    """Spawn a daemon thread that prints `[vram +Ns] used=X peak=Y` every
    `interval`s. Returns (stop_event, peak_dict) — set the event to stop."""
    import threading
    stop = threading.Event()
    peak = {"v": 0}
    t0 = time.time()

    def loop():
        while not stop.is_set():
            mb = _vram_used_mb()
            if mb > peak["v"]:
                peak["v"] = mb
            print(f"[vram +{time.time() - t0:5.1f}s] used={mb}MB peak={peak['v']}MB", flush=True)
            stop.wait(interval)

    threading.Thread(target=loop, daemon=True).start()
    return stop, peak


# ---------------------------------------------------------------------------
# Phased split run — separate-all -> transcribe-all -> translate-all
# ---------------------------------------------------------------------------

def run_phased(items, server, token, args, device, compute_type, verbose=False, prefix=""):
    """Run the split pipeline over `items` in three phases so only one model is
    GPU-resident at a time (peak ~6.2 GB vs ~9.8 GB per-video) and each model
    loads once. `items`: list of {vid, title, media_id}. `prefix` (e.g.
    "SUMMER 2026 (2/3)") is prepended to every progress line so the status bar
    shows overall position + current step. Returns (translated, errors)."""
    n = len(items)
    head = f"{prefix} " if prefix else ""

    def tag(step, k, total):
        """Self-contained progress label: [<season pos> | <step> k/total]."""
        return f"[{prefix + ' | ' if prefix else ''}{step} {k}/{total}]"

    # Phase 1: download SERIALLY with a delay between trailers (never parallel —
    # bursty parallel downloads are what trip YouTube's bot-detection), then
    # Demucs-separate sequentially (GPU, loaded once). One season at a time.
    delay = max(0.0, getattr(args, "download_delay", 5.0) or 0.0)
    print(f"[local] {head}Phase 1/3: download (serial, ~{delay:.0f}s apart) + separate ({n} trailer(s))...")
    prepared, errors = [], 0

    downloaded = {}
    for i, it in enumerate(items):
        label = it["title"] or it["vid"]
        if i > 0 and delay:
            time.sleep(delay)
        try:
            downloaded[i] = _download_audio_to_tmp(it["vid"])
            print(f"  {tag('download', i + 1, n)} {label}")
        except Exception as e:
            msg = str(e)
            print(f"  {tag('download', i + 1, n)} {label}: DOWNLOAD ERROR: {msg[:120]}")
            errors += 1
            if _is_bot_block(msg):
                # Stop NOW rather than hammering YouTube with the rest (which only
                # deepens the block). Bubbles up to abort the whole run.
                raise BotBlockError(
                    "YouTube is challenging downloads ('not a bot'). Aborted before "
                    "the remaining trailers. Wait for a cool-down, then re-run with "
                    "--cookies <cookies.txt>.")

    sep_total, sep_done = len(downloaded), 0
    for idx, it in enumerate(items):          # separate in stable item order
        if idx not in downloaded:
            continue
        tmpdir, full_audio, url = downloaded[idx]
        label = it["title"] or it["vid"]
        audio = full_audio
        try:
            audio = bp.separate_vocals(full_audio)
        except Exception as e:
            print(f"  {label}: vocal separation failed ({e}); using raw audio")
        prepared.append({**it, "tmpdir": tmpdir, "audio": audio, "url": url, "ja": None})
        sep_done += 1
        print(f"  {tag('separate', sep_done, sep_total)} {label}")
    bp.release_demucs()
    if not prepared:
        return 0, errors

    # Phase 2: transcribe (Whisper loaded once, then freed to reclaim VRAM).
    np = len(prepared)
    print(f"[local] {head}Phase 2/3: transcribe ({args.model}) — {np} trailer(s)...")
    from faster_whisper import WhisperModel
    model = WhisperModel(args.model, device=device, compute_type=compute_type)
    for i, p in enumerate(prepared, 1):
        label = p["title"] or p["vid"]
        try:
            p["ja"] = _transcribe_jp(model, p["audio"])
            print(f"  {tag('transcribe', i, np)} {label}: {len(p['ja'])} JP segs")
        except Exception as e:
            print(f"  {tag('transcribe', i, np)} {label}: TRANSCRIBE ERROR: {e}")
    del model
    gc.collect()
    if device == "cuda":
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass

    # Phase 3: translate + burned-in + upload (qwen3.5 stays warm — no reload).
    print(f"[local] {head}Phase 3/3: translate ({args.translate_model}) + upload — {np} trailer(s)...")
    translated = 0
    for i, p in enumerate(prepared, 1):
        label = p["title"] or p["vid"]
        try:
            if p["ja"] is None:
                errors += 1
                continue
            en = bp.translate_ollama_qwen(p["ja"], model=args.translate_model,
                                          host=args.ollama_host, context=p["title"])
            has_burned_in = False
            if en:
                try:
                    has_burned_in = detect_burned_in_subs(p["vid"], en, video_url=p["url"])
                except Exception as e:
                    print(f"  {tag('translate', i, np)} {label}: burned-in failed: {e}")
            if verbose:
                for s in en:
                    print(f"    [{s['start']:6.1f}s - {s['end']:6.1f}s] {s['text']}")
            if not args.no_upload and token:
                result = upload_segments(server, token, p["vid"], p.get("media_id", 0),
                                         "large-v3-split", en, has_burned_in, args.force)
                print(f"  {tag('translate', i, np)} {label}: {len(en)} segs -> {result.get('action', 'ok')}")
            else:
                print(f"  {tag('translate', i, np)} {label}: {len(en)} segs (no upload)")
            translated += 1
        except Exception as e:
            print(f"  {tag('translate', i, np)} {label}: TRANSLATE ERROR: {e}")
            errors += 1
        finally:
            shutil.rmtree(p["tmpdir"], ignore_errors=True)

    # Free the translator's VRAM before returning so the NEXT season's Demucs +
    # Whisper don't stack on top of a still-warm qwen3.5 — that cross-season
    # co-residence (qwen ~7 GB + large-v3 ~3 GB) is what pushed peak VRAM to
    # ~9.6 GB. qwen reloads at the next season's Phase 3 (one quick reload/season).
    unload_ollama_model(args.ollama_host, args.translate_model)

    return translated, errors


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    # Ensure stdout uses UTF-8 so show titles with non-cp1252 chars don't crash on Windows
    import sys as _sys
    if hasattr(_sys.stdout, 'reconfigure'):
        _sys.stdout.reconfigure(encoding='utf-8', errors='replace')

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
    parser.add_argument("--legacy-translate", action="store_true",
                        help="Use the old end-to-end Whisper translate (skip Demucs + Qwen split); tags subs 'large-v3'")
    parser.add_argument("--translate-model", type=str, default="qwen3.5:9b",
                        help="Ollama model for the split-pipeline translation step "
                             "(default: qwen3.5:9b — benchmarked better than qwen3:8b; "
                             "it's a vision build so ~1.2 GB of vision weights sit unused "
                             "in RAM, but the LLM runs on GPU)")
    parser.add_argument("--ollama-host", type=str, default="http://127.0.0.1:11434",
                        help="Ollama server URL (default: http://127.0.0.1:11434)")
    parser.add_argument("--keep-ollama", action="store_true",
                        help="Leave Ollama running after the run (default: unload model + stop if we started it)")
    parser.add_argument("--limit", type=int, default=None, metavar="N",
                        help="Cap the number of trailers translated per season (for testing)")
    parser.add_argument("--vram-log", action="store_true",
                        help="Sample total GPU VRAM every 0.5s and interleave it with the "
                             "phase log (diagnostic for peak-usage attribution)")
    parser.add_argument("--download-delay", type=float, default=5.0, metavar="SECONDS",
                        help="Seconds between trailer downloads (default: 5). Downloads "
                             "are always serial — bursty parallel downloads trip YouTube "
                             "bot-detection. Raise it if you still get challenged.")
    parser.add_argument("--download-workers", type=int, default=1, metavar="N",
                        help=argparse.SUPPRESS)  # deprecated/ignored: downloads are serial now
    parser.add_argument("--cookies-from-browser", type=str, default=None, metavar="BROWSER",
                        help="Pass YouTube cookies from a browser (edge/chrome/firefox) to "
                             "yt-dlp to get past bot-detection. The browser may need to be "
                             "closed for yt-dlp to read its cookie DB on Windows.")
    parser.add_argument("--cookies", type=str, default=None, metavar="FILE",
                        help="Path to a Netscape cookies.txt for yt-dlp (alternative to "
                             "--cookies-from-browser)")
    args = parser.parse_args()

    # Apply YouTube auth globally (read by download_audio's yt-dlp opts).
    global _COOKIES_FROM_BROWSER, _COOKIES_FILE
    _COOKIES_FROM_BROWSER = args.cookies_from_browser
    _COOKIES_FILE = args.cookies

    # --- File logging ---
    log_file = None
    if args.log:
        log_path = args.log
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        # Rotate when the log exceeds 5 MB — keeps current + one .old archive.
        if os.path.exists(log_path) and os.path.getsize(log_path) > 5 * 1024 * 1024:
            os.replace(log_path, log_path + '.old')
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

    # Determine seasons to process
    if args.season and args.year:
        seasons_to_process = [(args.season.upper(), args.year)]
    else:
        seasons_to_process = get_seasons_to_process()

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

    # Champion split pipeline (Demucs vocals -> transcribe -> qwen3.5) is the
    # default for the full-audio (large) path; the small model keeps the legacy
    # chunked e2e translate. --legacy-translate forces the old e2e path.
    split_enabled = (not args.legacy_translate) and (args.model != "small")
    target_tag = "large-v3-split" if split_enabled else args.model
    print(f"[local] Pipeline: {'split (Demucs + transcribe + ' + args.translate_model + ')' if split_enabled else 'legacy e2e translate'}")

    # Start Ollama if needed (only when we'll actually translate via the split).
    ollama_ready, ollama_proc = False, None
    if split_enabled and not args.dry_run:
        ollama_ready, ollama_proc = ensure_ollama_running(args.ollama_host, args.translate_model)

    # Optional VRAM diagnostic — runs for the whole job; prints a final PEAK line.
    if getattr(args, "vram_log", False):
        import atexit
        _vstop, _vpeak = start_vram_monitor()
        atexit.register(lambda: (_vstop.set(),
                                 print(f"[vram] PEAK = {_vpeak['v']}MB", flush=True)))
    print()

    # Single video mode
    if args.video:
        print(f"[local] Single video mode: {args.video}")
        if split_enabled and ollama_ready:
            run_phased([{"vid": args.video, "title": None, "media_id": 0}],
                       server, token, args, device, compute_type, verbose=True)
        else:
            # Legacy / fallback: single-pass e2e translate (Whisper only)
            print(f"[local] Loading Whisper {args.model} model ({compute_type})...")
            from faster_whisper import WhisperModel
            model = WhisperModel(args.model, device=device, compute_type=compute_type)
            use_chunking = args.model == "small"
            segments, video_url, used_split = translate_video(
                model, args.video, use_chunking=use_chunking, title=None,
                split=split_enabled, translate_model=args.translate_model,
                ollama_host=args.ollama_host, ollama_ready=ollama_ready)
            model_name = "large-v3-split" if used_split else args.model
            print(f"[local] Translated: {len(segments)} segments [{model_name}]")
            for seg in segments:
                print(f"  [{seg['start']:6.1f}s - {seg['end']:6.1f}s] {seg['text']}")
            has_burned_in = False
            if segments:
                try:
                    has_burned_in = detect_burned_in_subs(args.video, segments, video_url=video_url)
                except Exception as e:
                    print(f"[local] Burned-in detection failed: {e}")
            if not args.no_upload and token:
                result = upload_segments(server, token, args.video, 0, model_name, segments, has_burned_in, args.force)
                print(f"[local] Uploaded: {result.get('action', 'ok')}")
            elif args.no_upload:
                print("[local] --no-upload: skipping upload")
        shutdown_ollama(args.ollama_host, args.translate_model, ollama_proc, keep=args.keep_ollama)
        return

    print(f"[local] Seasons: {', '.join(f'{s} {y}' for s, y in seasons_to_process)}")
    print()

    # Model loaded lazily on first translation need, then reused across seasons
    model = None
    use_chunking = args.model == "small"

    ns = len(seasons_to_process)
    for si, (season, year) in enumerate(seasons_to_process, 1):
        print(f"[local] === SEASON {si}/{ns}: {season} {year} {'=' * 40}")

        # Fetch anime
        print("[local] Fetching anime list from AniList...")
        anime = fetch_season_anime(season, year)
        print(f"[local] Found {len(anime)} total anime for {season} {year}")

        eligible = filter_eligible(anime)
        print(f"[local] {len(eligible)} eligible trailers")
        print()

        if not eligible:
            print(f"[local] Nothing to translate for {season} {year}.")
            print()
            continue

        # Check server cache
        uncached = []
        for show in eligible:
            vid = show["trailer"]["id"]
            if args.force:
                uncached.append((show, "forced"))
            else:
                is_cached, cached_model = check_server_cache(server, vid, target_tag)
                if is_cached:
                    print(f"  [SKIP] {get_title(show)} ({vid}) — cached ({cached_model})")
                else:
                    reason = f"upgrade from {cached_model}" if cached_model else "not cached"
                    uncached.append((show, reason))

        if args.limit and len(uncached) > args.limit:
            uncached = uncached[:args.limit]
            print(f"[local] --limit {args.limit}: capping to {len(uncached)} trailer(s)")

        print()
        print(f"[local] {len(uncached)} trailers need translation ({len(eligible) - len(uncached)} cached)")
        print()

        if args.dry_run:
            print(f"[local] DRY RUN — {season} {year} trailers that would be translated:")
            for show, reason in uncached:
                vid = show["trailer"]["id"]
                print(f"  {show['format']:10s} {get_title(show)} ({vid}) [{reason}]")
            print()
            continue

        if not uncached:
            print(f"[local] All {season} {year} trailers already cached.")
            print()
            continue

        if split_enabled and ollama_ready:
            # Phased split run (VRAM-optimal: one model resident at a time)
            items = [{"vid": s["trailer"]["id"], "title": get_title(s), "media_id": s["id"]}
                     for (s, _r) in uncached]
            try:
                translated, errors = run_phased(items, server, token, args, device, compute_type,
                                                prefix=f"{season} {year} ({si}/{ns})")
            except BotBlockError as e:
                print(f"\n[local] ABORT: {e}")
                break
        else:
            # Legacy / fallback per-video e2e translate (Whisper only). When
            # split_enabled but Ollama is down, translate_video still separates
            # vocals and does e2e translate on them (tagged large-v3).
            if model is None:
                print(f"[local] Loading Whisper {args.model} model ({compute_type})...")
                from faster_whisper import WhisperModel
                model = WhisperModel(args.model, device=device, compute_type=compute_type)
                print("[local] Model loaded.")
                print()
            translated = 0
            errors = 0
            for i, (show, reason) in enumerate(uncached):
                vid = show["trailer"]["id"]
                title = get_title(show)
                print(f"[{season} {year} ({si}/{ns}) | {i + 1}/{len(uncached)}] {title} ({vid}) [{reason}]...")
                try:
                    segments, video_url, used_split = translate_video(
                        model, vid, use_chunking=use_chunking, title=title,
                        split=split_enabled, translate_model=args.translate_model,
                        ollama_host=args.ollama_host, ollama_ready=ollama_ready)
                    model_name = "large-v3-split" if used_split else args.model
                    print(f"  Translated: {len(segments)} segments [{model_name}]")
                    has_burned_in = False
                    if segments:
                        try:
                            has_burned_in = detect_burned_in_subs(vid, segments, video_url=video_url)
                        except Exception as e:
                            print(f"  Burned-in detection failed: {e}")
                    result = upload_segments(server, token, vid, show["id"], model_name, segments, has_burned_in, args.force)
                    print(f"  Uploaded: {result.get('action', 'ok')}")
                    translated += 1
                except Exception as e:
                    print(f"  ERROR: {e}")
                    errors += 1

        print()
        remaining = len(uncached) - translated - errors
        print(f"[local] SEASON {si}/{ns} done — {season} {year}: {translated} translated, {errors} errors"
              + (f", {remaining} remaining" if remaining > 0 else ""))
        print()

    shutdown_ollama(args.ollama_host, args.translate_model, ollama_proc, keep=args.keep_ollama)

    if log_file:
        log_file.write(f"\nRun ended: {datetime.now().isoformat()}\n")
        log_file.close()


if __name__ == "__main__":
    main()
