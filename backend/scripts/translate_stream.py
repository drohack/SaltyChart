"""
Real-time Japanese-to-English subtitle translation for YouTube trailers.

Provides shared helper functions used by:
  - translate_daemon.py (on-demand, `small` model, beam_size=1, chunked)
  - batch_translate.py  (batch, `medium` model, beam_size=5, full-audio)

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


def check_subtitles(video_id: str, timeout: int = 10) -> dict:
    """Check if the video has English subtitles. Returns dict with hasEnglish key.
    Times out after `timeout` seconds to avoid hanging on network issues."""
    import threading

    result = {"hasEnglish": False}

    def _check():
        try:
            from youtube_transcript_api import YouTubeTranscriptApi
            ytt = YouTubeTranscriptApi()
            # list() + find_transcript() checks manually uploaded, auto-generated,
            # AND transcripts translatable to English — not just manually uploaded ones.
            # The old ytt.fetch(languages=["en"]) only found manually uploaded tracks.
            transcript_list = ytt.list(video_id)
            transcript_list.find_transcript(['en'])
            result["hasEnglish"] = True
        except Exception:
            pass

    t = threading.Thread(target=_check, daemon=True)
    t.start()
    t.join(timeout=timeout)
    return result


def extract_chunk(chunk_start, chunk_end, tmpdir, full_audio):
    """Extract a 16 kHz-mono audio chunk via ffmpeg, decoding straight from the
    native downloaded file (single pass — no whole-file WAV transcode upfront).
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


def download_audio(video_id: str, tmpdir: str, as_wav: bool = True):
    """Download the worst-quality audio track. Returns (audio_path, duration).

    as_wav=True  (default; used by batch_translate): transcode the whole file to
                 WAV via yt-dlp's postprocessor — convenient for full-audio passes.
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
    the full audio in one pass — faster and better quality since Whisper has full
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
    # transcribe it — still a single decode pass, and reliable regardless of the
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
        # whole-file WAV transcode — chunks are sliced from it on the fly).
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
