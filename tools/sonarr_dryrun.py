"""
What would the Sonarr Custom List actually do, if we turned it on?

Read-only. This script never writes to Sonarr, never adds a series, and never
asks the backend to fetch anything from AniList. It exists so the list can be
reviewed and argued with *before* Sonarr is ever pointed at the URL - the Sonarr
docs are blunt about the alternative ("If lists are done improperly they will
absolutely wreck your library").

Two views, because they answer different questions:

  1. "As if we had nothing"  (no credentials needed)
     Every series the list currently proposes, and - the part that makes it
     reviewable - **which gate each excluded entry died at**. "39 proposed" tells
     you nothing; "66 dropped on format, 50 on a PREQUEL/PARENT edge, 37 outside
     the air window" tells you whether the filter is doing what you think.

  2. "Against what we already hold"  (no credentials, and the default)
     The same list diffed by tvdbId against the **library the backend has
     already cached** (`AppConfig.jellyfinLibrary`), into: already held - Sonarr
     would say "Rejected, series exists in database" and do nothing - and would
     be added, which is the real blast radius of turning the list on.

     Read-only, off the request path, and it needs nothing this machine doesn't
     already have. **Caveat:** the library is what is on disk. Sonarr can also
     be monitoring a series it has not downloaded yet, and that shows up here as
     "would be added" when Sonarr would in fact reject it - so this over-states
     the blast radius rather than under-stating it, which is the safe direction.
     Pass --sonarr-url and --api-key to ask Sonarr itself instead, when the
     difference matters.

The reject breakdown comes from `GET /api/sonarr/list?explain=1`, i.e. from the
shipping filter itself. Reimplementing the predicates in Python would be a second
copy that drifts, and would eventually describe a program we don't ship - the
mistake `check_match_corpus.py` was built to avoid.

**`/admin/sonarr` is the richer view** and is where you should normally look: it
adds what Sonarr actually holds and excludes, the suppression list, and orphan
detection. This script survives because it needs no browser, no login and no
Sonarr credentials - useful from a terminal, and the only view that still works
when you have not configured Sonarr at all. Both read the *same* `assemble()` in
`routes/sonarr.ts`, so the proposal side cannot drift between them; only the
comparison differs (this diffs against the cached Jellyfin library, the page
against Sonarr itself).

**Credentials** are read from the command line or the environment
(`SONARR_URL`, `SONARR_API_KEY`) and are never written anywhere. Do not put a key
in a file in this repo: it is public.

Usage:
  py -3.13 -u tools/sonarr_dryrun.py
  py -3.13 -u tools/sonarr_dryrun.py --season SUMMER --year 2026
  py -3.13 -u tools/sonarr_dryrun.py --sonarr-url http://192.168.1.2:8989 --api-key ...
  py -3.13 -u tools/sonarr_dryrun.py --json          # machine-readable dump

Exit codes: 0 on a successful dry run, 1 if the backend or Sonarr can't be
reached or answers unusably.
"""
import argparse
import json
import os
import sys
from pathlib import Path

import requests

# Measured 2026-08-04 against the live Anime library (23,631 episodes; random
# 500-episode sample): median 0.38 GB, mean 0.58, p90 1.35. The median is used
# for the headline and p90 for the "could be as much as" figure, because the
# distribution has a long tail and the mean hides it.
GB_PER_EPISODE_MEDIAN = 0.38
GB_PER_EPISODE_P90 = 1.35
# AniList leaves `episodes` null for plenty of not-yet-aired entries. One cour
# is the honest stand-in; it is labelled as an assumption in the output rather
# than folded silently into the total.
ASSUMED_EPISODES = 12

REASON_LABEL = {
    "malformed": "malformed cache row",
    "format": "not TV / TV_SHORT",
    "adult": "isAdult",
    "notFirstSeason": "has a PREQUEL/PARENT edge (not a first season)",
    "outsideAirWindow": "outside the air window",
    "noAnilistId": "no usable AniList id",
    "noUsableTvdbId": "no usable TVDB id (unmapped, pending or rejected)",
    "duplicateTvdbId": "duplicate TVDB id (deduped)",
    "noTitle": "no usable title",
}


def say(msg: str = "") -> None:
    print(msg, flush=True)


def size_estimate(proposed: list[dict]) -> tuple[float, float, int]:
    """(median GB, p90 GB, how many rows had to assume an episode count)."""
    total_eps = 0
    assumed = 0
    for p in proposed:
        eps = p.get("episodes")
        if not isinstance(eps, int) or eps <= 0:
            eps = ASSUMED_EPISODES
            assumed += 1
        total_eps += eps
    return total_eps * GB_PER_EPISODE_MEDIAN, total_eps * GB_PER_EPISODE_P90, assumed


