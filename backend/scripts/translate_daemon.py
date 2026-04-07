"""
Persistent Whisper daemon — keeps the model in RAM across translation requests.

Protocol (stdin JSON lines → stdout JSON lines):
  Input:  {"cmd": "translate", "rid": "abc123", "videoId": "9OWMV9XrZ8k"}
  Input:  {"cmd": "check",     "rid": "def456", "videoId": "9OWMV9XrZ8k"}
  Input:  {"cmd": "cancel",    "rid": "abc123"}

  Output: {"rid": "abc123", "progress": "transcribing"}
  Output: {"rid": "abc123", "start": 5.0, "end": 8.0, "text": "Hello"}
  Output: {"rid": "abc123", "done": true}
  Output: {"rid": "def456", "hasEnglish": false}

Auto-exits after IDLE_TIMEOUT seconds of inactivity.
"""

import sys
import json
import os
import time
import threading
import tempfile
import shutil

# Import shared helpers from translate_stream (same directory)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from translate_stream import (
    check_subtitles,
    download_audio,
    generate_chunks,
    transcribe_chunks,
)

IDLE_TIMEOUT = 2 * 60 * 60  # 2 hours
MAX_WORKERS = 2

# Thread-safe stdout writing
_stdout_lock = threading.Lock()


def emit(rid: str, data: dict):
    """Write a JSON line to stdout, tagged with request ID."""
    data["rid"] = rid
    line = json.dumps(data)
    with _stdout_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def handle_translate(model, rid: str, video_id: str, cancelled: threading.Event):
    """Worker: download audio, transcribe chunks, emit results."""
    tmpdir = tempfile.mkdtemp()
    try:
        full_audio, duration = download_audio(video_id, tmpdir)

        if cancelled.is_set():
            return

        emit(rid, {"progress": "transcribing"})

        chunks = generate_chunks(duration)
        transcribe_chunks(
            model, chunks, tmpdir, full_audio,
            lambda data: emit(rid, data),
            cancelled=cancelled,
        )

        if not cancelled.is_set():
            emit(rid, {"done": True})

    except Exception as e:
        emit(rid, {"error": str(e)})
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def handle_check(rid: str, video_id: str):
    """Worker: check for English subtitles."""
    try:
        result = check_subtitles(video_id)
        emit(rid, result)
    except Exception as e:
        emit(rid, {"error": str(e)})


def main():
    # Load model once at startup
    from faster_whisper import WhisperModel
    model = WhisperModel("small", device="cpu", compute_type="int8")

    # Signal ready
    with _stdout_lock:
        sys.stdout.write(json.dumps({"ready": True}) + "\n")
        sys.stdout.flush()

    last_activity = time.time()
    active_requests: dict[str, threading.Event] = {}  # rid → cancelled event

    # Idle timeout watcher
    def idle_watcher():
        while True:
            time.sleep(60)
            if time.time() - last_activity > IDLE_TIMEOUT:
                with _stdout_lock:
                    sys.stdout.write(json.dumps({"shutdown": "idle_timeout"}) + "\n")
                    sys.stdout.flush()
                os._exit(0)

    watcher = threading.Thread(target=idle_watcher, daemon=True)
    watcher.start()

    # Main loop: read commands from stdin
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        last_activity = time.time()

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError:
            continue

        action = cmd.get("cmd")
        rid = cmd.get("rid", "")

        if action == "cancel":
            ev = active_requests.get(rid)
            if ev:
                ev.set()
            continue

        if action == "check":
            video_id = cmd.get("videoId", "")
            t = threading.Thread(
                target=handle_check,
                args=(rid, video_id),
                daemon=True,
            )
            t.start()
            continue

        if action == "translate":
            video_id = cmd.get("videoId", "")
            cancelled = threading.Event()
            active_requests[rid] = cancelled

            def _worker(rid=rid, video_id=video_id, cancelled=cancelled):
                try:
                    handle_translate(model, rid, video_id, cancelled)
                finally:
                    active_requests.pop(rid, None)

            t = threading.Thread(target=_worker, daemon=True)
            t.start()
            continue


if __name__ == "__main__":
    main()
