"""
Is TVDB's premiere date valid evidence for an identity we already believe?

WHY THIS EXISTS. Two FALL 2026 entries (PSYREN, Sirotan) reached the Sonarr
auto-add graded `weak` - accepted on title text alone - while AniList and TVDB
agreed on their air date TO THE DAY. The evidence existed and nothing compared
it. Before changing the resolver's ladder to use it, the question had to be
answered with numbers rather than two examples: does that date actually agree,
across a corpus, for identities that are independently known to be right?

GROUND TRUTH is the Fribb community map (AniList id -> TVDB id, ~7.2k pairs),
which comes from outside this codebase - so this is not our matcher grading its
own homework. Entries the map pairs are the ones we can score.

IT MEASURES TWO SIGNALS, and the difference between them is the whole point:

  show.firstAired          the SERIES' first-ever air date. One free field.
  seasonPremiereDelta()    nearest SEASON premiere, from the episode list -
                           what lib/skyhookIdentity.ts already computes.

For a first season they agree. For a sequel they cannot: TVDB's series date is
season 1's, so a third cour measures years off. Using the series date would have
dropped nearly every sequel out of tolerance and sent correct rows to review -
which is why this tool reports them apart, and why the ladder uses the season
one. Result when it was written (2026-09-20, 515 entries, FALL 2024 -> SUMMER
2026):

    first seasons  345/345 known inside 31d (100%), 298 exact to the day, 0 out
    sequels        season premiere 140/167 (83.8%) vs series date 22/167 (13.2%)

and every one of the 27 sequels it does not vouch for is a TVDB-vs-AniList
modelling difference - a split cour filed as ONE TVDB season puts Part 2 ~182d
from its own Part 1 - never a wrong match. Hence the rung may only UPGRADE.

**Re-measure rather than quoting those numbers.** They are one reading of a
corpus that changes every season.

COST: one skyhook request per unique TVDB id (479 when written), paced at the
same 300 ms the resolver uses and cached to disk, so a re-run asks for nothing
it already has. skyhook is someone else's free service - do not loop this.

Usage:
  py -3.13 -u tools/audit_premiere_dates.py                 # 8 aired seasons back
  py -3.13 -u tools/audit_premiere_dates.py --seasons 4
  py -3.13 -u tools/audit_premiere_dates.py --list-refuted  # name the exceptions
"""
import argparse
import datetime
import io
import json
import os
import sqlite3
import sys
import time
import urllib.request

BASE = "https://skyhook.sonarr.tv/v1/tvdb"
# skyhook 400s some default agents; name the caller (see lib/skyhookIdentity.ts).
USER_AGENT = "SaltyChart-audit/1.0 (+https://github.com/drohack/SaltyChart)"
PACE_S = 0.30
TOL_D = 31  # AIR_DATE_TOLERANCE_MS in backend/src/lib/episodeMatch.ts
SEASON_ORDER = ["WINTER", "SPRING", "SUMMER", "FALL"]
HERE = os.path.dirname(os.path.abspath(__file__))
DB = os.path.join(HERE, "..", "backend", "prisma", "prisma", "data.db")
CACHE = os.path.join(HERE, "premiere_audit_cache.json")
BUCKETS = [(0, "0d (exact)"), (7, "1-7d"), (31, "8-31d  <- inside tolerance"),
           (90, "32-90d"), (365, "91-365d"), (10 ** 9, ">365d")]


def seasons_back(n):
    today = datetime.date.today()
    idx = (today.month - 1) // 3
    out, y, i = [], today.year, idx
    for _ in range(n):
        i -= 1
        if i < 0:
            i, y = 3, y - 1
        out.append((SEASON_ORDER[i], y))
    return list(reversed(out))


def ordv(y, m, d):
    return datetime.date(y, m, d).toordinal()


def season_delta(eps, oa):
    best = None
    for sn, en, ad in eps:
        if not ad or sn is None or en != 1 or sn <= 0:
            continue
        try:
            y, m, d = (int(x) for x in ad.split("-")[:3])
        except Exception:
            continue
        v = abs(ordv(y, m, d) - oa)
        if best is None or v < best:
            best = v
    return best


