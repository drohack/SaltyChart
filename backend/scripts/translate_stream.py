"""
Real-time Japanese-to-English subtitle translation for YouTube trailers.

Provides shared helper functions used by:
  - translate_daemon.py     (on-demand, `small` model, beam_size=1, chunked)
  - batch_translate.py      (batch, `medium` model, beam_size=5, full-audio)
  - tools/local_translate.py (the Sunday GPU run: constants, classifiers, verdict)
  - tools/yt_guard.py       (the dev-tooling YouTube budget: BOT_WALL_SIGNS)

CONSTRAINT, load-bearing because of those last two: **module-level imports must
stay stdlib-only.** yt_guard.py imports this on every PreToolUse hook
invocation, and local_translate.py imports it before torch is loaded. yt_dlp,
faster_whisper and youtube_transcript_api are imported inside the functions
that need them, and the CC-check classifier matches exception class NAMES so it
never has to import the package. Adding a heavy import at the top of this file
slows every shell command in the repo.

Chunking is only used by the small model for real-time streaming (fast
time-to-first-segment). Short videos (<=4 chunks / ~30s) skip chunking
even for the small model. The medium and large-v3 models always use
full-audio transcription for better quality.

Usage (standalone):
  python translate_stream.py check <videoId>      # Check if English subs exist
  python translate_stream.py translate <videoId>   # Transcribe+translate via Whisper (small model)
"""

import sys
import json
import re
import os
import subprocess
import tempfile

# Seconds between consecutive trailer downloads in the batch scripts.
#
# ONE definition. argparse reads it as `default=` and prints it with
# `%(default)s`, so the help text cannot drift from the value.
# `tools/local_translate.py` IMPORTS it from here rather than carrying a copy -
# this module has only stdlib imports at top level, so that costs nothing and
# removes a "keep the two equal" burden. (MODEL_RANK still has three hand-synced
# copies; that predates this and is documented in backend/CLAUDE.md.)
#
# 10, not 5: yt-dlp's own `-t sleep` preset waits a random 10-20 s before each
# download (README, checked 2026-09-20 against the raw text). 5 s was 2-4x more
# aggressive than the tool's shipped recommendation - the one documented pacing
# number that exists anywhere for YouTube.
DOWNLOAD_DELAY_DEFAULT = 10.0

# Whisper model quality ladder. ONE Python definition - batch_translate.py and
# tools/local_translate.py import it. backend/src/lib/subtitleReport.ts is the
# TypeScript twin, and test_run_verdict.py asserts the two are equal, so a
# change here that is not mirrored there fails a test instead of silently
# treating champion output as rank 0 and reprocessing it for nothing (the bug
# the old three-hand-synced-copies arrangement invited).
MODEL_RANK = {
    "tiny": 0,
    "base": 1,
    "small": 2,
    "medium": 3,
    "large-v2": 4,
    "large-v3": 5,
    "large-v3-split": 6,
}
CHAMPION = "large-v3-split"


# Exceptions from youtube_transcript_api that mean "this video definitively has
# no English track". Matched by CLASS NAME through the exception's MRO, not by
# importing the package: this module is imported by tools/yt_guard.py on the
# PreToolUse hook path and must stay stdlib-only at import time. Checked
# 2026-09-20 against youtube-transcript-api 1.2.4, where every error class
# subclasses CouldNotRetrieveTranscript; test_run_verdict.py re-checks these
# names against the installed package (SKIP, not PASS, when it is absent).
DEFINITIVE_NO_CC = ("NoTranscriptFound", "TranscriptsDisabled", "VideoUnavailable",
                    "VideoUnplayable", "InvalidVideoId")


def classify_check_exception(e) -> "bool | None":
    """False when YouTube definitively says there is no track; None when we
    could not find out - IpBlocked, RequestBlocked, YouTubeRequestFailed,
    PoTokenRequired, AgeRestricted (a track may exist, we cannot see it), an
    ImportError (package missing), a network error, anything unexpected.
    None is NOT a verdict and must never be written as one."""
    names = {c.__name__ for c in type(e).__mro__}
    return False if names & set(DEFINITIVE_NO_CC) else None


