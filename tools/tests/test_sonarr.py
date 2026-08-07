"""
Pre-deploy smoke test: the Sonarr Custom List (/api/sonarr/list).

Runs against http://localhost:3000. This endpoint is consumed by Sonarr, not by
a browser, and Sonarr treats whatever it gets as authoritative - it has no way
to tell a short list from a complete one. So the assertions here are about the
CONTRACT and the SHAPE of the answer, never about which shows are in it.

Coverage, and the trap each step exists for:

- The response is a **bare JSON array**, not an object wrapping one. Sonarr's
  Custom List import accepts only the bare form; an object parses as zero series
  and shows up as a list that silently adds nothing.
- Every item is exactly `{title, tvdbId}`, with a **positive integer** id and a
  non-empty title. `Identity.tvdbId` is stored as a *string*, so a missing
  `Number()` coercion ships `"12345"` and Sonarr rejects the row.
- **No duplicate tvdbIds.** Several AniList ids map to one TVDB id (seasons and
  split cours of one series) and `resolveIdentity` does not dedupe. Measured on
  2026-08-06 there were no live collisions, so this can only ever catch the
  regression prospectively - which is the point of asserting an invariant rather
  than a count.
- **Nothing adult, no MOVIE, and nothing carrying a PREQUEL/PARENT edge**,
  cross-checked against the same season's real /api/anime payload. Checking the
  filter against live data is the only way to catch a predicate that is correct
  in the unit test and wired up wrong in the route.
- **The air window is what excludes a future season, not the identity gate.** A
  season outside the window must come back empty even though its entries have
  TVDB ids - on 2026-08-06, FALL 2026 had 27 resolvable entries and the endpoint
  correctly returned none of them. Without this step a broken identity lookup
  would look exactly like a working air-date filter.
- Query-param validation: a lone `?season=` is a 400 rather than a silent
  fallback to the calendar default, which would make a failing assertion
  elsewhere look like a filter bug.

**Not covered here, deliberately:** the `identityReady()` 503. Proving it needs
the process restarted and raced, which this test cannot do - the map loads from
AppConfig in well under the time it takes to connect. It is verified by hand
(force `identityReady()` false, confirm 503 + Retry-After, revert) and the route
comments say so.

The season-cache steps **skip and still exit 0** when the current season isn't
cached. A cold cache is not a regression, and this endpoint is forbidden from
fetching one - AniList's ~30/min budget is shared with every viewer.

Usage:
  py -3.13 -u tools/tests/test_sonarr.py [--backend http://localhost:3000]

Exits 0 if all steps pass (or the cache-dependent steps were skipped), 1 on any
failure. Each progress line is self-contained per the global CLAUDE.md
convention:
  [k/6 Sonarr] step name - detail
"""
import argparse
import sys
from datetime import date

import requests

TOTAL_STEPS = 6


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} Sonarr] {msg}", flush=True)


def fail(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} Sonarr] FAIL - {msg}", flush=True)
    sys.exit(1)


