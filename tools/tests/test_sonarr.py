"""
Pre-deploy smoke test: the Sonarr auto-add (/api/sonarr/*).

Runs against http://localhost:3000. This feature WRITES to someone's media
server, so the assertions here are about the CONTRACT, the SHAPE of the plan,
and above all the guards - never about which shows are in it.

Coverage, and the trap each step exists for:

- **Every route is admin-gated.** The Custom List era had exactly one public
  route, `GET /list`, which Sonarr polled. It is gone, and so is the trap of a
  public router quietly growing admin data - but only as long as nothing new
  arrives unauthenticated, which is what step 1 is for.
- **Nothing is added while pushing is paused**, asserted by comparing our own
  `SonarrPush` rows before and after a real `POST /push` - not by trusting the
  response body. A hide-rollback test in this repo once checked the server,
  which is trivially correct when every write fails; the rows are the evidence
  that a write did or did not happen.
- Every planned item has a **positive integer** tvdbId. `Identity.tvdbId` is
  stored as a *string*, so a missing `Number()` coercion ships `"12345"` and
  Sonarr's lookup finds nothing.
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
  TVDB ids - on 2026-08-06, FALL 2026 had 27 resolvable entries and none were
  planned. Without this step a broken identity lookup would look exactly like a
  working air-date filter.
- Query-param validation: a lone `?season=` is a 400 rather than a silent
  fallback to the calendar default, which would make a failing assertion
  elsewhere look like a filter bug.
- **/report degrades instead of failing.** Without a successful snapshot it must
  still return the whole candidate side with `sonarr.observed: false` - never a
  500, never a blank payload. The page is useless in an outage otherwise, which
  is exactly when someone opens it.
- **Every row carries a match `grade`**, and **POST /include refuses an
  unverified identity with 409** unless the caller acknowledges it. That guard
  did not exist at first: the force-include path skipped `usableTvdbId`
  entirely, so `tvdbId && !pending && !rejected` - the rule that keeps an
  unverified guess from becoming a season of the wrong series - did not apply to
  overrides. 22 candidates carried a pending identity when it was measured.
- **`published` is always present.** It is the master switch (default OFF), and
  a missing value would render as "paused" on a page that was in fact adding -
  the most dangerous direction for that particular lie.
- **`history.pushed` never exceeds the rows that say `pushed`.** Only a 201 from
  Sonarr writes one, which is what makes "we added N" sayable at all; a version
  counting held rows instead would report someone's whole library as ours.

**Not covered here, deliberately:** a successful add. It needs write
credentials and it changes a real library, so it is a manual verification step
(push one series with `cap: 1`, check it in Sonarr's UI, push again and confirm
the second run is a no-op). The refusal paths are what this file guards.

The season-cache steps **skip and still exit 0** when the current season isn't
cached. A cold cache is not a regression, and these endpoints are forbidden
from fetching one - AniList's ~30/min budget is shared with every viewer.

Usage:
  py -3.13 -u tools/tests/test_sonarr.py [--backend http://localhost:3000]

Exits 0 if all steps pass (or the cache-dependent steps were skipped), 1 on any
failure. Each progress line is self-contained per the global CLAUDE.md
convention:
  [k/9 Sonarr] step name - detail
"""
import argparse
import subprocess
import sys
from datetime import date
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parents[2]


def admin_token() -> str:
    """A JWT for ADMIN_USER_ID, signed with the backend's own secret.

    Same helper as test_jellyfin/test_ui_interactions - signed through node so
    the suite gains no dependency and signs exactly the way the app does.
    Returns '' when it cannot, and the admin steps skip rather than fail: a
    missing .env is an environment problem, not a regression.
    """
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


TOTAL_STEPS = 9


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