def check_subtitles(video_id: str, timeout: int = 10) -> dict:
    """Does the video have an English track? THREE answers, not two:

        {"hasEnglish": True}                          a track exists (manual, auto, or translatable)
        {"hasEnglish": False}                         YouTube definitively says none
        {"hasEnglish": None, "checkError": "<Class>"} we could not find out

    The third used to be reported as False, and every write site pinned it as
    0 with a fresh lastEnCheckAt, trusted for seven days - so one transient IP
    block sent a video WITH English captions down the download path for a week.
    Only True/False are verdicts; the backend gate is lib/subtitleCheck.ts and
    the batch's own write mirrors it. A timeout is "could not find out".
    """
    import threading

    result = {"hasEnglish": None, "checkError": "timeout"}

    def _check():
        try:
            from youtube_transcript_api import YouTubeTranscriptApi
            ytt = YouTubeTranscriptApi()
            # list() + find_transcript() checks manually uploaded, auto-generated,
            # AND transcripts translatable to English - not just manually uploaded ones.
            # The old ytt.fetch(languages=["en"]) only found manually uploaded tracks.
            transcript_list = ytt.list(video_id)
            transcript_list.find_transcript(['en'])
            result["hasEnglish"] = True
            result.pop("checkError", None)
        except Exception as e:
            verdict = classify_check_exception(e)
            result["hasEnglish"] = verdict
            if verdict is None:
                result["checkError"] = type(e).__name__
                # stderr reaches the backend log through the daemon's pipe.
                sys.stderr.write(f"[check] {video_id}: no verdict ({type(e).__name__})\n")
                sys.stderr.flush()
            else:
                result.pop("checkError", None)

    t = threading.Thread(target=_check, daemon=True)
    t.start()
    t.join(timeout=timeout)
    return result


def extract_chunk(chunk_start, chunk_end, tmpdir, full_audio):
    """Extract a 16 kHz-mono audio chunk via ffmpeg, decoding straight from the
    native downloaded file (single pass - no whole-file WAV transcode upfront).
    `-threads 1` keeps ffmpeg from grabbing cores Plex needs on the server.
    Only used by the small model for chunked streaming. Medium/large use full-audio."""
    chunk_path = os.path.join(tmpdir, f"chunk_{chunk_start}.wav")
    cmd = [
        "ffmpeg", "-y", "-threads", "1",
        "-ss", str(chunk_start),
    ]
    if chunk_end is not None:
        cmd += ["-t", str(chunk_end - chunk_start)]
    cmd += [
        "-i", full_audio,
        "-ac", "1", "-ar", "16000",
        "-f", "wav", chunk_path,
    ]
    kwargs = dict(
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
        timeout=60,
    )
    # On Windows, prevent ffmpeg from inheriting the daemon's console/pipes
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    subprocess.run(cmd, **kwargs)
    # Validate extraction succeeded
    if not os.path.exists(chunk_path) or os.path.getsize(chunk_path) == 0:
        raise RuntimeError(f"ffmpeg chunk extraction failed: {chunk_path}")
    return chunk_path


# Phrases YouTube uses when it has started refusing us. ONE definition.
# `is_bot_block` below reads it; `batch_translate.py`, `friendly_error` and
# `tools/local_translate.py` use is_bot_block; `tools/yt_guard.py` imports the
# tuple itself (its hook path matches command output, not exceptions).
BOT_WALL_SIGNS = ("sign in to confirm", "not a bot", "ipblocked", "requestblocked",
                  "too many requests", "http error 429")


def is_bot_block(msg) -> bool:
    """YouTube is challenging or rate-limiting us - stop, do not retry."""
    low = str(msg or "").lower()
    return any(s in low for s in BOT_WALL_SIGNS)


def friendly_error(e: Exception) -> str:
    """Turn a yt-dlp failure into something a viewer can act on.

    The raw string is written for someone holding a terminal, and it actively
    misleads here: `HTTP Error 403: Forbidden` reads as "SaltyChart needs to log
    in to YouTube", which is never true - we send no credentials and need none.
    A 403 on the *download* (extraction having already succeeded) means our
    yt-dlp is too old for the way YouTube now serves media. That is our bug to
    fix, not something the viewer can do anything about, so say so plainly and
    keep the raw text on stderr for the logs.
    """
    return _FRIENDLY[classify_error(e)]


# One classification, three consumers: the viewer's message (`friendly_error`),
# the daemon's `kind` field, and the backend's hold-on-bot-wall decision. The
# backend never re-derives this from the raw text - the phrase list lives here.
#
# `botwall` is checked BEFORE `forbidden` on purpose. A YouTube challenge can
# arrive as an HTTP 403 whose body says "Sign in to confirm you're not a bot";
# reading that as a plain 403 would skip the hold and keep poking a blocked IP,
# which is the dangerous direction. An explicit bot phrase outranks a status code.
def classify_error(e) -> str:
    raw = str(e)
    if is_bot_block(raw):
        return "botwall"
    if "403" in raw and "Forbidden" in raw:
        return "forbidden"
    if "Video unavailable" in raw or "Private video" in raw:
        return "unavailable"
    return "other"


