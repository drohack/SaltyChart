"""
Full test suite for the SaltyChart translation pipeline.

Tests server code (backend/scripts/) for small and medium models,
and local code (tools/local_translate.py) for large-v3 and burned-in detection.

Usage:
  python tools/test_translate.py                  # run all tests
  python tools/test_translate.py --small          # server small model (CPU, chunked)
  python tools/test_translate.py --medium         # server medium model (CPU, chunked)
  python tools/test_translate.py --large          # local large-v3 (GPU, full-audio)
  python tools/test_translate.py --small --large  # combine any flags
  python tools/test_translate.py --burned-in      # burned-in detection only
  python tools/test_translate.py --models         # all model tests (no burned-in)
  python tools/test_translate.py --all            # everything (default)

Results are logged to tools/logs/test_results.log
"""

import sys
import os
import time
import gc

# Add both tools/ and backend/scripts/ to path
TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPTS_DIR = os.path.join(os.path.dirname(TOOLS_DIR), "backend", "scripts")
sys.path.insert(0, TOOLS_DIR)
sys.path.insert(0, SCRIPTS_DIR)

# ── Logging ──────────────────────────────────────────────────

LOG_PATH = os.path.join(TOOLS_DIR, "logs", "test_results.log")
os.makedirs(os.path.dirname(LOG_PATH), exist_ok=True)
_log_file = open(LOG_PATH, "w", encoding="utf-8")


def log(msg=""):
    print(msg)
    _log_file.write(msg + "\n")
    _log_file.flush()


# ── Test config ──────────────────────────────────────────────

MODEL_TEST_VIDEO = "rc17AA0hVI8"  # short 51s video

BURNED_IN_TESTS = [
    ("WsT7OO91jXo", True,  "Burned-in (Tenmaku no Jaadugar)"),
    ("EsQudPqDOQQ", True,  "Burned-in (Eren the Southpaw)"),
    ("Gux_dYHDMK4", True,  "Burned-in (Fist of the North Star)"),
    ("3mTUxCIyJhA", True,  "Burned-in (Second Prettiest Girl)"),
    ("rc17AA0hVI8", True,  "Burned-in (Kujima Utaeba)"),
    ("9OWMV9XrZ8k", False, "CC only, no burned-in"),
    ("UfkutRs8RHM", False, "No subtitles"),
]

passed = 0
failed = 0


def check(name, ok, detail=""):
    global passed, failed
    if ok:
        log(f"  PASS: {name}")
        passed += 1
    else:
        log(f"  FAIL: {name} -- {detail}")
        failed += 1


def free_gpu():
    gc.collect()
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def _run_subprocess(label, test_id):
    """Run a test in a separate process to avoid GPU memory conflicts."""
    import subprocess as sp
    log(f"\n--- Test: {label} (subprocess) ---")
    result = sp.run(
        [sys.executable, "-u", __file__, "--_sub", test_id],
        capture_output=True, text=True, timeout=180,
    )
    for line in result.stdout.strip().split("\n"):
        if line.strip():
            log(line)
            if line.strip().startswith("PASS:"):
                global passed
                passed += 1
            elif line.strip().startswith("FAIL:"):
                global failed
                failed += 1
    if result.returncode != 0 and result.stderr:
        # Show last 200 chars of stderr for debugging
        log(f"  ERROR: {result.stderr.strip()[-200:]}")


# ── Server tests (backend/scripts/) ─────────────────────────

