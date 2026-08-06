"""Warm the season cache before a test run.

Why this exists: the suite reads season data from `/api/anime`, which is backed
by AniList - 30 req/min per IP, shared by the whole network, with a one-minute
lockout when exceeded. A cold key costs 3 GraphQL pages, and the seasons a run
touches expire together, so a run starting cold fires them all at once.

That figure used to be 100, not 3, and it is why warming looked broken for so
long. `Page.pageInfo` reports an unfiltered capped total for this query
(`total: 5000, lastPage: 100` on a season holding ~113 entries), the backend
believed it, and one refresh cost 100 requests. Six keys is ~600 requests
against a 30/min budget, so warming could not finish inside the limit no matter
how it was written. Fixed in routes/anime.ts by paging until a short page; if
that ever regresses, this file's job becomes impossible again and the symptom
will look like a warming bug rather than a paging one.

The backend survives a restart without refetching, so warming once at the start
carries a whole run - including a mutation audit, which restarts the backend
dozens of times. Restarts are not what drives upstream load; a stale row is.
A run must never provoke a live AniList 429 - the 429/backoff logic is
unit-tested in anilistRateLimit, off the network.

Both format variants are warmed for each season, because `format=TV` is a
*separate cache key* from no-format: Home's leftovers call uses one and its
main call the other, so warming only one leaves half the run cold.

A key that cannot be warmed is a reason to STOP: warm_one retries - honouring
Retry-After, up to PER_KEY_BUDGET_S per key - and both runners refuse to start
on a failure, because a missing season doesn't fail the suite, it makes it
pass vacuously (every fixture joins against an empty list). That has happened
here once already.

Usable directly:  py -3.13 -u tools/tests/warm_cache.py
"""
from __future__ import annotations

import argparse
import os
import pathlib
import sqlite3
import sys
import time
from datetime import date

import requests

SEASONS = ("WINTER", "SPRING", "SUMMER", "FALL")

#: Mirror of SEASON_TTL_SECONDS in backend/src/routes/anime.ts. Move both.
SEASON_TTL_S = 6 * 60 * 60

#: A key has to stay fresh for the whole run, not just its first minute. The
#: audit measures ~19 min and run_all ~15; this leaves generous room so a key
#: that would expire mid-run is refreshed now, while the run can afford it.
RUN_HEADROOM_S = 90 * 60

#: How long to wait for a background refresh we just triggered to land.
REFRESH_WAIT_S = 150


def _db_path() -> pathlib.Path | None:
    """The SQLite file the backend is using, or None if it can't be located."""
    url = os.environ.get("DATABASE_URL", "")
    if url.startswith("file:"):
        p = pathlib.Path(url[5:])
        if not p.is_absolute():
            p = pathlib.Path(__file__).resolve().parents[2] / "backend" / p
        if p.exists():
            return p
    # The documented local location (CLAUDE.md: the real DB is nested).
    p = pathlib.Path(__file__).resolve().parents[2] / "backend/prisma/prisma/data.db"
    return p if p.exists() else None


def row_stamp(season: str, year: int, fmt: str) -> tuple[str, float] | None:
    """`(updatedAt, age_seconds)` for one season key, or None if unreadable.

    Read directly, because the API cannot answer this question: `/api/anime`
    serves an expired row instantly while refreshing behind it, so a 200 in
    40 ms means "a row exists", NOT "the row is fresh". Timing the response was
    exactly how this warmer reported six keys "already warm in 0.0s" while two
    of them were 27 h past a 6 h TTL, leaving every one of the audit's ~150
    backend restarts to re-fire their background refresh into AniList's shared
    30/min budget. Measured on that run: 219 live 429s.
    """
    db = _db_path()
    if not db:
        return None
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=2)
        try:
            row = con.execute(
                "SELECT updatedAt, strftime('%s','now') - strftime('%s',updatedAt) "
                'FROM "SeasonCache" WHERE season=? AND year=? AND format=?',
                (season, year, fmt),
            ).fetchone()
        finally:
            con.close()
    except Exception:
        return None
    return (row[0], float(row[1])) if row else None


def _is_expired(age: float) -> bool:
    """Would the BACKEND call this row stale?

    This has to be the backend's own question, not ours. Asking a stricter one
    was a bug: warming demanded that every key stay fresh for the whole run
    (age + headroom < TTL), but `/api/anime` only refreshes a row once it is
    genuinely past the TTL. A key at 5.2 h of a 6 h TTL therefore satisfied
    neither side - we refused to accept it, and no GET would ever refresh it,
    so warming sat waiting 8 minutes for an event that could not happen.
    """
    return age > SEASON_TTL_S


