"""
Rebuild the fixtures that `test_match_replay.py` runs against.

**This is a re-baselining tool, not part of any test run.** It captures a
snapshot of the real library, the real id map, and eight seasons of real AniList
entries, so the matcher can be exercised offline against data it actually has to
cope with. Run it only when you deliberately intend to move the baseline, and read the
replay diff before accepting it — a fixture rebuild that silently absorbs a
regression is worse than no fixture at all.

Why a snapshot rather than live data: the replay must be deterministic and must
run in seconds with no network, so it can run on every change. It measures
**matcher logic**, not what is currently on disk. When holdings change, the fixture goes
out of date and that is fine — it is not trying to describe today's library.

**Output is gitignored on purpose.** The library snapshot contains every title
in the media server and its internal item ids, and this repo is public. Build it
on the machine that runs the suite; don't commit it.

Needs the backend running (for /api/anime) and the local DB (for the cached
library + id map).

  py -3.13 -u tools/tests/build_match_fixtures.py
"""
import json
import sqlite3
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / "tests" / "fixtures" / "match_corpus"
DB = ROOT / "backend" / "prisma" / "prisma" / "data.db"
BACKEND = "http://localhost:3000"

SEASONS = [
    ("FALL", 2024), ("WINTER", 2025), ("SPRING", 2025), ("SUMMER", 2025),
    ("FALL", 2025), ("WINTER", 2026), ("SPRING", 2026), ("SUMMER", 2026),
]


def cfg(db, key):
    row = db.execute("select value from AppConfig where key=?", (key,)).fetchone()
    return row[0] if row else None


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    OUT.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(DB)

    lib_raw = cfg(db, "jellyfinLibrary")
    if not lib_raw:
        print("no cached jellyfinLibrary — start the backend and load a season first", flush=True)
        return 1
    library = json.loads(lib_raw)["series"]
    # Keep only what the matcher reads. The full rows carry itemId and other
    # fields the pure matcher never touches, and a fixture should not imply
    # otherwise.
    trimmed = [
        {"id": s["id"], "title": s["title"], "norms": s["norms"],
         "tvdbId": s.get("tvdbId"), "tmdbId": s.get("tmdbId")}
        for s in library
    ]
    # A column that is empty across EVERY row means the source didn't have it —
    # not that the data is like that. `tmdbId` was captured as null on all 2271
    # rows because the fixture was built before the field existed, and the replay
    # test then ran green for hours while exercising only half of `matchSeries`.
    # That same silent-null shape has caused three wrong conclusions in one
    # session, so the builder now refuses to write one.
    for column in ("tvdbId", "tmdbId", "norms"):
        if not any(s.get(column) for s in trimmed):
            print(f"REFUSING: every library row has an empty {column!r}. The source "
                  f"lacks it, so any test built on this fixture would silently not "
                  f"cover it. Refresh the library cache and re-run.", flush=True)
            return 1
    (OUT / "library.json").write_text(json.dumps(trimmed, ensure_ascii=False), encoding="utf-8")
    print(f"library.json: {len(trimmed)} series "
          f"({sum(1 for s in trimmed if s.get('tvdbId'))} tvdb, "
          f"{sum(1 for s in trimmed if s.get('tmdbId'))} tmdb)", flush=True)

    tvdb = json.loads(cfg(db, "anilistTvdbMap") or "{}")
    tmdb = json.loads(cfg(db, "anilistTmdbMap") or "{}")

    entries = []
    for season, year in SEASONS:
        url = f"{BACKEND}/api/anime?season={season}&year={year}"
        with urllib.request.urlopen(url, timeout=300) as r:
            shows = json.loads(r.read())
        # Never write a fixture from a season that didn't load: an empty list
        # scores as "everything absent" and every assertion passes vacuously.
        if not isinstance(shows, list) or not shows:
            print(f"FAILED to load {season} {year} — refusing to write a partial fixture", flush=True)
            return 1
        for m in shows:
            t = m.get("title") or {}
            entries.append({
                "id": m["id"],
                "season": f"{season} {year}",
                "format": m.get("format"),
                "titles": [x for x in (t.get("english"), t.get("romaji"), t.get("native")) if x]
                          + list(m.get("synonyms") or []),
            })
        print(f"  {season} {year}: {len(shows)}", flush=True)

    (OUT / "entries.json").write_text(json.dumps(entries, ensure_ascii=False), encoding="utf-8")
    print(f"entries.json: {len(entries)} entries", flush=True)

    ids = {str(e["id"]): {"tvdb": tvdb.get(str(e["id"])), "tmdb": tmdb.get(str(e["id"]))}
           for e in entries}
    ids = {k: v for k, v in ids.items() if v["tvdb"] or v["tmdb"]}
    (OUT / "ids.json").write_text(json.dumps(ids, ensure_ascii=False), encoding="utf-8")
    print(f"ids.json: {len(ids)} of {len(entries)} entries have an id", flush=True)
    print("Done: fixtures written — now run match_replay with --write to re-baseline", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