def bucketise(vals):
    out = {lbl: 0 for _, lbl in BUCKETS}
    out["unknown"] = 0
    for v in vals:
        if v is None:
            out["unknown"] += 1
            continue
        for hi, lbl in BUCKETS:
            if v <= hi:
                out[lbl] += 1
                break
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--seasons", type=int, default=8, help="how many aired seasons back (default: %(default)s)")
    ap.add_argument("--list-refuted", action="store_true", help="name every entry the season signal would refute")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        # Titles carry non-Latin text; cp1252 would kill the run on the first one.
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    seasons = seasons_back(args.seasons)
    cache = json.load(io.open(CACHE, encoding="utf-8")) if os.path.exists(CACHE) else {}
    print(f"[setup] window: {', '.join(f'{s} {y}' for s, y in seasons)}", flush=True)
    print(f"[setup] skyhook disk cache holds {len(cache)} id(s)", flush=True)

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT value FROM AppConfig WHERE key='anilistTvdbMap'").fetchone()
    if not row:
        print("Done: FAILED - no anilistTvdbMap cached; start the backend once so it downloads", flush=True)
        return 2
    amap = json.loads(row[0])

    rows = []
    for s, y in seasons:
        r = conn.execute('SELECT data FROM "SeasonCache" WHERE season=? AND year=? AND format=""', (s, y)).fetchone()
        if not r:
            print(f"[setup] {s} {y}: not cached, skipped", flush=True)
            continue
        for e in json.loads(r["data"]):
            tv = amap.get(str(e["id"]))
            sd = e.get("startDate") or {}
            if not tv or not (sd.get("year") and sd.get("month") and sd.get("day")):
                continue
            edges = ((e.get("relations") or {}).get("edges")) or []
            t = e.get("title") or {}
            rows.append({
                "tvdbId": str(tv), "season": f"{s} {y}", "format": e.get("format"),
                "sequel": any(x.get("relationType") in ("PREQUEL", "PARENT") for x in edges),
                "title": t.get("romaji") or t.get("english") or "?",
                "oa": ordv(sd["year"], sd["month"], sd["day"]),
            })

    ids = sorted({r["tvdbId"] for r in rows})
    todo = [i for i in ids if i not in cache]
    print(f"[setup] {len(rows)} entries with a ground-truth id | {len(ids)} unique tvdbId(s) | {len(todo)} to fetch", flush=True)

    for n, tid in enumerate(todo, 1):
        try:
            req = urllib.request.Request(f"{BASE}/shows/en/{tid}", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=20) as resp:
                d = json.loads(resp.read().decode("utf-8"))
            cache[tid] = {
                "firstAired": (d.get("firstAired") or "")[:10] or None,
                "eps": [[e.get("seasonNumber"), e.get("episodeNumber"), (e.get("airDate") or "")[:10] or None]
                        for e in (d.get("episodes") or [])],
            }
        except Exception as ex:
            cache[tid] = {"error": f"{type(ex).__name__}: {str(ex)[:80]}"}
        if n % 10 == 0 or n == len(todo):
            json.dump(cache, io.open(CACHE, "w", encoding="utf-8"))
        print(f"[fetch {n}/{len(todo)} tvdb {tid}] "
              f"{cache[tid].get('firstAired') or cache[tid].get('error') or 'no date'}", flush=True)
        time.sleep(PACE_S)
    json.dump(cache, io.open(CACHE, "w", encoding="utf-8"))

    for r in rows:
        c = cache.get(r["tvdbId"], {})
        fa = c.get("firstAired")
        r["dShow"] = None
        if fa:
            try:
                y, m, d = (int(x) for x in fa.split("-")[:3])
                r["dShow"] = abs(ordv(y, m, d) - r["oa"])
            except Exception:
                pass
        r["dSeason"] = season_delta(c.get("eps") or [], r["oa"])

    print("", flush=True)
    print("=" * 78, flush=True)
    print(f"PREMIERE-DATE AUDIT - {len(rows)} entries over {len(seasons)} seasons, tolerance {TOL_D}d", flush=True)
    print("ground truth: Fribb community map (sourced outside this repo)", flush=True)
    print("=" * 78, flush=True)
    for label, subset in (("FIRST SEASON (no PREQUEL/PARENT edge)", [r for r in rows if not r["sequel"]]),
                          ("SEQUEL / LATER COUR", [r for r in rows if r["sequel"]]),
                          ("ALL", rows)):
        print(f"\n--- {label}: {len(subset)} entries ---", flush=True)
        for name, key in (("show.firstAired  (series' first-ever air date)", "dShow"),
                          ("seasonPremiereDelta (nearest season premiere)", "dSeason")):
            b = bucketise([r[key] for r in subset])
            known = len(subset) - b["unknown"]
            inside = b["0d (exact)"] + b["1-7d"] + b["8-31d  <- inside tolerance"]
            print(f"  {name}", flush=True)
            for _, lbl in BUCKETS:
                print(f"      {lbl:<28} {b[lbl]:4d}", flush=True)
            print(f"      {'no date available':<28} {b['unknown']:4d}", flush=True)
            print(f"      -> inside {TOL_D}d: {inside}/{known} known "
                  f"({(100.0 * inside / known) if known else 0:.1f}%)", flush=True)

    refuted = sorted([r for r in rows if r["dSeason"] is not None and r["dSeason"] > TOL_D],
                     key=lambda r: -r["dSeason"])
    firsts = [r for r in refuted if not r["sequel"]]
    print(f"\n--- the season signal would REFUTE {len(refuted)} known-correct entries "
          f"({len(refuted) - len(firsts)} sequels, {len(firsts)} first seasons) ---", flush=True)
    print("    A first season here would be a real counter-example; sequels are the", flush=True)
    print("    TVDB split-cour artifact, which is why the rung may only upgrade.", flush=True)
    if args.list_refuted:
        for r in refuted:
            print(f"    {r['dSeason']:6d}d  {'sequel' if r['sequel'] else 'FIRST '}  {r['season']:<12} "
                  f"{r['format'] or '?':<9} tvdb {r['tvdbId']:<8} {r['title'][:44]}", flush=True)

    print("\n--- by format: inside tolerance on the season signal ---", flush=True)
    byfmt = {}
    for r in rows:
        byfmt.setdefault(r["format"] or "?", []).append(r)
    for k, v in sorted(byfmt.items(), key=lambda kv: -len(kv[1])):
        known = [r for r in v if r["dSeason"] is not None]
        ins = sum(1 for r in known if r["dSeason"] <= TOL_D)
        note = "  (too few to conclude)" if len(known) < 20 else ""
        print(f"    {k:<10} {ins:3d}/{len(known):3d} known of {len(v):3d}"
              f"  ({(100.0 * ins / len(known)) if known else 0:5.1f}%){note}", flush=True)

    errs = sum(1 for v in cache.values() if "error" in v)
    print(f"\nDone: {len(rows)} entries, {len(ids)} skyhook ids, {len(firsts)} first-season "
          f"counter-example(s), {errs} fetch error(s)", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