_FRIENDLY = {
    "botwall": "YouTube rate-limited this server, try again later",
    "forbidden": "YouTube refused the audio download (server needs an update)",
    "unavailable": "This trailer is not available to download",
    "other": "Could not fetch the trailer audio",
}


# --- Did the batch run actually work? ----------------------------------------
# Both batch scripts used to count download errors, print them in a summary,
# and then fall off the end of main() - exit code 0 regardless. The Sunday GPU
# run logged `FALL 2026: 3 translated, 46 errors` for four consecutive weeks
# (Sundays 2026-08-23 through 2026-09-20; the whole history is in
# tools/logs/translate.log - every other file that cites "four Sundays" or
# "46 of 49" points here) while the Windows Scheduled Task showed
# lastResult=0x0, because nothing ever turned the count into a verdict. This does.
#
# The two thresholds exist so a run is not failed by the normal case - a couple
# of private or removed trailers - but IS failed when most of it did not happen.
RUN_FAIL_MIN = 3        # fewer failures than this can never fail a run
RUN_FAIL_RATIO = 0.5    # more than this share of attempts failing does

_REMEDY = {
    "forbidden": "HTTP 403 on download is a stale yt-dlp, not an auth problem - upgrade it (py -m pip install -U yt-dlp)",
    "botwall": "YouTube is challenging this IP - wait out the cooldown before re-running",
    "unavailable": "trailers private or removed - nothing to fix here",
    "other": "see the DOWNLOAD ERROR lines above",
}


def run_verdict(attempted: int, errors: int, kinds=None, aborted: bool = False):
    """Turn a run's error count into (exit_code, final_line).

    0 = fine, 2 = most downloads failed, 3 = aborted on a bot wall. The line is
    meant to be the LAST thing printed - the status bar shows only the last
    line, and `persistBatchRun` keeps the log tail - so it carries the numbers,
    the dominant failure kind and what to do about it.
    """
    kinds = {k: int(v) for k, v in dict(kinds or {}).items() if v}
    breakdown = ", ".join(f"{n} {k}" for k, n in sorted(kinds.items(), key=lambda kv: -kv[1])) or "no breakdown"
    top = max(kinds, key=kinds.get) if kinds else "other"
    if aborted:
        return 3, (f"Done: ABORTED on a YouTube bot-challenge - {errors} of {attempted} downloads failed "
                   f"({breakdown}). {_REMEDY['botwall']}")
    if errors >= RUN_FAIL_MIN and errors > attempted * RUN_FAIL_RATIO:
        return 2, (f"Done: FAILED - {errors} of {attempted} downloads failed ({breakdown}). "
                   f"{_REMEDY.get(top, _REMEDY['other'])}")
    tail = f", {errors} error(s) ({breakdown})" if errors else ""
    return 0, f"Done: OK - {attempted - errors} of {attempted} downloaded{tail}"


def ensure_ytdlp_current(say=print, timeout_s: int = 300) -> str:
    """Upgrade yt-dlp in this interpreter's environment BEFORE the first download.

    Why inside the run rather than a separate job: the thing that breaks is
    YouTube's schedule, and the run is the moment it matters. The Sunday GPU run
    sat on yt-dlp 2026.03.17 for six months and lost four straight weeks of
    downloads to a change the 2026.08.19 release had already fixed. The
    container has a daily updater too (lib/ytdlpUpdate.ts); calling this at the
    top of the batch as well makes the batch independent of that timer.

    Who calls it: the two BATCH scripts (batch_translate.py, local_translate.py)
    - off-hours, and a stale yt-dlp costs them a whole season. NOT the live
    daemon: a viewer is waiting on it, this is a pip round trip (6.2 s on the
    dev PC, 2026-09-20, in the already-current case; longer when it actually
    downloads or PyPI is slow), and the daily updater plus daemon recycle is
    good enough there.

    Two rules that are easy to break:
      * The version is read OUT OF PROCESS. Importing yt_dlp here would cache
        the old module in sys.modules, and the later `import yt_dlp` inside
        download_audio would silently keep using it, upgrade or not - the same
        trap that makes the backend recycle its daemon after an update.
      * Best-effort. No network, PyPI down, no pip: say so and carry on with
        whatever is installed. A run must never fail to START because of this.
    Returns the one-line status it printed.
    """
    def version() -> str:
        try:
            r = subprocess.run([sys.executable, "-c", "import yt_dlp, sys; sys.stdout.write(yt_dlp.version.__version__)"],
                               capture_output=True, text=True, timeout=60)
            return r.stdout.strip() or "unknown"
        except Exception:
            return "unknown"

    before = version()
    # --break-system-packages: Debian marks the container's Python "externally
    # managed" and pip refuses to touch it without this. Accepted (as a no-op)
    # by pip >= 23 everywhere else, including Windows.
    cmd = [sys.executable, "-m", "pip", "install", "--quiet", "--upgrade", "--break-system-packages", "yt-dlp"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
        # pip < 23 does not know --break-system-packages and exits 2 with "no
        # such option". Retry once without it rather than "failing gracefully"
        # into exactly the stale state this function exists to prevent.
        if r.returncode != 0 and "no such option" in (r.stderr or r.stdout).lower():
            cmd = [a for a in cmd if a != "--break-system-packages"]
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_s)
        if r.returncode != 0:
            why = (r.stderr or r.stdout).strip().splitlines()[-1:] or ["no output"]
            line = f"yt-dlp: update failed (pip exit {r.returncode}: {why[0][:160]}); continuing on {before}"
        else:
            after = version()
            line = (f"yt-dlp: {before} -> {after} (upgraded)" if after != before
                    else f"yt-dlp: {after} (up to date)")
    except Exception as e:
        line = f"yt-dlp: update failed ({type(e).__name__}: {str(e)[:120]}); continuing on {before}"
    say(line)
    return line


