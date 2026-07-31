"""
Catch references to identifiers that no longer exist.

`vite build` does not. It treats an unknown identifier as a possible global, so
this compiles and ships clean:

    player.on('seeked', functionIDeletedAnHourAgo);

and then throws at runtime — usually inside a try/catch that degrades quietly.
That exact mistake shipped three times in one day: a deleted `let preparing`
whose assignment remained (all playback broken), a `.default` unwrapped twice
(every ASS release silently downgraded to WebVTT), and a renamed
`repaintJassub` (same silent downgrade). None was caught by a build or by a
green test suite.

`svelte-check` catches all three — it type-checks the script blocks, where
`vite build` only transforms them.

Ratchet, not a clean gate: the frontend carries pre-existing type noise in
components unrelated to this (sort comparators typed `0 | 1 | -1`, svelte-select
props, an SVG bound to an HTMLDivElement). Those are worth fixing, but blocking
on them today would mean either fixing untested components at speed or ignoring
the check entirely — and a check that always reports errors is one nobody reads.
So this fails only when the count *rises*. Lower BASELINE as they get fixed;
never raise it to make a failure go away.

Usage:
  py -3.13 -u tools/tests/test_svelte_check.py
"""
import re
import subprocess
import sys
from pathlib import Path

FRONTEND = Path(__file__).resolve().parent.parent.parent / "frontend"
BASELINE = 10


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print("[1/1 svelte-check] type-checking .svelte script blocks", flush=True)

    try:
        r = subprocess.run(
            ["npx", "svelte-check", "--threshold", "error", "--output", "human"],
            cwd=FRONTEND, capture_output=True, text=True, timeout=600, shell=True,
            # svelte-check echoes source lines, and this codebase's comments are
            # UTF-8. Without this, Python decodes them with the Windows ANSI
            # codepage, one un-mappable byte kills the reader thread, and stdout
            # arrives as None — which fails the gate for a reason that has
            # nothing to do with types.
            encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        print("[1/1 svelte-check] FAIL — timed out after 600s", flush=True)
        return 1

    out = re.sub(r"\x1b\[[0-9;]*m", "", (r.stdout or "") + (r.stderr or ""))
    m = re.search(r"svelte-check found (\d+) error", out)
    if not m:
        print(f"[1/1 svelte-check] FAIL — could not parse output:\n{out[-600:]}", flush=True)
        return 1

    found = int(m.group(1))
    if found > BASELINE:
        print(f"[1/1 svelte-check] FAIL — {found} errors, baseline is {BASELINE}. "
              f"New type errors were introduced:", flush=True)
        for line in out.splitlines():
            if "Error:" in line or re.search(r"\.(svelte|ts):\d+", line):
                print(f"    {line.strip()}", flush=True)
        print("\nsvelte-check: FAILED — DO NOT deploy", flush=True)
        return 1

    note = "" if found == BASELINE else f" (down from {BASELINE} — lower BASELINE)"
    print(f"[1/1 svelte-check] PASS — {found} errors, at or below baseline{note}", flush=True)
    print(f"svelte-check: {found}/{BASELINE} known errors — OK", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