def fetch_explain(backend: str, season: str | None, year: int | None) -> dict:
    params: dict = {"explain": "1"}
    if season and year:
        params.update(season=season, year=year)
    r = requests.get(f"{backend}/api/sonarr/list", params=params, timeout=120)
    if r.status_code == 503:
        say("The backend is refusing: identity data has not loaded yet (503).")
        say("That is the endpoint behaving correctly - wait a few seconds and retry.")
        sys.exit(1)
    if r.status_code != 200:
        say(f"Backend returned {r.status_code}: {r.text[:300]}")
        sys.exit(1)
    return r.json()


def cached_library() -> dict[int, str] | None:
    """tvdbId -> title for every series the backend has cached, or None.

    Read-only URI open on purpose: the dev server owns this DB and a plain
    connect would contend with its writes. Same convention as
    `tools/tests/test_jellyfin.py` (the nested prisma/prisma path is real).
    """
    import sqlite3
    db = (Path(__file__).resolve().parents[1]
          / "backend" / "prisma" / "prisma" / "data.db")
    try:
        con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
    except sqlite3.OperationalError:
        return None
    try:
        row = con.execute(
            "SELECT value FROM AppConfig WHERE key='jellyfinLibrary'").fetchone()
    finally:
        con.close()
    if not row or not row[0]:
        return None
    try:
        blob = json.loads(row[0])
    except ValueError:
        return None
    # The blob is {series: [...], total: n}. Reading the wrong key yields an
    # empty set, which silently reports every proposed series as a new grab -
    # so an unexpected shape is None ("can't tell"), never an empty answer.
    series = blob.get("series") if isinstance(blob, dict) else None
    if not isinstance(series, list) or not series:
        return None
    out: dict[int, str] = {}
    for s in series:
        tid = s.get("tvdbId")
        try:
            tid = int(tid)
        except (TypeError, ValueError):
            continue
        if tid > 0:
            out[tid] = s.get("title") or "?"
    return out or None


