"""
Match-quality corpus check (diagnostic, NOT part of run_all.py).

Runs every entry of a season through /api/jellyfin/availability and reports how
many resolved, and by which tier. Results depend on what is actually in the
library, so this can never gate a deploy — but it is how the id-vs-title
confidence numbers were measured, and it is the fastest way to spot a matcher
regression against real data.

**It defaults to a multi-season window, and that is the point.** It used to take
one season and that is how it was run, which is far too small a sample to say
anything about a matcher: a contains-anywhere tier that produced *nine* false
positives across two years showed exactly **one** in SPRING 2026. Judged on that
season alone the honest-looking conclusion was "one bad title", and the fix would
have been to nudge a threshold until that row went away. Matching quality is a
property of the corpus, not of whichever season you happened to run.

⚠ Not free, and not to be run in a loop. Every entry is a real
`/api/jellyfin/availability` call, and each match makes Jellyfin resolve the
series and list its episodes — a full season is ~52 of those, and the default
window is eight of them. Run repeatedly alongside the rest of the suite, this was
a measurable share of the API load that drove the Jellyfin server process to
~800% CPU. Once per matcher change is the intended cadence, the same rule
`bench_player.py` carries. Use a single season while iterating, then a full
window before believing the result.

Usage:
  py -3.13 -u tools/check_match_corpus.py                    # 8 seasons back from now
  py -3.13 -u tools/check_match_corpus.py --seasons 4        # a shorter window
  py -3.13 -u tools/check_match_corpus.py SPRING 2026        # one season, while iterating
"""
import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import date

SEASON_ORDER = ["WINTER", "SPRING", "SUMMER", "FALL"]


def current_season(today: date) -> tuple[str, int]:
    return SEASON_ORDER[(today.month - 1) // 3], today.year


def window(count: int, end: tuple[str, int]) -> list[tuple[str, int]]:
    """`count` seasons ending at (and including) `end`, oldest first."""
    season, year = end
    out: list[tuple[str, int]] = []
    i = SEASON_ORDER.index(season)
    for _ in range(count):
        out.append((SEASON_ORDER[i], year))
        i -= 1
        if i < 0:
            i, year = 3, year - 1
    return list(reversed(out))


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("season", nargs="?", help="one season; omit to sweep a window")
    p.add_argument("year", nargs="?", type=int)
    p.add_argument("--seasons", type=int, default=8,
                   help="window size when no season is given (default 8 = two years)")
    p.add_argument("--backend", default="http://localhost:3000")
    p.add_argument("--user", default="plex_test_fixture")
    p.add_argument("--password", default="plex_pw_123")
    args = p.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    backend = args.backend.rstrip("/")

    if args.season:
        if args.year is None:
            print("give a year with the season", flush=True)
            return 2
        seasons = [(args.season.upper(), args.year)]
    else:
        seasons = window(args.seasons, current_season(date.today()))

    def post(path, body, token=None, timeout=90):
        req = urllib.request.Request(
            backend + path, data=json.dumps(body).encode(), method="POST",
            headers={"Content-Type": "application/json",
                     **({"Authorization": f"Bearer {token}"} if token else {})})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())

    try:
        token = post("/api/auth/login", {"username": args.user, "password": args.password})["token"]
    except urllib.error.HTTPError:
        token = post("/api/auth/signup", {"username": args.user, "password": args.password})["token"]

    totals = {"id": 0, "title": 0, "missing": 0, "unknown": 0}
    per_season: list[tuple[str, dict]] = []
    eyeball: list[tuple[str, str, str]] = []

    for si, (season, year) in enumerate(seasons, 1):
        label = f"{season} {year}"
        url = f"{backend}/api/anime?season={season}&year={year}&format=TV"
        try:
            # A cold season under AniList rate-limiting has been measured at 186s.
            with urllib.request.urlopen(url, timeout=300) as r:
                shows = json.loads(r.read())
        except Exception as e:
            shows = e  # fall through to the guard below with something non-list

        # A season that didn't load must STOP the run, never score as zero. An
        # earlier ad-hoc harness scored two rate-limited seasons as "0 shows" and
        # carried on, and the summary was reported as covering eight seasons when
        # it covered six — every per-season rate is trivially satisfied by an
        # empty list, so a failure here reads as a clean result.
        if not isinstance(shows, list) or not shows:
            print(f"\n[{si}/{len(seasons)}] {label}: FAILED to load ({shows if not isinstance(shows, list) else 'empty list'})",
                  flush=True)
            print("  Refusing to continue — a season that returns nothing scores as "
                  "all-missing and would silently understate the corpus. Warm the "
                  "cache (tools/tests/warm_cache.py) or wait out the AniList "
                  "rate limit, then re-run.", flush=True)
            return 1

        print(f"\n[{si}/{len(seasons)}] {label}: {len(shows)} entries", flush=True)
        counts = {"id": 0, "title": 0, "missing": 0, "unknown": 0}
        for i, s in enumerate(shows, 1):
            titles = [t for t in (s.get("title") or {}).values() if t][:10]
            try:
                # `fresh` matters: without it every answer comes from the
                # per-mediaId availability cache, so this measures a recording of
                # an earlier run rather than the matcher. A stale cached verdict
                # would survive a matching change and this tool would report the
                # fix as a no-op — the same trap test_jellyfin fell into with the
                # id tier.
                # `startDate` is as load-bearing as `fresh`. The air-date tier in
                # getFirstEpisode is gated on `if (airDateMs != null)`, and
                # airDateMs comes from this field — so omitting it silently
                # disables the guard that rejects a franchise sibling, and the
                # tool reports false positives the real frontend never shows.
                # stores/jellyfin.ts sends it; anything measuring the matcher
                # must send it too or it is grading a different program.
                av = post("/api/jellyfin/availability",
                          {"mediaId": s["id"], "titles": titles, "fresh": True,
                           "startDate": s.get("startDate")}, token)
            except Exception as e:
                print(f"  [{si}/{len(seasons)} {label}] {i}/{len(shows)}: request failed: {e}",
                      flush=True)
                counts["unknown"] += 1
                continue
            if av.get("unknown"):
                state = "unknown"
            elif av.get("available"):
                state = "id" if av.get("matchedBy") == "id" else "title"
            else:
                state = "missing"
            counts[state] += 1
            if state == "title":
                eyeball.append((label, titles[0][:44], av.get("libraryTitle") or ""))
            print(f"  [{si}/{len(seasons)} {label}] {i}/{len(shows)}: {state:8} {titles[0][:44]}",
                  flush=True)

        per_season.append((label, counts))
        for k in totals:
            totals[k] += counts[k]

    print("\n" + "=" * 68)
    print(f"{'season':<14}{'entries':>8}{'id':>7}{'title':>8}{'missing':>9}{'unknown':>9}")
    for label, c in per_season:
        n = sum(c.values())
        print(f"{label:<14}{n:>8}{c['id']:>7}{c['title']:>8}{c['missing']:>9}{c['unknown']:>9}")
    n = sum(totals.values())
    print("-" * 68)
    print(f"{'TOTAL':<14}{n:>8}{totals['id']:>7}{totals['title']:>8}"
          f"{totals['missing']:>9}{totals['unknown']:>9}")

    if eyeball:
        print(f"\ntitle-only matches to eyeball ({len(eyeball)}) — each is a Watch")
        print("button pointed at a series we are not certain is the right one:")
        for label, anilist, lib in eyeball:
            print(f"  {label:<13} {anilist!r:<48} -> {lib!r}")
    else:
        print("\nno title-only matches — every resolved entry was id-confirmed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
