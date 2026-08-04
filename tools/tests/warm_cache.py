"""Warm the season cache before a test run.

Why this exists: the suite reads season data from `/api/anime`, which is backed
by AniList — 30 req/min per IP, shared by the whole network, with a one-minute
lockout when exceeded. A cold key costs 8-12 GraphQL pages, and the seasons a
run touches expire together, so a run starting cold fires them all at once and
trips the limit before the first assertion.

The backend now survives a restart without refetching, so warming once at the
start is enough to carry a whole run — including a mutation audit, which
restarts the backend dozens of times. That "once" holds only while the run
fits inside the season-cache TTL (6 h, routes/anime.ts): the mutation audit
outgrew the old 1 h TTL silently as rows were added, and its final half hour
fired a stale background refresh per restart. A run must never provoke a live
AniList 429 — the 429/backoff logic is unit-tested in anilistRateLimit, off
the network.

Both format variants are warmed for each season, because `format=TV` is a
*separate cache key* from no-format: Home's leftovers call uses one and its
main call the other, so warming only one leaves half the run cold.

A key that cannot be warmed is a reason to STOP: warm_one retries — honouring
Retry-After, up to PER_KEY_BUDGET_S per key — and both runners refuse to start
on a failure, because a missing season doesn't fail the suite, it makes it
pass vacuously (every fixture joins against an empty list). That has happened
here once already.

Usable directly:  py -3.13 -u tools/tests/warm_cache.py
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import date

import requests

SEASONS = ("WINTER", "SPRING", "SUMMER", "FALL")


def season_keys(today: date | None = None) -> list[tuple[str, int]]:
    """The seasons a run can touch: previous, current and next.

    Tests pin the current calendar season; Home opens on the look-ahead
    (next) season and fetches the previous season's leftovers.
    """
    today = today or date.today()
    idx = (today.month - 1) // 3
    rank = today.year * 4 + idx
    out = []
    for r in (rank - 1, rank, rank + 1):
        out.append((SEASONS[r % 4], r // 4))
    return out


#: How long to keep waiting for one season before giving up on it. A 429
#: lockout is a minute, so this allows several in a row without waiting forever.
PER_KEY_BUDGET_S = 8 * 60


def warm_one(backend: str, s: str, y: int, fmt: str, tag: str, timeout: int = 240) -> bool:
    """Fetch one season key, waiting out rate limits rather than giving up.

    Continuing without the data is the worse failure: a suite that runs against
    an empty season doesn't fail, it *passes vacuously* — every assertion joins
    against nothing and reports success. That has already happened here once,
    when hardcoded fixture mediaIds aged out of the season.

    So this waits. `Retry-After` says how long, and a 429 lockout is only a
    minute, so waiting is cheap compared to a run that proves nothing.
    """
    url = f"{backend}/api/anime?season={s}&year={y}" + (f"&format={fmt}" if fmt else "")
    label = f"{s} {y} [{fmt or 'all'}]"
    started = time.time()
    deadline = started + PER_KEY_BUDGET_S
    attempt = 0

    while True:
        attempt += 1
        t0 = time.time()
        try:
            r = requests.get(url, timeout=timeout)
            dt = time.time() - t0
            if r.status_code == 200:
                # A cold fetch takes seconds, a warm one milliseconds. Saying
                # which makes an unexpectedly slow run explicable.
                how = "already warm" if dt < 0.5 else "fetched"
                print(f"[{tag}] {label}: {len(r.json())} entries, {how} in {dt:.1f}s",
                      flush=True)
                return True
            # 503 is the backend saying AniList is rate-limiting *us* — not that
            # the backend is broken. It carries the wait AniList asked for.
            wait = int(r.headers.get("Retry-After") or 60)
            why = "AniList rate-limited" if r.status_code == 503 else f"HTTP {r.status_code}"
        except Exception as exc:
            wait, why = 30, type(exc).__name__

        left = deadline - time.time()
        if left <= wait:
            # Report what actually elapsed and how many tries it took, not the
            # configured budget — the budget is what we were willing to spend,
            # which is not the useful number when reading a failure.
            print(f"[{tag}] {label}: {why} — gave up after {attempt} attempt(s) "
                  f"over {time.time() - started:.0f}s", flush=True)
            return False
        # Count the wait down rather than sleeping silently. The status bar shows
        # only the newest line, so a single "waiting 60s" sits there for a full
        # minute looking like a hang — and reads as "the run is stuck on 429s"
        # when it is in fact doing exactly the right thing.
        print(f"[{tag}] {label}: {why}, attempt {attempt} — waiting {wait}s "
              f"({left / 60:.0f} min left before giving up)", flush=True)
        remaining = wait
        while remaining > 0:
            nap = min(10, remaining)
            time.sleep(nap)
            remaining -= nap
            if remaining > 0:
                print(f"[{tag}] {label}: {why} — retrying in {remaining}s "
                      f"(attempt {attempt + 1})", flush=True)


def warm(backend: str = "http://localhost:3000", timeout: int = 240) -> tuple[int, int]:
    """GET every season key the suite uses. Returns (warmed, failed)."""
    keys = [(s, y, fmt) for s, y in season_keys() for fmt in ("", "TV")]
    warmed = failed = 0
    for n, (s, y, fmt) in enumerate(keys, 1):
        # "pre-deploy warm" on purpose: this runs *before* step 1, and the status
        # bar shows a single line with no surrounding context. Tagged only
        # `warm n/N`, a 429 retry here reads as the suite itself failing on
        # AniList rather than as pre-flight doing its job.
        if warm_one(backend, s, y, fmt, f"pre-deploy warm {n}/{len(keys)}", timeout):
            warmed += 1
        else:
            failed += 1
    return warmed, failed


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="http://localhost:3000")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    warmed, failed = warm(args.backend)
    print(f"Done: season cache warm — {warmed} ready, {failed} failed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
