"""
Pre-deploy smoke test: the rate limiters actually limit.

Every limiter in this codebase carries `skip: () => _isDev`, and the dev server
runs without NODE_ENV - so in the environment the rest of this suite exercises,
not one of them is ever consulted. A limiter could be misconfigured to `max: 1`
(locking everyone out) or effectively disabled, and all 13 other checks would
still be green.

So this boots a *second* backend in production mode on a spare port and hits it
until it complains. Production also fails fast on the publicly-known
'dev-secret', so a throwaway secret is supplied; nothing here touches the dev
server or the real database beyond reading it.

Usage:
  py -3.13 -u tools/tests/test_rate_limits.py [--port 3999]
"""
import argparse
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests

TOTAL = 3
REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"
# Mirrors `authLimiter` in backend/src/index.ts.
AUTH_MAX, WINDOW_S = 20, 60


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL} rate-limit] {msg}", flush=True)


def fail(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL} rate-limit] FAIL - {msg}", flush=True)
    print(f"\nRate limits: FAILED at step {n}", flush=True)
    sys.exit(1)


def skip_all(n: int, why: str) -> None:
    step(n, f"SKIP - {why}")
    print(f"Rate limits: skipped - {why}", flush=True)
    sys.exit(0)


def wait_for_health(base: str, proc: subprocess.Popen, timeout: float = 45.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            if requests.get(f"{base}/api/health", timeout=2).status_code == 200:
                return True
        except requests.RequestException:
            time.sleep(0.5)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3999)
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    base = f"http://127.0.0.1:{args.port}"
    print(f"Rate limit test - production-mode backend on :{args.port}", flush=True)

    step(1, "building and starting a production-mode backend")
    entry = BACKEND / "dist" / "index.js"
    if not entry.exists():
        build = subprocess.run(["npm", "run", "build"], cwd=BACKEND, capture_output=True,
                               text=True, timeout=300,
                               shell=sys.platform == "win32")
        if build.returncode != 0 or not entry.exists():
            skip_all(1, "backend/dist is not built and `npm run build` failed")

    # Its own database, never the dev one. This instance runs
    # `ensureDatabaseSchema()` at boot, and pointing a second backend at the
    # SQLite file the dev server is serving from is asking for lock contention
    # in the middle of everyone else's tests - which is exactly what it caused.
    scratch = Path(tempfile.gettempdir()) / f"saltychart-ratelimit-{os.getpid()}.db"
    env = {
        **os.environ,
        "NODE_ENV": "production",
        "PORT": str(args.port),
        "DATABASE_URL": f"file:{scratch.as_posix()}",
        # Production exits on the publicly-known default; this instance signs
        # nothing anyone keeps, so a throwaway is right.
        "JWT_SECRET": "rate-limit-test-secret-not-used-elsewhere",
    }
    proc = subprocess.Popen(["node", str(entry)], cwd=BACKEND, env=env,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        if not wait_for_health(base, proc):
            out = ""
            if proc.poll() is not None:
                out = (proc.stdout.read() or "")[-300:] if proc.stdout else ""
            skip_all(1, f"the production backend did not come up{': ' + out if out else ''}")
        step(1, "PASS - production backend healthy")

        step(2, f"exceeding the auth limiter ({AUTH_MAX}/min) on /api/auth/login")
        codes: list[int] = []
        limited = None
        for i in range(AUTH_MAX + 6):
            r = requests.post(f"{base}/api/auth/login", timeout=15,
                              json={"username": "rl_probe", "password": "wrong"})
            codes.append(r.status_code)
            if r.status_code == 429:
                limited = r
                break
        if limited is None:
            fail(2, f"never rate limited after {len(codes)} logins - the limiter is "
                    f"inert in production, so nothing throttles credential stuffing "
                    f"(statuses: {sorted(set(codes))})")
        # It must not trip so early that real users are locked out either.
        if len(codes) <= 3:
            fail(2, f"rate limited after only {len(codes)} requests - a real person "
                    f"signing in would be locked out")
        step(2, f"PASS - 429 after {len(codes)} attempts")

        step(3, "the 429 carries the documented error shape")
        body = {}
        try:
            body = limited.json()
        except ValueError:
            fail(3, f"429 body was not JSON: {limited.text[:120]!r}")
        if body.get("code") != "RATE_LIMITED":
            fail(3, f"expected code RATE_LIMITED, got {body!r}")
        if not body.get("error"):
            fail(3, f"429 carried no human-readable message: {body!r}")
        # The frontend reads `data.error`; the standard headers let a client back
        # off rather than hammer.
        if "ratelimit-limit" not in {k.lower() for k in limited.headers}:
            fail(3, "429 carried no RateLimit-* headers, so clients cannot back off")
        step(3, f"PASS - {body['code']}, {limited.headers.get('RateLimit-Limit')} per window")
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        for leftover in scratch.parent.glob(scratch.name + "*"):  # .db, -wal, -shm
            leftover.unlink(missing_ok=True)

    print(f"\nRate limits: {TOTAL}/{TOTAL} passed", flush=True)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except requests.RequestException as e:
        print(f"\nRate limits: FAIL - {e}", flush=True)
        sys.exit(1)