def push_fingerprint(rep: dict) -> set:
    """Enough of every push row to notice any write.

    Compared before and after a paused `POST /push`. `attempts` and
    `lastAttemptAt` move on *every* attempt including failures, so an add that
    got as far as trying is caught even when it did not succeed.
    """
    return {
        (p["tvdbId"], p["status"], p["attempts"], p["lastAttemptAt"], p["pushedAt"])
        for p in rep.get("pushes", [])
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", default="http://localhost:3000")
    args = parser.parse_args()
    backend = args.backend.rstrip("/")
    preview_url = f"{backend}/api/sonarr/push/preview"

    # --------- 1/9  There is no public route here at all ---------
    step(1, "every route refuses an unauthenticated caller")
    admin_routes = [
        ("GET", "/api/sonarr/report", None),
        ("GET", "/api/sonarr/push/preview", None),
        ("POST", "/api/sonarr/push", {}),
        ("PUT", "/api/sonarr/enabled", {"enabled": False}),
        ("POST", "/api/sonarr/snapshot", None),
        ("POST", "/api/sonarr/include", {"anilistId": 1}),
        ("DELETE", "/api/sonarr/include/1", None),
        ("GET", "/api/sonarr/config", None),
        ("GET", "/api/sonarr/config/options", None),
        ("PUT", "/api/sonarr/config", {}),
        ("POST", "/api/sonarr/config/test", {}),
    ]
    for method, path, payload in admin_routes:
        rr = requests.request(method, f"{backend}{path}", json=payload, timeout=30)
        if rr.status_code != 401:
            fail(1, f"{method} {path}: expected 401 unauthenticated, got "
                    f"{rr.status_code} {rr.text[:160]} - this router has NO public "
                    f"route, and one that writes to Sonarr least of all")
    step(1, f"PASS - all {len(admin_routes)} routes gated")

    tok = admin_token()
    if not tok:
        print("Sonarr: SKIPPED after step 1 - could not mint an admin token "
              "(node/.env unavailable); every remaining step needs one", flush=True)
        print(f"Sonarr: 1/{TOTAL_STEPS} passed, {TOTAL_STEPS - 1} skipped - OK", flush=True)
        return
    auth = {"Authorization": f"Bearer {tok}"}

    # --------- 2/9  The plan's shape ---------
    step(2, "GET /push/preview returns a plan with well-formed items")
    r = requests.get(preview_url, headers=auth, timeout=200)
    if r.status_code != 200:
        fail(2, f"expected 200, got {r.status_code} {r.text[:200]}")
    plan = r.json()
    for key in ("enabled", "cap", "problems", "toPush", "deferred", "skipped"):
        if key not in plan:
            fail(2, f"plan is missing {key!r} - the page reads all of these")
    if not isinstance(plan["enabled"], bool):
        fail(2, "plan.enabled must be a bool - it is the master switch")
    if not isinstance(plan["problems"], list):
        fail(2, "plan.problems must be a list; the page renders it as setup steps")
    planned = plan["toPush"] + plan["deferred"]
    for it in planned:
        tid = it.get("tvdbId")
        # bool is an int subclass in Python; exclude it explicitly.
        if isinstance(tid, bool) or not isinstance(tid, int) or tid <= 0:
            fail(2, f"tvdbId must be a positive integer, got {tid!r} for "
                    f"{it.get('title')!r} - Identity.tvdbId is a STRING, so a "
                    f"missing Number() coercion ships a quoted id the lookup misses")
        if not isinstance(it.get("title"), str) or not it["title"].strip():
            fail(2, f"empty title on tvdbId {tid}")
    step(2, f"PASS - {len(plan['toPush'])} to add, {len(plan['deferred'])} deferred, "
            f"{len(plan['skipped'])} skipped, all well-formed")

    # --------- 3/9  No duplicate tvdbIds ---------
    step(3, "no duplicate tvdbIds across the whole plan")
    ids = [it["tvdbId"] for it in planned + plan["skipped"] if isinstance(it.get("tvdbId"), int)]
    dupes = {i for i in ids if ids.count(i) > 1}
    if dupes:
        fail(3, f"duplicate tvdbIds {sorted(dupes)} - several AniList ids map to "
                f"one TVDB id and resolveIdentity does not dedupe")
    step(3, f"PASS - {len(set(ids))} unique id(s) across the plan")

    # --------- 4/9  Query-param validation ---------
    step(4, "query params validate rather than silently falling back")
    season, year = current_season_year()
    checks = [
        ("lone season", {"season": season}),
        ("lone year", {"year": year}),
        ("bad season", {"season": "NOPE", "year": year}),
        ("bad year", {"season": season, "year": "abc"}),
    ]
    for label, params in checks:
        rr = requests.get(preview_url, params=params, headers=auth, timeout=30)
        if rr.status_code != 400 or (rr.json() or {}).get("code") != "BAD_REQUEST":
            fail(4, f"{label}: expected 400 BAD_REQUEST, got "
                    f"{rr.status_code} {rr.text[:160]}")
    step(4, "PASS - all four malformed queries rejected")

    # --------- 5/9  Nothing is added while paused ---------
    #
    # The single most important assertion in this file, and it reads the ROWS
    # rather than the response: `{ran: false}` is exactly what a broken guard
    # would also return if it wrote first and reported afterwards.
    step(5, "a push while paused writes nothing at all")
    rep0 = requests.get(f"{backend}/api/sonarr/report", headers=auth, timeout=120)
    if rep0.status_code != 200:
        fail(5, f"/report: {rep0.status_code} {rep0.text[:160]}")
    rep0 = rep0.json()
    was_published = bool(rep0.get("published"))

    # Pause explicitly rather than skipping when the instance happens to be
    # enabled. A step that skips on the very configuration it is meant to guard
    # is a step that never runs on the machine that matters - and the pause is
    # restored below. If this test dies mid-way it leaves pushing PAUSED, which
    # is the safe direction to fail in.
    pe = requests.put(f"{backend}/api/sonarr/enabled", headers=auth,
                      json={"enabled": False}, timeout=30)
    if pe.status_code != 200:
        fail(5, f"PUT /enabled: {pe.status_code} {pe.text[:160]}")
    try:
        rep0 = requests.get(f"{backend}/api/sonarr/report", headers=auth, timeout=120).json()
        if rep0.get("published") is not False:
            fail(5, "asked to pause and /report still reports published - the "
                    "master switch ignored an explicit pause")
        before = push_fingerprint(rep0)
        pr = requests.post(f"{backend}/api/sonarr/push", headers=auth, json={}, timeout=200)
        if pr.status_code != 200:
            fail(5, f"POST /push: {pr.status_code} {pr.text[:200]}")
        body = pr.json()
        if body.get("ran") is not False or body.get("reason") != "paused":
            fail(5, f"paused push reported ran={body.get('ran')!r} "
                    f"reason={body.get('reason')!r} - expected ran=False, 'paused'")
        if body.get("pushed"):
            fail(5, f"paused push reports {body['pushed']} added")
        rep1 = requests.get(f"{backend}/api/sonarr/report", headers=auth, timeout=120).json()
        after = push_fingerprint(rep1)
        if after != before:
            fail(5, f"the push wrote {len(after ^ before)} row change(s) while paused - "
                    f"the master switch is not switching anything")
        step(5, f"PASS - paused, and {len(before)} push row(s) unchanged by a real "
                f"POST /push")
    finally:
        # Best effort, and only ever back to what it was.
        if was_published:
            requests.put(f"{backend}/api/sonarr/enabled", headers=auth,
                         json={"enabled": True}, timeout=30)

    # --------- 6/9  The filter, against live season data ---------
    step(6, f"cross-check the filter against /api/anime {season} {year}")
    a = requests.get(f"{backend}/api/anime",
                     params={"season": season, "year": year}, timeout=200)
    if a.status_code != 200:
        fail(6, f"/api/anime {season} {year}: {a.status_code} {a.text[:160]}")
    entries = a.json()
    if not entries:
        # A cold or empty season proves nothing and must not fetch one.
        print(f"Sonarr: SKIPPED at step 6 - {season} {year} is not cached "
              f"(a cold fetch is forbidden here)", flush=True)
        print(f"Sonarr: 5/{TOTAL_STEPS} passed, 4 skipped - OK", flush=True)
        return

    pinned = requests.get(preview_url, params={"season": season, "year": year},
                          headers=auth, timeout=200)
    if pinned.status_code != 200:
        fail(6, f"pinned season: {pinned.status_code} {pinned.text[:160]}")
    pp = pinned.json()
    # Everything the selection produced, whatever the push decided to do with it.
    # Reading only `toPush` would let the filter regress unnoticed the moment a
    # season was fully added.
    pinned_sel = pp["toPush"] + pp["deferred"] + pp["skipped"]

    by_title = {}
    for e in entries:
        t = (e.get("title") or {})
        name = t.get("english") or t.get("romaji") or t.get("native")
        if name:
            by_title[name.strip()] = e
    leaked = []
    for it in pinned_sel:
        e = by_title.get(it.get("title"))
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
        fail(6, "entries the filter should have dropped are candidates: "
                + "; ".join(leaked[:5]))
    step(6, f"PASS - {len(pinned_sel)} candidates from {len(entries)} cached "
            f"entries, none adult / MOVIE / sequel")

    # --------- 7/9  The air window, not the identity gate, bounds the plan ---------
    step(7, "a season beyond the air window is empty even though it has ids")
    nseason, nyear = next_season_year(season, year)
    nr = requests.get(preview_url, params={"season": nseason, "year": nyear},
                      headers=auth, timeout=200)
    if nr.status_code != 200:
        fail(7, f"{nseason} {nyear}: {nr.status_code} {nr.text[:160]}")
    np_ = nr.json()
    nxt = np_["toPush"] + np_["deferred"] + np_["skipped"]
    na = requests.get(f"{backend}/api/anime",
                      params={"season": nseason, "year": nyear}, timeout=200)
    n_cached = len(na.json()) if na.status_code == 200 else 0
    if not n_cached:
        step(7, f"SKIP - {nseason} {nyear} is not cached")
    elif nxt:
        # Not automatically wrong: within ~14 days of a season start the next
        # season legitimately begins appearing. Only complain when it is clearly
        # too early for that.
        today = date.today()
        season_start_month = {"WINTER": 1, "SPRING": 4, "SUMMER": 7, "FALL": 10}[nseason]
        start = date(nyear, season_start_month, 1)
        if (start - today).days > 21:
            fail(7, f"{nseason} {nyear} starts in {(start - today).days} days but "
                    f"{len(nxt)} entries are already candidates - the air window "
                    f"is not bounding it")
        step(7, f"PASS - {nseason} {nyear} starts in {(start - today).days} days, "
                f"so {len(nxt)} entry/entries inside the window is expected")
    else:
        step(7, f"PASS - {nseason} {nyear} has {n_cached} cached entries and "
                f"contributes 0, so the air window is doing the filtering")

    # --------- 8/9  /report degrades rather than failing ---------
    step(8, "/report returns the candidate side even without Sonarr")
    rr = requests.get(f"{backend}/api/sonarr/report", headers=auth, timeout=120)
    if rr.status_code != 200:
        fail(8, f"expected 200, got {rr.status_code} {rr.text[:200]} - the report "
                f"must degrade, not fail, when Sonarr is down")
    rep = rr.json()
    for key in ("config", "sonarr", "seasons", "proposed", "rejected",
                "pushes", "orphans", "counts", "history"):
        if key not in rep:
            fail(8, f"report is missing {key!r} - the page reads all of these")
    if not isinstance(rep["sonarr"].get("observed"), bool):
        fail(8, "sonarr.observed must always be present as a bool: the page "
                "branches on it to avoid reporting 'couldn't ask' as 'nothing to do'")
    if not isinstance(rep.get("published"), bool):
        fail(8, "report.published must be a bool - it is the master switch, and a "
                "missing value would render as 'paused' while adds were happening")
    if not isinstance(rep["config"].get("problems"), list):
        fail(8, "config.problems must be a list - it is how the page says what "
                "setup is still outstanding instead of failing at push time")
    step(8, f"PASS - {len(rep['proposed'])} candidates, published="
            f"{rep['published']}, observed={rep['sonarr']['observed']}, shape intact")

    # `history.pushed` is the only number on the page that claims WE added
    # something, and it may only ever count rows whose status is `pushed` -
    # written solely when Sonarr answered 201. The Custom List version of this
    # counted rows a snapshot had merely observed, which on a pre-existing
    # library would have reported someone's whole collection as ours.
    h = rep["history"]
    for key in ("ours", "tagged", "pushed", "alreadyHeld", "needsAttention",
                "firstPushAt", "lastPushAt"):
        if key not in h:
            fail(8, f"history is missing {key!r}")
    by_status = {}
    for p in rep["pushes"]:
        by_status[p["status"]] = by_status.get(p["status"], 0) + 1
    if h["pushed"] != by_status.get("pushed", 0):
        fail(8, f"history.pushed={h['pushed']} but {by_status.get('pushed', 0)} rows "
                f"say 'pushed' - only a 201 from Sonarr may count as one we added")
    if h["alreadyHeld"] != by_status.get("alreadyHeld", 0):
        fail(8, f"history.alreadyHeld={h['alreadyHeld']} but "
                f"{by_status.get('alreadyHeld', 0)} rows say so")
    if h["pushed"] and not h["lastPushAt"]:
        fail(8, "history claims pushes but carries no lastPushAt date")
    if not h["pushed"] and h["lastPushAt"]:
        fail(8, "history reports a lastPushAt with no pushed rows")
    # `ours` is the union of the two records, so it can never be smaller than
    # either - and it must never approach the library size, which is what a
    # regression to "carries any of our tags" would do (`anime` alone is on 692
    # series here, and two shows the owner had for years once rendered as ours).
    if h["ours"] < max(h["pushed"], h["tagged"]):
        fail(8, f"history.ours={h['ours']} is smaller than pushed={h['pushed']} or "
                f"tagged={h['tagged']} - it is the union of both records")
    if rep["sonarr"]["observed"] and h["tagged"] > rep["sonarr"]["held"]:
        fail(8, f"history.tagged={h['tagged']} exceeds the {rep['sonarr']['held']} series "
                f"Sonarr holds - only the marker tag may count, never a shared one")
    if rep["config"]["taggedOfOurs"] > h["pushed"]:
        fail(8, f"config.taggedOfOurs={rep['config']['taggedOfOurs']} exceeds the "
                f"{h['pushed']} we have a record of adding - it counts our own rows "
                f"that carry the marker, never every tagged series")

    # --------- 9/9  Match grades, and the override guard ---------
    step(9, "every row is graded, and an unverified include is refused")
    known = {"confirmed", "adminOverride", "map", "dateVerified",
             "viewerPick", "weak", "none"}
    for row in rep["proposed"] + rep["rejected"]:
        if row.get("grade") not in known:
            fail(9, f"row {row.get('title')!r} has grade {row.get('grade')!r}, "
                    f"not one of {sorted(known)} - the page branches on this")
    # The automatic path must never add a weak match. If this trips, the identity
    # FILTER has regressed, which matters more than anything on screen.
    weak = [p for p in rep["proposed"] if p["grade"] in ("weak", "viewerPick")]
    if weak:
        fail(9, f"{len(weak)} candidates are unverified "
                f"({[p['title'] for p in weak][:3]}) - the pending exclusion has "
                f"stopped working on the automatic path")

    target = next((r for r in rep["rejected"]
                   if r.get("unverified") and r.get("anilistId") and r.get("tvdbId")), None)
    if target is None:
        step(9, f"PASS - {len(rep['proposed'])} graded, 0 weak; no unverified "
                f"candidate to test the override guard against")
    else:
        rr = requests.post(f"{backend}/api/sonarr/include", headers=auth,
                           json={"anilistId": target["anilistId"]}, timeout=30)
        if rr.status_code != 409 or (rr.json() or {}).get("code") != "UNVERIFIED_MATCH":
            fail(9, f"including an unverified identity returned {rr.status_code} "
                    f"{rr.text[:160]} - expected 409 UNVERIFIED_MATCH. An override "
                    f"may outrank the filter, but not without being asked.")
        step(9, f"PASS - {len(rep['proposed'])} graded, 0 weak among candidates, "
                f"and an unverified include was refused")

    print(f"Sonarr: {TOTAL_STEPS}/{TOTAL_STEPS} passed - OK", flush=True)


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nSonarr: FAIL - backend unreachable: {e}", flush=True)
        sys.exit(1)
