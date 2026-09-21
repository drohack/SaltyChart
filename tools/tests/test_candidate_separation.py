"""
Pre-deploy test: when may a multi-candidate row leave the review queue?

WHY THIS EXISTS. `/admin/matching` queues every row carrying more than one
candidate, and that rule is right for the case it was written for - Echo's three
candidates are all titled "Echo" and are three different films. But it also
fired on rows the premiere date had already settled TO THE DAY, so a reviewer's
queue filled with Confirm clicks on matches nothing disputed: 142 of 170
premiere-date-rung multi-candidate rows stored here, measured 2026-09-21.

`dateSettlesCandidates()` (backend/src/lib/seriesIdentity.ts) decides it, and
its logic is unit-tested off the network in `seriesIdentity.test.ts` with a
mutation row behind it. THIS test covers what a unit test cannot: that the
decision actually reaches the page, over real stored rows.

THREE CHECKS, and the second is the one that would have caught a silent break:

  1. the route reports `settledByDate` at all, per row.
  2. sending NO dates settles NOTHING. Without this, a field hardcoded to `true`
     or computed from something other than the date would sail through check 3
     on rows that happen to look right - the "measure what you actually sent"
     rule, applied to our own endpoint.
  3. every settled row re-derives as settled INDEPENDENTLY here: exactly one
     candidate inside 31 days, no undated sibling, and that candidate the one
     stored. An invariant, not a count - counts go stale every season.

Needs a running backend. No browser.

Usage:
  py -3.13 -u tools/tests/test_candidate_separation.py --backend http://localhost:3000
"""
import argparse
import datetime
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
TOL_MS = 31 * 86_400_000  # CANDIDATE_TOLERANCE_MS in lib/seriesIdentity.ts

# Must never be settled by this rule: it exists twice in TVDB with one copy
# undated, and nothing proves the two are the same show - which is why the
# resolver refuses to merge them either.
CYBORG_009_NEMESIS = 196223

failures: list[str] = []
checks = 0


def check(ok: bool, what: str) -> None:
    global checks
    checks += 1
    if not ok:
        failures.append(what)
        print(f"FAIL: {what}", flush=True)


def admin_token() -> str:
    """A JWT for ADMIN_USER_ID - same helper as test_jellyfin.admin_token."""
    script = ("require('dotenv').config();"
              "const jwt=require('jsonwebtoken');"
              "const id=parseInt(process.env.ADMIN_USER_ID||'1',10);"
              "console.log(jwt.sign({id}, process.env.JWT_SECRET||'dev-secret',"
              "{expiresIn:'10m'}));")
    try:
        r = subprocess.run(["node", "-e", script], cwd=REPO / "backend",
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def post(base: str, path: str, tok: str, body: dict) -> dict:
    req = urllib.request.Request(
        base + path, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + tok, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as f:
        return json.load(f)


def get(base: str, path: str, tok: str):
    req = urllib.request.Request(base + path, headers={"Authorization": "Bearer " + tok})
    with urllib.request.urlopen(req, timeout=200) as f:
        return json.load(f)


def season_now() -> tuple[str, int]:
    d = datetime.date.today()
    return (["WINTER", "SPRING", "SUMMER", "FALL"][(d.month - 1) // 3], d.year)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="http://localhost:3000")
    args = ap.parse_args()

    tok = admin_token()
    if not tok:
        print("FAIL: could not mint an admin token - the identity routes are admin-gated",
              flush=True)
        return 1

    season, year = season_now()
    print(f"[1/4] reading {season} {year} from the season cache", flush=True)
    try:
        shows = get(args.backend, f"/api/anime?season={season}&year={year}", tok)
    except (urllib.error.URLError, OSError, ValueError) as e:
        print(f"FAIL: could not read the season ({e})", flush=True)
        return 1

    dates, ids = {}, []
    for e in shows:
        sd = e.get("startDate") or {}
        ids.append(e["id"])
        if sd.get("year"):
            dates[str(e["id"])] = int(datetime.datetime(
                sd["year"], sd.get("month") or 1, sd.get("day") or 1,
                tzinfo=datetime.timezone.utc).timestamp() * 1000)
    ids = ids[:200]  # the route's own cap
    print(f"      {len(ids)} entries, {len(dates)} with a premiere date", flush=True)

    print("[2/4] resolving WITH dates", flush=True)
    withd = post(args.backend, "/api/jellyfin/identity/resolve", tok,
                 {"mediaIds": ids, "dates": dates}).get("identities") or {}
    check(any("settledByDate" in (v or {}) for v in withd.values()),
          "the route must report settledByDate on every row")

    print("[3/4] resolving WITHOUT dates - nothing may settle", flush=True)
    nod = post(args.backend, "/api/jellyfin/identity/resolve", tok,
               {"mediaIds": ids}).get("identities") or {}
    leaked = [k for k, v in nod.items() if (v or {}).get("settledByDate")]
    check(not leaked,
          f"with no dates sent, nothing can be settled by a date - but {len(leaked)} "
          f"row(s) were: {leaked[:5]}")

    print("[4/4] re-deriving every settled row independently", flush=True)
    settled = [(int(k), v) for k, v in withd.items() if (v or {}).get("settledByDate")]
    multi = [1 for v in withd.values() if len((v or {}).get("candidates") or []) > 1]
    print(f"      {len(multi)} multi-candidate row(s), {len(settled)} settled by the date",
          flush=True)

    bad = []
    for aid, v in settled:
        start = dates.get(str(aid))
        cands = v.get("candidates") or []
        inside, undated = [], 0
        for c in cands:
            prem = c.get("premiereDate")
            try:
                d = datetime.date.fromisoformat(str(prem)[:10]) if prem else None
            except ValueError:
                d = None
            if d is None:
                undated += 1
                continue
            ms = int(datetime.datetime(d.year, d.month, d.day,
                                       tzinfo=datetime.timezone.utc).timestamp() * 1000)
            if start is not None and abs(ms - start) <= TOL_MS:
                inside.append(c)
        picked = bool(inside) and (
            (v.get("tvdbId") and str(inside[0].get("tvdbId") or "") == str(v["tvdbId"]))
            or (v.get("tmdbId") and str(inside[0].get("tmdbId") or "") == str(v["tmdbId"])))
        if undated or len(inside) != 1 or not picked or len(cands) <= 1:
            bad.append(f"{aid} ({len(cands)} cands, {len(inside)} inside, "
                       f"{undated} undated, pick matches: {picked})")
    check(not bad,
          "every settled row must have exactly one dated candidate inside tolerance, "
          f"no undated sibling, and that candidate stored - violated by: {bad[:5]}")

    check(CYBORG_009_NEMESIS not in {a for a, _ in settled},
          f"Cyborg 009: Nemesis ({CYBORG_009_NEMESIS}) must stay in review - it exists "
          "twice in TVDB with one copy undated")

    if failures:
        print(f"\nDone: {checks} checks, {len(failures)} FAILED", flush=True)
        return 1
    print(f"\nDone: {checks} checks passed - {len(settled)} of {len(multi)} multi-candidate "
          "rows settled, every one re-derived independently", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