def download_audio(video_id: str, tmpdir: str, as_wav: bool = True):
    """Download the worst-quality audio track. Returns (audio_path, duration).

    as_wav=True  (default; used by batch_translate): transcode the whole file to
                 WAV via yt-dlp's postprocessor - convenient for full-audio passes.
    as_wav=False (live daemon): keep the NATIVE audio (m4a/webm/opus) and skip the
                 whole-file transcode. The chunked path slices 16 kHz-mono chunks
                 straight from it via extract_chunk(), so the upfront full-file WAV
                 conversion (wasted work for chunked streaming) is avoided entirely.
    """
    import yt_dlp

    ydl_opts = {
        "format": "worstaudio",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "outtmpl": os.path.join(tmpdir, "full.%(ext)s"),
        # yt-dlp solves YouTube's JavaScript challenges by EXECUTING YouTube's
        # own player JS, so it needs a JS engine - and it enables only deno by
        # default, which this image does not have. Without one it warns "some
        # formats may be missing" and takes a path it calls deprecated.
        #
        # This is future-proofing, NOT the fix for the 2026-09 403: a current
        # yt-dlp downloads fine with no runtime at all. Don't cite it as the
        # cause of that outage. Node is already here (node:20-slim), so naming
        # it costs nothing; deno is listed first so a box that has it wins.
        "js_runtimes": {"deno": {}, "node": {}},
    }
    if as_wav:
        ydl_opts["postprocessors"] = [{
            "key": "FFmpegExtractAudio",
            "preferredcodec": "wav",
        }]
    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(
            f"https://www.youtube.com/watch?v={video_id}", download=True
        )
        duration = info.get("duration", 120)

    # Locate the produced file (extension depends on as_wav / source format).
    for name in os.listdir(tmpdir):
        if name.startswith("full."):
            return os.path.join(tmpdir, name), duration
    raise RuntimeError("download produced no audio file")


def generate_chunks(duration: float, start: float = 0.0):
    """Generate chunk boundaries, ramping up chunk size for fast first subtitles.

    `start` lets the live path begin near the user's current playback position
    instead of second 0, so the daemon doesn't spend CPU translating audio the
    viewer has already watched (those segments get discarded by the frontend's
    forward-only subtitle pointer anyway). Chunk timestamps stay absolute."""
    # Chunk sizes: 5, 5, 10, 10, 20, 20, 20, ...
    RAMP = [5, 5, 10, 10]
    CHUNK_SIZE = 20
    chunks = []
    pos = max(0.0, start)
    i = 0
    while pos < duration:
        size = RAMP[i] if i < len(RAMP) else CHUNK_SIZE
        i += 1
        end = min(pos + size, duration)
        chunks.append((pos, end))
        pos = end
    return chunks