def fetch_sonarr_series(url: str, api_key: str) -> list[dict]:
    r = requests.get(f"{url.rstrip('/')}/api/v3/series",
                     headers={"X-Api-Key": api_key}, timeout=120)
    if r.status_code == 401:
        say("Sonarr rejected the API key (401).")
        sys.exit(1)
    if r.status_code != 200:
        say(f"Sonarr returned {r.status_code}: {r.text[:300]}")
        sys.exit(1)
    body = r.json()
    if not isinstance(body, list):
        say(f"Sonarr /api/v3/series did not return a list: {type(body).__name__}")
        sys.exit(1)
    return body


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="http://localhost:3000")
    ap.add_argument("--season", help="pin a season, e.g. SUMMER (needs --year)")
    ap.add_argument("--year", type=int, help="pin a year (needs --season)")
    ap.add_argument("--sonarr-url", default=os.environ.get("SONARR_URL"),
                    help="e.g. http://192.168.1.2:8989 (or $SONARR_URL)")
    ap.add_argument("--api-key", default=os.environ.get("SONARR_API_KEY"),
                    help="Sonarr API key (or $SONARR_API_KEY). Read-only calls only.")
    ap.add_argument("--json", action="store_true", help="dump the raw result and exit")
    ap.add_argument("--limit", type=int, default=0,
                    help="show only the first N rows per section (0 = all)")
    args = ap.parse_args()

    if bool(args.season) != bool(args.year):
        ap.error("--season and --year must be given together")

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    steps = 4

    say(f"[1/{steps}] asking {args.backend} what the list proposes")
    data = fetch_explain(args.backend.rstrip("/"), args.season, args.year)
    proposed = data.get("proposed") or []
    rejected = data.get("rejected") or []
    seasons = data.get("seasons") or []

    if args.json:
        json.dump(data, sys.stdout, indent=2, ensure_ascii=False)
        say()
        return 0

    scope = ", ".join(f"{s['season']} {s['year']} ({s['cached']} cached)" for s in seasons)
    say(f"        scope: {scope or 'nothing cached'}; "
        f"air window {data.get('withinDays')} days")

    # ---------------- View 1: as if we had nothing ----------------
    say(f"[2/{steps}] view 1 - as if Sonarr held nothing")
    med, p90, assumed = size_estimate(proposed)
    say(f"        {len(proposed)} series would be proposed")
    say(f"        ~{med:,.0f} GB at the median episode size "
        f"(~{p90:,.0f} GB if every one lands at p90)")
    if assumed:
        say(f"        NOTE: {assumed} of them have no episode count yet; "
            f"assumed {ASSUMED_EPISODES} each")

    shown = proposed if not args.limit else proposed[: args.limit]
    for p in shown:
        d = p.get("startDate") or {}
        when = (f"{d.get('year')}-{d.get('month') or '??'}-{d.get('day') or '??'}"
                if d.get("year") else "no date")
        say(f"          {p['tvdbId']:>8}  {p['title'][:52]:<52} "
            f"{p.get('format') or '?':<9} {p.get('status') or '?':<16} {when}")
    if args.limit and len(proposed) > args.limit:
        say(f"          ... {len(proposed) - args.limit} more (use --limit 0 for all)")

    say(f"[3/{steps}] why the other {len(rejected)} entries were excluded")
    counts = (data.get("counts") or {}).get("rejected") or {}
    for reason, n in sorted(counts.items(), key=lambda kv: -kv[1]):
        say(f"          {n:>4}  {REASON_LABEL.get(reason, reason)}")
    # The two worth eyeballing by name: an over-eager scope filter and a
    # coverage gap are both invisible in a count.
    for reason in ("notFirstSeason", "noUsableTvdbId"):
        named = [r for r in rejected if r.get("reason") == reason]
        if not named:
            continue
        cap = args.limit or 8
        say(f"        {REASON_LABEL[reason]} - first {min(cap, len(named))}:")
        for r in named[:cap]:
            say(f"          {(r.get('title') or '?')[:66]}")

    # ---------------- View 2: what do we already have ----------------
    say(f"[4/{steps}] view 2 - what we already hold")
    if args.sonarr_url and args.api_key:
        series = fetch_sonarr_series(args.sonarr_url, args.api_key)
        held = {}
        for s in series:
            tid = s.get("tvdbId")
            if isinstance(tid, int) and tid > 0:
                held[tid] = s.get("title") or "?"
        source = f"Sonarr ({len(series)} series, {len(held)} with a TVDB id)"
    else:
        held = cached_library()
        if held is None:
            say("        could not read the cached library from the backend DB, and no")
            say("        --sonarr-url/--api-key given - skipping the comparison rather")
            say("        than reporting every series as a new grab")
            say("")
            say(f"Dry run: {len(proposed)} proposed, {len(rejected)} excluded, ~{med:,.0f} GB")
            return 0
        source = (f"the backend's cached Jellyfin library ({len(held)} series with a "
                  f"TVDB id; monitored-but-not-downloaded reads as 'would be added')")
    say(f"        source: {source}")

    already = [p for p in proposed if p["tvdbId"] in held]
    would_add = [p for p in proposed if p["tvdbId"] not in held]
    add_med, add_p90, add_assumed = size_estimate(would_add)


    for p in (already if not args.limit else already[: args.limit]):
        say(f"          {p['tvdbId']:>8}  {p['title'][:40]:<40} -> "
            f"held as {held[p['tvdbId']][:34]!r}")
    say(f"        WOULD BE ADDED                      : {len(would_add)}  "
        f"(~{add_med:,.0f} GB, up to ~{add_p90:,.0f} GB)")
    for p in (would_add if not args.limit else would_add[: args.limit]):
        eps = p.get("episodes")
        say(f"          {p['tvdbId']:>8}  {p['title'][:52]:<52} "
            f"{eps if isinstance(eps, int) else '?'} eps")
    if add_assumed:
        say(f"          NOTE: {add_assumed} with no episode count; "
            f"assumed {ASSUMED_EPISODES} each")

    # Informational only: nothing removes anything, because the Sonarr list is
    # configured with Clean Library Level Disabled. It is here because a filter
    # that is too aggressive shows up as a series we hold and would never
    # propose.
    ours = {p["tvdbId"] for p in proposed}
    say(f"        held but not on our list            : "
        f"{len([t for t in held if t not in ours])} "
        f"(informational - the list never removes anything)")

    say("")
    say(f"Dry run: {len(proposed)} proposed, {len(already)} already held, "
        f"{len(would_add)} would be ADDED (~{add_med:,.0f} GB), "
        f"{len(rejected)} excluded")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except requests.RequestException as e:
        print(f"\nDry run: FAIL - could not reach a service: {e}", flush=True)
        sys.exit(1)
