"""Tag past seasons' anime `saltychart` so Maintainerr can work the backlog.

A backfill for series grabbed before this feature existed, or added by hand.
Everything SaltyChart adds from now on is tagged by the push itself.

**Dry run by default.** It prints the full list and writes nothing until
`--apply` is passed. Tagging is what puts a series into Maintainerr's cleanup
scope, so seeing the list first is the point. Re-running is safe: anything
already carrying the tag is skipped.

**The selection comes from `GET /api/sonarr/report?season=&year=`, not from
here.** That endpoint runs `selectForSonarr`, so this inherits every predicate
the feature actually ships: TV/TV_SHORT only, no `isAdult`, and - the one that
matters most - **first seasons only**, nothing carrying a PREQUEL or PARENT edge.

Worth stating plainly, because a first draft of this script reimplemented the
filters in Python, got format and adult right, and silently omitted
`isFirstSeason`. It offered BLEACH: Thousand-Year Blood War (218 GB), SPY x
FAMILY Season 3, JUJUTSU KAISEN Season 3 and Frieren Season 2 - sequels of
long-running shows, all of which the real feature rejects. 104 series and 1.8 TB
became 81 series and 666 GB once the shipped filter was used instead. It is the
exact drift `sonarr_dryrun.py` warns about.

Series are matched to Sonarr by **tvdbId**, which the report already resolved.

**How far back to go is a watch-history question, not a preference.** The rule
judges on "fewer than 3 watched episodes", so it must not be pointed at a period
whose viewing was never recorded. Plex's own play history is the deep source -
this deployment has it back to 2022-03-26, against Tautulli's 2025-07-10 - so
`--since` should not precede whatever the *rule's* configured source can see.

**A season with no `SeasonCache` row contributes nothing** and is reported as
skipped. The report endpoint never calls AniList; warm a season first by loading
it in the site or hitting `/api/anime?season=&year=`.

**Tagging deletes nothing.** The rule also requires the series to have first
aired over a year ago, then holds it in a collection for the grace period.

Usage:
  py -3.13 -u tools/sonarr_tag_backlog.py --since 2022-03-26
  py -3.13 -u tools/sonarr_tag_backlog.py --since 2022-03-26 --apply
"""
import argparse
import json
import sqlite3
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
DB = REPO / "backend" / "prisma" / "prisma" / "data.db"
BACKEND = "http://localhost:3000"
MONTH_SEASON = ["WINTER", "WINTER", "SPRING", "SPRING", "SPRING", "SUMMER",
                "SUMMER", "SUMMER", "FALL", "FALL", "FALL", "WINTER"]


def out(msg: str = "") -> None:
    """Print without dying on a title Windows' cp1252 cannot encode.

    A show whose title contains an infinity sign crashed an earlier run of this
    report mid-list. The data was fine; only stdout could not represent it.
    """
    sys.stdout.buffer.write(msg.encode("utf-8", "replace") + b"\n")
    sys.stdout.flush()


def app_config() -> dict:
    con = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
    try:
        return dict(con.execute("SELECT key,value FROM AppConfig").fetchall())
    finally:
        con.close()


def cached_seasons() -> set:
    con = sqlite3.connect(f"file:{DB.as_posix()}?mode=ro", uri=True)
    try:
        return {(s, y) for s, y in con.execute("SELECT season,year FROM SeasonCache WHERE format=''")}
    finally:
        con.close()