def test_server_download_audio():
    """Test server's download_audio from translate_stream.py."""
    log("\n--- Test: server download_audio ---")
    import tempfile, shutil
    from translate_stream import download_audio
    tmpdir = tempfile.mkdtemp()
    try:
        audio_path, duration = download_audio(MODEL_TEST_VIDEO, tmpdir)
        check("server audio file exists", os.path.exists(audio_path))
        check("server audio has content", os.path.getsize(audio_path) > 0)
        check("server duration positive", duration > 0, f"got {duration}")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_server_chunking():
    """Test server's chunking functions from translate_stream.py."""
    log("\n--- Test: server chunking ---")
    import tempfile, shutil
    from translate_stream import generate_chunks, extract_chunk, download_audio

    chunks = generate_chunks(120)
    check("server generates chunks", len(chunks) > 0)
    check("server first chunk 5s", chunks[0] == (0, 5), f"got {chunks[0]}")
    check("server ramp-up", chunks[1] == (5, 10), f"got {chunks[1]}")

    tmpdir = tempfile.mkdtemp()
    try:
        audio_path, _ = download_audio(MODEL_TEST_VIDEO, tmpdir)
        chunk_path = extract_chunk(0, 5, tmpdir, audio_path)
        check("server extract_chunk works", os.path.exists(chunk_path))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_server_small():
    """Test server small model (CPU, int8, chunked, beam_size=1) — matches daemon."""
    log("\n--- Test: server small (cpu, chunked, beam=1) ---")
    import tempfile, shutil
    from translate_stream import download_audio, generate_chunks, transcribe_chunks
    from faster_whisper import WhisperModel

    log("  Loading small (cpu, int8)...")
    model = WhisperModel("small", device="cpu", compute_type="int8")

    tmpdir = tempfile.mkdtemp()
    try:
        audio_path, duration = download_audio(MODEL_TEST_VIDEO, tmpdir)
        chunks = generate_chunks(duration)

        segments = []
        first_seg_time = None
        t_start = time.time()

        def emit(data):
            nonlocal first_seg_time
            if "text" in data and first_seg_time is None:
                first_seg_time = time.time() - t_start
            if "start" in data and "text" in data:
                segments.append(data)

        transcribe_chunks(model, chunks, tmpdir, audio_path, emit)
        elapsed = time.time() - t_start
        log(f"  Translated {len(segments)} segments in {elapsed:.1f}s")
        if first_seg_time:
            log(f"  Time-to-first-segment: {first_seg_time:.1f}s")

        check("server small: has segments", len(segments) > 0, f"got {len(segments)}")
        check("server small: segments have text", all(s.get("text") for s in segments))
        check("server small: segments have timing", all(s.get("end", 0) > s.get("start", 0) for s in segments))
        if first_seg_time:
            check("server small: first segment under 5s", first_seg_time < 5,
                  f"took {first_seg_time:.1f}s")
        if segments:
            last_end = max(s["end"] for s in segments)
            check("server small: spans video", last_end > 10, f"last at {last_end:.1f}s")
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    del model


def test_server_medium():
    """Test server medium model (CPU, int8, chunked, beam_size=5) — matches batch."""
    log("\n--- Test: server medium (cpu, chunked, beam=5) ---")
    import tempfile, shutil
    from translate_stream import download_audio, generate_chunks, extract_chunk
    from faster_whisper import WhisperModel
    from concurrent.futures import ThreadPoolExecutor, Future

    log("  Loading medium (cpu, int8)...")
    model = WhisperModel("medium", device="cpu", compute_type="int8")

    tmpdir = tempfile.mkdtemp()
    try:
        audio_path, duration = download_audio(MODEL_TEST_VIDEO, tmpdir)
        chunks = generate_chunks(duration)
        segments = []

        # Match batch_translate.py: beam_size=5, condition_on_previous_text=True
        t_start = time.time()
        with ThreadPoolExecutor(max_workers=1) as pool:
            next_future = pool.submit(extract_chunk, chunks[0][0], chunks[0][1], tmpdir, audio_path)
            for i, (chunk_start, chunk_end) in enumerate(chunks):
                chunk_path = next_future.result()
                if i + 1 < len(chunks):
                    next_future = pool.submit(extract_chunk, chunks[i+1][0], chunks[i+1][1], tmpdir, audio_path)
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

        elapsed = time.time() - t_start
        log(f"  Translated {len(segments)} segments in {elapsed:.1f}s")

        check("server medium: has segments", len(segments) > 0, f"got {len(segments)}")
        check("server medium: segments have text", all(s.get("text") for s in segments))
        check("server medium: segments have timing", all(s.get("end", 0) > s.get("start", 0) for s in segments))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)
    del model


# ── Local tests (tools/local_translate.py) ───────────────────