def transcribe_chunks(model, chunks, tmpdir, full_audio, emit, cancelled=None):
    """Transcribe audio chunks with pipelined extraction.

    For short videos (<=30s / 4 or fewer chunks), skips chunking and transcribes
    the full audio in one pass - faster and better quality since Whisper has full
    context. For longer videos, uses the ramp-up chunking strategy for fast
    time-to-first-segment.

    Args:
        model: WhisperModel instance
        chunks: list of (start, end) tuples
        tmpdir: temp directory path
        full_audio: path to full audio WAV
        emit: callable(dict) to output each segment/progress
        cancelled: optional threading.Event, checked between chunks
    """
    # Short videos: one full-tail pass beats chunking overhead. Extract a single
    # 16 kHz-mono WAV from the native download (from the playhead onward) and
    # transcribe it - still a single decode pass, and reliable regardless of the
    # native audio codec.
    if len(chunks) <= 4:
        seg_start = chunks[0][0] if chunks else 0.0
        src = extract_chunk(seg_start, None, tmpdir, full_audio)
        try:
            segments, _ = model.transcribe(
                src, language="ja", task="translate",
                vad_filter=True, beam_size=1,
                condition_on_previous_text=False,
                word_timestamps=True,
            )
            for seg in segments:
                if cancelled and cancelled.is_set():
                    return
                text = seg.text.strip()
                if not text:
                    continue
                w = seg.words
                emit({
                    "start": round((w[0].start if w else seg.start) + seg_start, 2),
                    "end":   round((w[-1].end  if w else seg.end)   + seg_start, 2),
                    "text": text,
                })
        finally:
            if os.path.exists(src):
                os.unlink(src)
        return

    # Longer videos: chunk for fast time-to-first-segment
    from concurrent.futures import ThreadPoolExecutor, Future

    with ThreadPoolExecutor(max_workers=1) as extract_pool:
        next_future: Future = extract_pool.submit(
            extract_chunk, chunks[0][0], chunks[0][1], tmpdir, full_audio
        )

        for i, (chunk_start, chunk_end) in enumerate(chunks):
            if cancelled and cancelled.is_set():
                return

            chunk_path = next_future.result()

            # Pre-extract next chunk while we transcribe this one
            if i + 1 < len(chunks):
                next_future = extract_pool.submit(
                    extract_chunk, chunks[i + 1][0], chunks[i + 1][1],
                    tmpdir, full_audio
                )

            try:
                segments, _ = model.transcribe(
                    chunk_path, language="ja", task="translate",
                    vad_filter=True, beam_size=1,
                    condition_on_previous_text=False,
                    word_timestamps=True,
                )

                for seg in segments:
                    if cancelled and cancelled.is_set():
                        return
                    text = seg.text.strip()
                    if not text:
                        continue
                    w = seg.words
                    emit({
                        "start": round((w[0].start if w else seg.start) + chunk_start, 2),
                        "end":   round((w[-1].end  if w else seg.end)   + chunk_start, 2),
                        "text": text,
                    })
            finally:
                if os.path.exists(chunk_path):
                    os.unlink(chunk_path)


def translate_audio(video_id: str, start: float = 0.0):
    """Standalone mode: download, load model, transcribe, print to stdout."""
    from concurrent.futures import ThreadPoolExecutor, Future

    def _load_model():
        from faster_whisper import WhisperModel
        return WhisperModel("small", device="cpu", compute_type="int8")

    def emit(data):
        print(json.dumps(data), flush=True)

    try:
        tmpdir = tempfile.mkdtemp()

        # Start model loading in background while we download audio (native, no
        # whole-file WAV transcode - chunks are sliced from it on the fly).
        with ThreadPoolExecutor(max_workers=1) as model_pool:
            model_future: Future = model_pool.submit(_load_model)
            full_audio, duration = download_audio(video_id, tmpdir, as_wav=False)
            model = model_future.result()

        emit({"progress": "transcribing"})

        chunks = generate_chunks(duration, start)
        transcribe_chunks(model, chunks, tmpdir, full_audio, emit)
        emit({"done": True})

        # Cleanup
        if os.path.exists(full_audio):
            os.unlink(full_audio)
        os.rmdir(tmpdir)

    except Exception as e:
        print(json.dumps({"error": str(e)}), flush=True)
        try:
            import shutil
            if 'tmpdir' in dir() and os.path.exists(tmpdir):
                shutil.rmtree(tmpdir, ignore_errors=True)
        except Exception:
            pass
        sys.exit(1)


def main():
    if len(sys.argv) < 3:
        print(
            json.dumps({"error": "Usage: translate_stream.py <check|translate> <videoId>"}),
            flush=True,
        )
        sys.exit(1)

    mode = sys.argv[1]
    video_id = sys.argv[2]

    if not re.match(r"^[a-zA-Z0-9_-]{11}$", video_id):
        print(json.dumps({"error": "Invalid video ID"}), flush=True)
        sys.exit(1)

    if mode == "check":
        result = check_subtitles(video_id)
        print(json.dumps(result), flush=True)
    elif mode == "translate":
        translate_audio(video_id)
    else:
        print(json.dumps({"error": f"Unknown mode: {mode}"}), flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
