"""
Regression test: burned-in subtitle detection.

Runs local_translate.py (large-v3 + OCR + sentence-transformers) against a
known-positive and a known-negative video and verifies the detection result.

Usage:
  py -3.13 -u tools/tests/test_burned_in_detection.py

Exits 0 if all expectations match, 1 otherwise. Requires:
  - Running backend at http://localhost:3000 (for --server arg)
  - CUDA GPU (large-v3 float16)
  - faster-whisper, easyocr, sentence-transformers installed

Test cases use videos confirmed in the live PROD SubtitleCache:
  - EsQudPqDOQQ (Eren the Southpaw) - known burned-in, expected: yes
  - 7ObipYqbOd8 (Sparks of Tomorrow) - has YouTube English CC, no burned-in
"""
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
LOCAL_TRANSLATE = REPO_ROOT / "tools" / "local_translate.py"

# (video_id, title, expected_result)
CASES = [
    ("EsQudPqDOQQ", "Eren the Southpaw",     "yes"),
    ("7ObipYqbOd8", "Sparks of Tomorrow",    "no"),
]


def run_case(case_num: int, total: int, video_id: str, expected: str) -> tuple[bool, str]:
    """Run local_translate.py against one video. Streams a self-contained
    progress line for each meaningful event - every line carries
    [case n/total VIDEO_ID step] so the status bar always shows overall position."""
    prefix = f"[{case_num}/{total} {video_id}]"
    proc = subprocess.Popen(
        ["py", "-3.13", "-u", str(LOCAL_TRANSLATE),
         "--server", "http://localhost:3000",
         "--video", video_id,
         "--no-upload"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    captured = []
    for line in proc.stdout:
        captured.append(line)
        line = line.rstrip()
        # Normalize the events we want to surface, with progress counters
        if "Loading Whisper" in line:
            print(f"{prefix} step 1/4: loading large-v3 model...", flush=True)
        elif "Translated:" in line:
            print(f"{prefix} step 2/4: {line.split('] ')[-1]}", flush=True)
        elif "Checking for burned-in" in line:
            print(f"{prefix} step 3/4: starting burned-in OCR check (7 frames)", flush=True)
        elif "Frame " in line and ("match" in line or "MATCH" in line):
            # "Frame 3 (17.1s): MATCH (fz=86% sem=86%) ocr=..." -> "frame 4/7 (17.1s): MATCH"
            m = re.match(r"\s*Frame (\d+) (\(.*?\)):\s+(.*)", line)
            if m:
                idx = int(m.group(1)) + 1
                print(f"{prefix} step 3/4: frame {idx}/7 {m.group(2)}: {m.group(3)[:70]}", flush=True)
        elif "Burned-in subs:" in line:
            print(f"{prefix} step 4/4: {line.split('] ')[-1]}", flush=True)
    proc.wait(timeout=300)

    full = "".join(captured)
    match = re.search(r"\[local\] Burned-in subs:\s+(yes|no)", full)
    if not match:
        return False, f"no [local] Burned-in line in output (tail: {full[-200:].strip()})"
    actual = match.group(1)
    if actual != expected:
        return False, f"expected={expected} actual={actual}"
    return True, f"actual={actual}"


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    print(f"Burned-in detection regression test - {len(CASES)} cases", flush=True)

    failed = 0
    total = len(CASES)
    for i, (video_id, title, expected) in enumerate(CASES, 1):
        print(f"\n[{i}/{total} {video_id}] starting - {title[:40]} (expect {expected})", flush=True)
        ok, detail = run_case(i, total, video_id, expected)
        if ok:
            print(f"[{i}/{total} {video_id}] PASS - {detail}", flush=True)
        else:
            print(f"[{i}/{total} {video_id}] FAIL - {detail}", flush=True)
            failed += 1

    # Final line - what the status bar shows after script exit
    if failed:
        print(f"\nDone: {len(CASES) - failed}/{len(CASES)} passed, {failed} failed", flush=True)
        sys.exit(1)
    print(f"\nDone: {len(CASES)}/{len(CASES)} passed", flush=True)


if __name__ == "__main__":
    main()