def admin_token() -> str:
    """Signed through node with the backend's own secret, as the tests do."""
    script = ("require('dotenv').config();"
              "const jwt=require('jsonwebtoken');"
              "const id=parseInt(process.env.ADMIN_USER_ID||'1',10);"
              "console.log(jwt.sign({id}, process.env.JWT_SECRET||'dev-secret',"
              "{expiresIn:'60m'}));")
    try:
        r = subprocess.run(["node", "-e", script], cwd=REPO / "backend",
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def http(url: str, headers: dict, method: str = "GET", body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    h = dict(headers)
    if data:
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=300) as r:
        raw = r.read().decode("utf-8")
        return json.loads(raw) if raw.strip() else None


def seasons_between(start: date, end: date):
    """Every AniList season touching the range, oldest first."""
    def of(d):
        return MONTH_SEASON[d.month - 1], (d.year + 1 if d.month == 12 else d.year)
    seen, d = [], start
    while d <= end:
        s = of(d)
        if s not in seen:
            seen.append(s)
        d += timedelta(days=20)
    if of(end) not in seen:
        seen.append(of(end))
    return seen


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="actually write the tag")
    ap.add_argument("--since", required=True,
                    help="earliest air date to consider, YYYY-MM-DD "
                         "(do not precede your watch-history source)")
    args = ap.parse_args()

    cfg = app_config()
    surl = (cfg.get("sonarrUrl") or "").rstrip("/")
    skey = cfg.get("sonarrApiKey") or ""
    marker = cfg.get("sonarrMarkerTag") or cfg.get("sonarrTag") or "saltychart"
    if not surl or not skey:
        out("Done: Sonarr is not configured")
        sys.exit(1)
    tok = admin_token()
    if not tok:
        out("Done: could not mint an admin token (node available? backend/.env present?)")
        sys.exit(1)
    auth = {"Authorization": f"Bearer {tok}"}

    today = date.today()
    since = date.fromisoformat(args.since)
    seasons = seasons_between(since, today)
    have = cached_seasons()
    missing = [s for s in seasons if s not in have]

    out(f"[1/3] air dates {since} .. {today}  ->  {len(seasons)} season(s)")
    if missing:
        out(f"[1/3] {len(missing)} NOT cached and will contribute nothing: "
            + ", ".join(f"{s} {y}" for s, y in missing))
        out("[1/3] warm them first, or they are silently absent from the result")

    picked = {}
    for i, (season, year) in enumerate(seasons, 1):
        if (season, year) in missing:
            continue
        try:
            rep = http(f"{BACKEND}/api/sonarr/report?season={season}&year={year}", auth)
        except urllib.error.URLError as e:
            out(f"   [{i}/{len(seasons)}] {season} {year}: FAILED - {e}")
            continue
        kept = 0
        for p in rep.get("proposed", []):
            sd = p.get("startDate") or {}
            if not sd.get("year"):
                continue
            try:
                air = date(sd["year"], sd.get("month") or 1, sd.get("day") or 1)
            except ValueError:
                continue
            if not (since <= air <= today):
                continue
            tv = p.get("tvdbId")
            if not isinstance(tv, int) or tv <= 0:
                continue
            picked.setdefault(tv, (air, p.get("title"), f"{season} {year}"))
            kept += 1
        out(f"   [{i}/{len(seasons)}] {season} {year}: {kept} in window "
            f"of {len(rep.get('proposed', []))} selected")

    out(f"[1/3] {len(picked)} distinct series selected by the shipped filter")

    out("[2/3] matching to Sonarr by tvdbId")
    series = http(f"{surl}/api/v3/series", {"X-Api-Key": skey})
    tags = http(f"{surl}/api/v3/tag", {"X-Api-Key": skey})
    tag_id = next((t["id"] for t in tags if t["label"].lower() == marker.lower()), None)
    if tag_id is None:
        out(f"Done: Sonarr has no tag named {marker!r} - create it there first")
        sys.exit(1)
    by_tvdb = {s.get("tvdbId"): s for s in series if s.get("tvdbId")}

    todo, already, not_held = {}, 0, 0
    for tv, (air, title, seas) in picked.items():
        s = by_tvdb.get(tv)
        if not s:
            not_held += 1
        elif tag_id in (s.get("tags") or []):
            already += 1
        else:
            todo[s["id"]] = (air, title, seas, s)

    gb = sum((v[3].get("statistics", {}).get("sizeOnDisk") or 0) for v in todo.values()) / 1e9
    out(f"[2/3] {len(todo)} to tag, {already} already tagged, {not_held} not held by Sonarr")
    out()
    for air, title, seas, s in sorted(todo.values(), key=lambda r: (r[0], r[1] or "")):
        size = (s.get("statistics", {}).get("sizeOnDisk") or 0) / 1e9
        out(f"   {air}  {size:7.2f} GB  {(title or '')[:44]:46} {seas}")
    out()

    if not args.apply:
        out(f"Done: DRY RUN - {len(todo)} series, {gb:.1f} GB would be tagged {marker!r}. "
            f"Re-run with --apply to write.")
        return

    out(f"[3/3] tagging {len(todo)} series")
    done = failed = 0
    for i, (air, title, seas, s) in enumerate(todo.values(), 1):
        s["tags"] = sorted(set((s.get("tags") or []) + [tag_id]))
        try:
            http(f"{surl}/api/v3/series/{s['id']}", {"X-Api-Key": skey}, "PUT", s)
            done += 1
        except urllib.error.HTTPError as e:
            failed += 1
            out(f"[3/3] {i}/{len(todo)} {title}: FAILED {e.code}")
        if i % 20 == 0 or i == len(todo):
            out(f"[3/3] {i}/{len(todo)} ({done} ok, {failed} failed)")

    out(f"Done: tagged {done} series {marker!r}, {failed} failed "
        f"({gb:.1f} GB now in Maintainerr's scope)")


if __name__ == "__main__":
    main()
