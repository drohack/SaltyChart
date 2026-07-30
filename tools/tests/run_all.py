"""
Pre-deploy test runner.

Runs every check in dependency order, stops on first failure, and prints
self-contained progress so the status bar shows where we are at any moment:
  [3/5 pre-deploy] running test_api_smoke.py ...

Usage:
  py -3.13 -u tools/tests/run_all.py [--skip-burned-in]

Exits 0 if all green ("ready to build"), 1 on first failure.

Prerequisites:
  - Backend running at http://localhost:3000 (npm run dev in backend/)
  - Frontend running at http://localhost:5173 (Vite strictPort=true)
  - Burned-in test additionally needs CUDA GPU; skip with --skip-burned-in
"""
import argparse
import concurrent.futures
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TESTS = REPO / "tools" / "tests"


def step(n: int, total: int, msg: str) -> None:
    print(f"[{n}/{total} pre-deploy] {msg}", flush=True)


def _capture(label: str, cmd: list[str], cwd: Path | None, timeout: int,
             env_extra: dict | None = None) -> tuple[bool, float, str]:
    """Run a command and capture all output. Returns (ok, elapsed, output).
    Used for parallel runs where we can't stream output (would interleave)."""
    import os
    env = {**os.environ, **(env_extra or {}), "PYTHONUNBUFFERED": "1"}
    use_shell = sys.platform == "win32" and cmd[0] in ("npm", "npx")
    spawn_cmd: list[str] | str = " ".join(f'"{a}"' if " " in a else a for a in cmd) if use_shell else cmd
    t0 = time.time()
    try:
        proc = subprocess.run(
            spawn_cmd, cwd=cwd or REPO, env=env, shell=use_shell,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as e:
        return False, time.time() - t0, f"TIMEOUT after {timeout}s\n{e.stdout or ''}"
    elapsed = time.time() - t0
    return proc.returncode == 0, elapsed, (proc.stdout or "") + (proc.stderr or "")


def run(n: int, total: int, label: str, cmd: list[str], cwd: Path | None = None,
        timeout: int = 300, env_extra: dict | None = None) -> bool:
    """Run a subprocess, streaming its stdout through with a prefix.
    Returns True if exit code 0."""
    step(n, total, f"running {label} ...")
    import os
    env = {**os.environ, **(env_extra or {}), "PYTHONUNBUFFERED": "1"}
    t0 = time.time()
    # On Windows, npm/npx are .cmd shims — Popen with a list fails to find them
    # unless shell=True. Convert the list to a properly-quoted string.
    use_shell = sys.platform == "win32" and cmd[0] in ("npm", "npx")
    spawn_cmd: list[str] | str = " ".join(f'"{a}"' if " " in a else a for a in cmd) if use_shell else cmd
    proc = subprocess.Popen(
        spawn_cmd, cwd=cwd or REPO, env=env, shell=use_shell,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    for line in proc.stdout:
        # Already-progress lines from child are well-formed (have their own
        # prefix). Pass through verbatim so the status bar sees them.
        sys.stdout.write(line)
        sys.stdout.flush()
    proc.wait(timeout=timeout)
    elapsed = time.time() - t0
    if proc.returncode != 0:
        step(n, total, f"FAIL — {label} exit {proc.returncode} after {elapsed:.1f}s")
        return False
    step(n, total, f"PASS — {label} ({elapsed:.1f}s)")
    return True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-burned-in", action="store_true",
                        help="Skip the GPU-heavy burned-in detection test")
    parser.add_argument("--frontend", default="http://localhost:5173",
                        help="Frontend URL (Vite strictPort=true → always 5173)")
    parser.add_argument("--backend", default="http://localhost:3000")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    # Steps 1-7: mutually independent, run in parallel (no shared browser state)
    parallel_checks: list[tuple[str, list[str], Path | None, int]] = [
        ("backend tsc",      ["npx", "tsc", "--noEmit"],     REPO / "backend",  60),
        ("frontend build",   ["npm", "run", "build"],         REPO / "frontend", 60),
        ("season lookahead", ["py", "-3.13", "-u", str(TESTS / "test_season_lookahead.py")], None, 10),
        ("API smoke",        ["py", "-3.13", "-u", str(TESTS / "test_api_smoke.py"),
                              "--backend", args.backend],     None, 60),
        ("API negative",     ["py", "-3.13", "-u", str(TESTS / "test_api_negative.py"),
                              "--backend", args.backend],     None, 30),
        ("Jellyfin API",     ["py", "-3.13", "-u", str(TESTS / "test_jellyfin.py"),
                              "--backend", args.backend],     None, 180),
        ("title match",      ["npm", "run", "test:unit"],     REPO / "backend",  60),
        # `vite build` does not type-check .svelte script blocks, so a reference
        # to a deleted identifier compiles and ships. This is the only check
        # that catches it.
        ("svelte-check",     ["py", "-3.13", "-u", str(TESTS / "test_svelte_check.py")], None, 600),
    ]
    # Steps 8-10 (+11): use the browser via Playwright. Run sequentially so they
    # don't fight over the dev server or share stale state.
    sequential_checks: list[tuple[str, list[str], Path | None, int]] = [
        ("frontend smoke",  ["py", "-3.13", "-u", str(TESTS / "test_frontend_smoke.py"),
                             "--frontend", args.frontend],     None, 120),
        ("UI interactions", ["py", "-3.13", "-u", str(TESTS / "test_ui_interactions.py"),
                             "--backend", args.backend, "--frontend", args.frontend], None, 180),
        ("subtitle paths",  ["py", "-3.13", "-u", str(TESTS / "test_subtitle_paths.py"),
                             "--backend", args.backend, "--frontend", args.frontend], None, 120),
        ("Jellyfin player", ["py", "-3.13", "-u", str(TESTS / "test_player.py"),
                             "--backend", args.backend, "--frontend", args.frontend], None, 300),
    ]
    if not args.skip_burned_in:
        sequential_checks.append(("burned-in detection",
                                  ["py", "-3.13", "-u", str(TESTS / "test_burned_in_detection.py")],
                                  None, 300))

    total = len(parallel_checks) + len(sequential_checks)
    print(f"Pre-deploy suite — {total} checks", flush=True)
    print(f"  backend={args.backend} frontend={args.frontend}\n", flush=True)

    # ── Parallel phase ────────────────────────────────────────────────────────
    n_parallel = len(parallel_checks)
    print(f"[parallel 1-{n_parallel}/{total}] running {n_parallel} independent checks concurrently...", flush=True)
    t0 = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=n_parallel) as ex:
        futures = {ex.submit(_capture, lbl, cmd, cwd, to): (lbl, i)
                   for i, (lbl, cmd, cwd, to) in enumerate(parallel_checks, 1)}
        results: dict[int, tuple[str, bool, float, str]] = {}
        for f in concurrent.futures.as_completed(futures):
            label, i = futures[f]
            ok, elapsed, output = f.result()
            results[i] = (label, ok, elapsed, output)

    # Print results in deterministic order (i=1..N) so output is readable
    any_failed = False
    for i in sorted(results):
        label, ok, elapsed, output = results[i]
        if ok:
            print(f"[{i}/{total} pre-deploy] PASS — {label} ({elapsed:.1f}s)", flush=True)
        else:
            print(f"[{i}/{total} pre-deploy] FAIL — {label} after {elapsed:.1f}s", flush=True)
            # Tail the failure output for debugging
            tail = "\n".join(output.splitlines()[-30:])
            print(f"--- output tail for {label} ---", flush=True)
            print(tail, flush=True)
            print("--- end ---", flush=True)
            any_failed = True
    parallel_elapsed = time.time() - t0
    print(f"[parallel] completed in {parallel_elapsed:.1f}s\n", flush=True)
    if any_failed:
        print(f"Pre-deploy: FAILED in parallel phase — DO NOT deploy", flush=True)
        sys.exit(1)

    # ── Sequential phase ──────────────────────────────────────────────────────
    for j, (label, cmd, cwd, to) in enumerate(sequential_checks, 1):
        step_n = n_parallel + j
        if not run(step_n, total, label, cmd, cwd=cwd, timeout=to):
            print(f"\nPre-deploy: FAILED at step {step_n} ({label}) — DO NOT deploy", flush=True)
            sys.exit(1)

    print(f"\nPre-deploy: {total}/{total} passed — ready to build", flush=True)


if __name__ == "__main__":
    main()