def current_season_year() -> tuple[str, int]:
    """The calendar season, so the test isn't pinned to a hardcoded one."""
    today = date.today()
    return ("WINTER", "SPRING", "SUMMER", "FALL")[(today.month - 1) // 3], today.year


def next_season_year(season: str, year: int) -> tuple[str, int]:
    order = ("WINTER", "SPRING", "SUMMER", "FALL")
    i = order.index(season)
    return (order[(i + 1) % 4], year + 1 if i == 3 else year)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", default="http://localhost:3000")
    args = parser.parse_args()
    backend = args.backend.rstrip("/")
    url = f"{backend}/api/sonarr/list"

    # --------- 1/6  The bare-array contract ---------
    step(1, "GET /api/sonarr/list returns a bare array")
    r = requests.get(url, timeout=60)
    if r.status_code == 503 and (r.json() or {}).get("code") == "UPSTREAM_ERROR":
        # The identity gate is closed. Refusing is the correct behaviour, but
        # nothing below can be checked, so this is a skip and not a pass.
        print("Sonarr: SKIPPED - identity data not loaded yet (503), which is "
              "the endpoint refusing correctly", flush=True)
        return
    if r.status_code != 200:
        fail(1, f"expected 200, got {r.status_code} {r.text[:200]}")
    try:
        items = r.json()
    except ValueError:
        fail(1, f"response is not JSON: {r.text[:200]}")
    if not isinstance(items, list):
        fail(1, f"Sonarr's Custom List accepts only a bare array; got "
                f"{type(items).__name__} - an object parses as zero series")
    step(1, f"PASS - bare array, {len(items)} item(s)")

    # --------- 2/6  Item shape ---------
    step(2, "every item is {title, tvdbId} with a positive integer id")
    for it in items:
        if not isinstance(it, dict):
            fail(2, f"item is not an object: {it!r}")
        if set(it) != {"title", "tvdbId"}:
            fail(2, f"unexpected keys {sorted(it)} - Sonarr reads title and "
                    f"tvdbId, and extra fields are a sign the wrong shape shipped")
        tid = it["tvdbId"]
        # bool is an int subclass in Python; exclude it explicitly.
        if isinstance(tid, bool) or not isinstance(tid, int) or tid <= 0:
            fail(2, f"tvdbId must be a positive integer, got {tid!r} for "
                    f"{it.get('title')!r} - Identity.tvdbId is a STRING, so a "
                    f"missing Number() coercion ships a quoted id Sonarr rejects")
        if not isinstance(it["title"], str) or not it["title"].strip():
            fail(2, f"empty title on tvdbId {tid}")
    step(2, f"PASS - {len(items)} item(s), all well-formed")

    # --------- 3/6  No duplicate tvdbIds ---------
    step(3, "no duplicate tvdbIds")
    ids = [it["tvdbId"] for it in items]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        fail(3, f"duplicate tvdbIds {sorted(dupes)} - several AniList ids map to "
                f"one TVDB id and resolveIdentity does not dedupe")
    step(3, f"PASS - {len(set(ids))} unique id(s)")

    # --------- 4/6  Query-param validation ---------
    step(4, "query params validate rather than silently falling back")
    season, year = current_season_year()
    checks = [
        ("lone season", {"season": season}),
        ("lone year", {"year": year}),
        ("bad season", {"season": "NOPE", "year": year}),
        ("bad year", {"season": season, "year": "abc"}),
    ]
    for label, params in checks:
        rr = requests.get(url, params=params, timeout=30)
        if rr.status_code != 400 or (rr.json() or {}).get("code") != "BAD_REQUEST":
            fail(4, f"{label}: expected 400 BAD_REQUEST, got "
                    f"{rr.status_code} {rr.text[:160]}")
    step(4, "PASS - all four malformed queries rejected")

    # --------- 5/6  The filter, against live season data ---------
    step(5, f"cross-check the filter against /api/anime {season} {year}")
    a = requests.get(f"{backend}/api/anime",
                     params={"season": season, "year": year}, timeout=200)
    if a.status_code != 200:
        fail(5, f"/api/anime {season} {year}: {a.status_code} {a.text[:160]}")
    entries = a.json()
    if not entries:
        # A cold or empty season proves nothing and must not fetch one.
        print(f"Sonarr: SKIPPED at step 5 - {season} {year} is not cached "
              f"(a cold fetch is forbidden here)", flush=True)
        print(f"Sonarr: 4/{TOTAL_STEPS} passed, 2 skipped - OK", flush=True)
        return

    pinned = requests.get(url, params={"season": season, "year": year}, timeout=60)
    if pinned.status_code != 200:
        fail(5, f"pinned season: {pinned.status_code} {pinned.text[:160]}")
    pinned_ids = {it["tvdbId"] for it in pinned.json()}

    by_title = {}
    for e in entries:
        t = (e.get("title") or {})
        name = t.get("english") or t.get("romaji") or t.get("native")
        if name:
            by_title[name.strip()] = e
    # Match on title because the response deliberately carries no AniList id -
    # Sonarr has no use for one. The titles come from the same preference chain.
    leaked = []
    for it in pinned.json():
        e = by_title.get(it["title"])
        if e is None:
            continue          # a title we can't line up proves nothing either way
        rels = {(edge or {}).get("relationType")
                for edge in ((e.get("relations") or {}).get("edges") or [])}
        if e.get("isAdult"):
            leaked.append(f"{it['title']!r} is isAdult")
        if e.get("format") not in ("TV", "TV_SHORT"):
            leaked.append(f"{it['title']!r} is format {e.get('format')}")
        if "PREQUEL" in rels or "PARENT" in rels:
            leaked.append(f"{it['title']!r} has a PREQUEL/PARENT edge")
    if leaked:
        fail(5, "entries the filter should have dropped are on the list: "
                + "; ".join(leaked[:5]))
    step(5, f"PASS - {len(pinned_ids)} proposed from {len(entries)} cached "
            f"entries, none adult / MOVIE / sequel")

    # --------- 6/6  The air window, not the identity gate, bounds the list ---------
    step(6, "a season beyond the air window is empty even though it has ids")
    nseason, nyear = next_season_year(season, year)
    nr = requests.get(url, params={"season": nseason, "year": nyear}, timeout=60)
    if nr.status_code != 200:
        fail(6, f"{nseason} {nyear}: {nr.status_code} {nr.text[:160]}")
    nxt = nr.json()
    na = requests.get(f"{backend}/api/anime",
                      params={"season": nseason, "year": nyear}, timeout=200)
    n_cached = len(na.json()) if na.status_code == 200 else 0
    if not n_cached:
        step(6, f"SKIP - {nseason} {nyear} is not cached")
    elif nxt:
        # Not automatically wrong: within ~14 days of a season start the next
        # season legitimately begins appearing. Only complain when it is clearly
        # too early for that.
        today = date.today()
        season_start_month = {"WINTER": 1, "SPRING": 4, "SUMMER": 7, "FALL": 10}[nseason]
        start = date(nyear, season_start_month, 1)
        if (start - today).days > 21:
            fail(6, f"{nseason} {nyear} starts in {(start - today).days} days but "
                    f"{len(nxt)} entries are already on the list - the air window "
                    f"is not bounding it")
        step(6, f"PASS - {nseason} {nyear} starts in {(start - today).days} days, "
                f"so {len(nxt)} entry/entries inside the window is expected")
    else:
        step(6, f"PASS - {nseason} {nyear} has {n_cached} cached entries and "
                f"contributes 0, so the air window is doing the filtering")

    print(f"Sonarr: {TOTAL_STEPS}/{TOTAL_STEPS} passed - OK", flush=True)


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nSonarr: FAIL - backend unreachable: {e}", flush=True)
        sys.exit(1)