def _expires_during_run(age: float) -> bool:
    """Fresh now, stale before the run ends. Worth saying, not worth blocking on.

    There is no force-refresh path on the route, so nothing here can do
    anything about it. It is cheap now in a way it was not: one refresh is 3
    requests since the paging fix, rate-limited to one per key per minute, so a
    key expiring mid-run costs a trickle rather than a storm.
    """
    return not _is_expired(age) and age + RUN_HEADROOM_S > SEASON_TTL_S


def await_refresh(season: str, year: int, fmt: str, tag: str, label: str,
                  was: str | None, deadline: float) -> bool:
    """Wait for the background refresh the last GET triggered to actually land.

    Serving stale is the right behaviour for a viewer and the wrong thing to
    accept here: the point of warming is that nothing refreshes DURING the run.
    """
    stop = min(time.time() + REFRESH_WAIT_S, deadline)
    while time.time() < stop:
        time.sleep(2)
        now = row_stamp(season, year, fmt)
        if now and now[0] != was:
            print(f"[{tag}] {label}: refresh landed, now {now[1]:.0f}s old", flush=True)
            return True
    return False


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
    an empty season doesn't fail, it *passes vacuously* - every assertion joins
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

    stamp = row_stamp(s, y, fmt)
    if stamp is None and _db_path() is None:
        print(f"[{tag}] {label}: WARNING cannot read SeasonCache; falling back to "
              f"'a 200 means warm', which cannot see a stale row", flush=True)
    elif stamp and not _is_expired(stamp[1]):
        note = ""
        if _expires_during_run(stamp[1]):
            note = (f" - NOTE it expires in {(SEASON_TTL_S - stamp[1]) / 60:.0f} min, "
                    f"so a long run will refresh it once (3 requests)")
        print(f"[{tag}] {label}: fresh ({stamp[1] / 3600:.1f}h old), "
              f"no upstream call needed{note}", flush=True)
        return True

    while True:
        attempt += 1
        t0 = time.time()
        was = stamp[0] if stamp else None
        try:
            r = requests.get(url, timeout=timeout)
            dt = time.time() - t0
            if r.status_code == 200:
                n = len(r.json())
                stamp = row_stamp(s, y, fmt)
                if stamp is None or not _is_expired(stamp[1]):
                    # None = we can't read the DB; the 200 is all we have.
                    age = f"{stamp[1]:.0f}s old" if stamp else "age unknown"
                    print(f"[{tag}] {label}: {n} entries, warm ({age}) in {dt:.1f}s",
                          flush=True)
                    return True
                # A 200 carrying a STALE row: the route served the expired copy
                # instantly and kicked off a refresh behind it. Warming is not
                # done until that refresh lands, or the run pays for it later,
                # once per backend restart.
                print(f"[{tag}] {label}: served stale ({stamp[1] / 3600:.1f}h old), "
                      f"waiting for the refresh it triggered", flush=True)
                if await_refresh(s, y, fmt, tag, label, was, deadline):
                    return True
                # Fall through to the retry wait below. Deliberately NOT the
                # `Retry-After` path: a 200 carries no such header, and reading
                # one off it would silently mean 60 s every time.
                why, wait = "refresh did not land", 30
            else:
                # 503 is the backend saying AniList is rate-limiting *us* - not
                # that the backend is broken. It carries the wait AniList asked
                # for.
                wait = int(r.headers.get("Retry-After") or 60)
                why = ("AniList rate-limited" if r.status_code == 503
                       else f"HTTP {r.status_code}")
        except Exception as exc:
            wait, why = 30, type(exc).__name__

        left = deadline - time.time()
        if left <= wait:
            # Report what actually elapsed and how many tries it took, not the
            # configured budget - the budget is what we were willing to spend,
            # which is not the useful number when reading a failure.
            print(f"[{tag}] {label}: {why} - gave up after {attempt} attempt(s) "
                  f"over {time.time() - started:.0f}s", flush=True)
            return False
        # Count the wait down rather than sleeping silently. The status bar shows
        # only the newest line, so a single "waiting 60s" sits there for a full
        # minute looking like a hang - and reads as "the run is stuck on 429s"
        # when it is in fact doing exactly the right thing.
        print(f"[{tag}] {label}: {why}, attempt {attempt} - waiting {wait}s "
              f"({left / 60:.0f} min left before giving up)", flush=True)
        remaining = wait
        while remaining > 0:
            nap = min(10, remaining)
            time.sleep(nap)
            remaining -= nap
            if remaining > 0:
                print(f"[{tag}] {label}: {why} - retrying in {remaining}s "
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
    print(f"Done: season cache warm - {warmed} ready, {failed} failed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