def test_local_download_audio():
    """Test local download_audio (returns video_url too)."""
    log("\n--- Test: local download_audio ---")
    import tempfile, shutil
    from local_translate import download_audio
    tmpdir = tempfile.mkdtemp()
    try:
        audio_path, duration, video_url = download_audio(MODEL_TEST_VIDEO, tmpdir)
        check("local audio file exists", os.path.exists(audio_path))
        check("local audio has content", os.path.getsize(audio_path) > 0)
        check("local duration positive", duration > 0, f"got {duration}")
        check("local video_url returned", video_url is not None)
        check("local video_url is URL", video_url and video_url.startswith("http"))
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def test_local_large_v3():
    """Test local large-v3 (GPU, float16, full-audio, no chunking)."""
    log("\n--- Test: local large-v3 (cuda, full-audio) ---")
    from local_translate import translate_video
    from faster_whisper import WhisperModel

    log("  Loading large-v3 (cuda, float16)...")
    model = WhisperModel("large-v3", device="cuda", compute_type="float16")

    t = time.time()
    segments, video_url = translate_video(model, MODEL_TEST_VIDEO, use_chunking=False)
    elapsed = time.time() - t
    log(f"  Translated {len(segments)} segments in {elapsed:.1f}s")

    check("local large-v3: has segments", len(segments) > 0, f"got {len(segments)}")
    check("local large-v3: returns video_url", video_url is not None)
    check("local large-v3: segments have text", all(s.get("text") for s in segments))
    check("local large-v3: segments have timing", all(s.get("end", 0) > s.get("start", 0) for s in segments))

    # Context test: Yoroshiku should be translated (not kept in Japanese)
    all_text = " ".join(s["text"] for s in segments).lower()
    has_jp = "yoroshiku" in all_text
    has_en = any(p in all_text for p in ["nice to meet", "pleased to meet", "pleasure"])
    check("local large-v3: translates Yoroshiku", not has_jp or has_en,
          f"yoroshiku={has_jp} translated={has_en}")

    del model
    free_gpu()
    return segments, video_url


def test_burned_in():
    """Test burned-in subtitle detection on all known test videos."""
    log("\n--- Test: burned-in subtitle detection ---")
    from local_translate import translate_video, detect_burned_in_subs
    from faster_whisper import WhisperModel

    log("  Loading large-v3 for detection tests...")
    model = WhisperModel("large-v3", device="cuda", compute_type="float16")

    for video_id, expected, desc in BURNED_IN_TESTS:
        log(f"\n  {desc} ({video_id})")
        t = time.time()
        segments, video_url = translate_video(model, video_id, use_chunking=False)
        translate_t = time.time() - t

        detect_t = time.time()
        result = detect_burned_in_subs(video_id, segments, video_url=video_url)
        detect_t = time.time() - detect_t

        expected_s = "BURNED-IN" if expected else "CLEAN"
        result_s = "BURNED-IN" if result else "CLEAN"
        check(f"{video_id} ({desc})", result == expected,
              f"expected={expected_s} got={result_s}")
        log(f"    translate={translate_t:.1f}s detect={detect_t:.1f}s total={translate_t+detect_t:.1f}s")

    del model
    free_gpu()


# ── Main ─────────────────────────────────────────────────────

def main():
    global passed, failed

    args = [a for a in sys.argv[1:] if not a.startswith("--_")]

    run_all = "--all" in args or len(args) == 0
    run_models = "--models" in args or run_all
    run_small = "--small" in args or run_models
    run_medium = "--medium" in args or run_models
    run_large = "--large" in args or run_models
    run_burned = "--burned-in" in args or run_all

    log("=" * 60)
    log("  SaltyChart Translation Pipeline Test Suite")
    log(f"  {time.strftime('%Y-%m-%d %H:%M:%S')}")
    log("=" * 60)

    # Server tests (small/medium use backend/scripts/ code)
    if run_small or run_medium:
        test_server_download_audio()
        test_server_chunking()

    if run_small:
        _run_subprocess("server small", "small")
    if run_medium:
        _run_subprocess("server medium", "medium")

    # Local tests (large-v3 uses tools/local_translate.py code)
    if run_large:
        test_local_download_audio()
        _run_subprocess("local large-v3", "large")

    if run_burned:
        _run_subprocess("burned-in detection", "burned-in")

    log("\n" + "=" * 60)
    log(f"  RESULTS: {passed} passed, {failed} failed")
    log("=" * 60)

    _log_file.close()
    return failed == 0


if __name__ == "__main__":
    # Internal subprocess dispatch
    if "--_sub" in sys.argv:
        idx = sys.argv.index("--_sub")
        test_name = sys.argv[idx + 1]
        # In subprocess, log = print (no file)
        log_backup = globals()["log"]
        globals()["log"] = print

        if test_name == "small":
            test_server_small()
        elif test_name == "medium":
            test_server_medium()
        elif test_name == "large":
            test_local_large_v3()
        elif test_name == "burned-in":
            test_burned_in()

        sys.exit(0 if failed == 0 else 1)

    success = main()
    sys.exit(0 if success else 1)
