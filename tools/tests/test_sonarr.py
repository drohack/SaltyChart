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

- **The library check (step 10) adds up and stays on our series.** Totals
  must equal the sum of their rows, every row's subtitle counts must sum to its
  episodes, and the audited set must be exactly the marker-tagged series with
  files from the snapshot - scoping on any applied tag would audit the 692
  `anime` series. One series is cross-checked against a direct Jellyfin read:
  its count of episodes with no English subtitle track and no English audio
  must match `counts.none`. Skipped (exit 0) when Sonarr is not configured.

- **Only trusted accounts' lists add shows (step 11).** A throwaway non-admin
  account lists a show the rules skip; it must NOT reach the auto-add list. The
  account is then trusted (`PATCH /api/admin/users/:id/sonarr-trusted`) and the
  same show must appear, then everything is put back. Signup is open to anyone,
  so an untrusted list starting downloads is the failure that matters.

- **Every row carries one status, and the counts add up (step 12).** Each
  proposed and rejected row has a `status.level` among broken / check / waiting
  / ok, a boolean `wanted`, and `attention` exactly when it is wanted and red or
  yellow - never on a show nothing wants. `summary.attention` equals the rows
  plus the unattached failures, and every open push failure is on a row or in
  `attention`, so nothing actionable lives only in the collapsed history log.

- **/admin/sonarr agrees with Randomize's Hide Not English (step 13).** For the
  admin's own list, each aired show is asked about with `fresh` (what the
  pop-up does), the report is re-read, and the set Randomize's `isNotEnglish`
  rule hides must equal the rows the report calls not `watchable` - every one
  of them red. That is the 1:1 the owner asked for: Show All, Hide Not English,
  and the hidden count matches the page.

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
  [k/13 Sonarr] step name - detail
"""
import argparse
import sqlite3
import subprocess
import sys
import time
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


TOTAL_STEPS = 13


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
        ("POST", "/api/sonarr/library/check", None),
        ("PATCH", "/api/admin/users/1/sonarr-trusted", {"trusted": True}),
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
        print(f"Sonarr: 5/{TOTAL_STEPS} passed, {TOTAL_STEPS - 5} skipped - OK", flush=True)
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
        # Forced rows - a trusted user's list or an Include click - are MEANT to
        # bypass these rules; only the selection carries `monitor` for them. Even
        # forced, a film must never reach Sonarr.
        if it.get("monitor"):
            if e.get("format") == "MOVIE":
                leaked.append(f"{it['title']!r} is a MOVIE forced onto the list")
            continue
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
    # Refresh the snapshot FIRST, so the tag numbers asserted below are computed
    # by the code under test rather than read from a cache written before it.
    # Without this the marker-tag assertion is unauditable: its mutation lives in
    # `runSonarrSnapshot`, which a report-only test never executes, so the row
    # reported SURVIVED while the assertion itself was perfectly good.
    #
    # It costs one real read of Sonarr's library (~15 s here) and is the only
    # coverage the snapshot path has. Tolerated failure: an unreachable Sonarr
    # leaves the cached values in place and the tag assertions below skip.
    try:
        requests.post(f"{backend}/api/sonarr/snapshot", headers=auth, timeout=120)
    except requests.RequestException:
        pass
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
    # The assertion that actually bites. An earlier version compared `tagged`
    # against the whole library, which a regression to "carries ANY of our tags"
    # sails straight through - `anime` is on 692 series, comfortably under 2,327.
    # Comparing against the shared-tag count is the real invariant: the marker is
    # a DEDICATED tag, so it must be a strict subset whenever more than one tag
    # is applied.
    cfg = rep["config"]
    if rep["sonarr"]["observed"] and len(cfg["tags"]) > 1 and cfg["taggedAnyCount"]:
        if h["tagged"] >= cfg["taggedAnyCount"]:
            fail(8, f"history.tagged={h['tagged']} is not fewer than the "
                    f"{cfg['taggedAnyCount']} series carrying any of {cfg['tags']} - "
                    f"only the marker tag may count, never a shared one")
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

    # A failure its show has moved past must not be counted as needing attention.
    open_failures = [p for p in rep["pushes"]
                     if p["status"] in ("lookupFailed", "failed") and not p.get("superseded")]
    if rep["history"]["needsAttention"] != len(open_failures):
        fail(9, f"history.needsAttention is {rep['history']['needsAttention']} but "
                f"{len(open_failures)} failures are still open - superseded ones are counted")

    # --------- 10/13  The library check adds up and stays on our series ---------
    library_check_step(backend, auth)

    # --------- 11/13  Only trusted accounts' lists add shows ---------
    trusted_lists_step(backend, auth)

    # --------- 12/13  One status per row, and the counts add up ---------
    status_step(backend, auth)

    # --------- 13/13  The page agrees with Randomize's Hide Not English ---------
    randomize_parity_step(backend, auth)

    print(f"Sonarr: {TOTAL_STEPS}/{TOTAL_STEPS} passed - OK", flush=True)


LEVELS = ("broken", "check", "waiting", "ok")


def status_step(backend: str, auth: dict) -> None:
    step(12, "every row has one status, and Needs attention adds up")
    rep = requests.get(f"{backend}/api/sonarr/report", headers=auth, timeout=120).json()
    rows = rep["proposed"] + rep["rejected"]
    for r in rows:
        st = r.get("status") or {}
        if st.get("level") not in LEVELS or not st.get("code") or not isinstance(st.get("text"), str):
            fail(12, f"row {r.get('title')!r} has no usable status: {st!r}")
        if not isinstance(r.get("wanted"), bool) or r.get("watchable") not in (True, False, None):
            fail(12, f"row {r.get('title')!r} lacks wanted/watchable: {r.get('wanted')!r} {r.get('watchable')!r}")
        expect = r["wanted"] and st["level"] in ("broken", "check")
        if bool(r.get("attention")) != expect:
            fail(12, f"{r.get('title')!r}: attention={r.get('attention')} but wanted={r['wanted']} level={st['level']} "
                     f"- Needs attention must be exactly wanted and red or yellow")
        if r.get("reason") in ("format", "adult", "notFirstSeason") and r["wanted"] \
                and not (r.get("listedBy") or r.get("wantedBy") == "include"):
            fail(12, f"{r.get('title')!r} was skipped by a rule ({r['reason']}) yet counts as wanted")
    flagged = sum(1 for r in rows if r.get("attention"))
    if rep["summary"]["attention"] != flagged + len(rep["attention"]):
        fail(12, f"summary.attention is {rep['summary']['attention']} but {flagged} rows + "
                 f"{len(rep['attention'])} unattached failures need attention")
    # Every open failure is visible outside the collapsed history log.
    attached = {(r.get("anilistId"), r.get("tvdbId")) for r in rows
                if {r["status"]["code"], *[a["code"] for a in r["status"].get("also", [])]}
                & {"sonarrRejected", "addFailed"}}
    unattached = {u["tvdbId"] for u in rep["attention"]}
    for p in rep["pushes"]:
        if p["status"] not in ("lookupFailed", "failed") or p.get("superseded"):
            continue
        on_row = any(a == p.get("anilistId") or t == p["tvdbId"] for a, t in attached)
        if not on_row and p["tvdbId"] not in unattached:
            fail(12, f"open failure tvdb {p['tvdbId']} ({p.get('title')!r}) appears nowhere but the history log")
    step(12, f"PASS - {len(rows)} rows, {flagged} need attention, "
             f"{rep['summary']['broken']} broken / {rep['summary']['check']} check / "
             f"{rep['summary']['waiting']} waiting / {rep['summary']['ok']} ok")


def randomize_hides(info: dict | None, unaired: bool) -> bool:
    """Randomize's `isNotEnglish`, ported line for line (Randomize.svelte)."""
    if unaired or not info or info.get("unknown") or info.get("notAired"):
        return False
    if info.get("available") is False:
        return True
    return info.get("english") in ("none", "signsOnly")


def is_unaired(entry: dict, now_ms: int) -> bool:
    """`isUnaired` (stores/jellyfin.ts): status first, else the earliest possible day."""
    if entry.get("status"):
        return entry["status"] == "NOT_YET_RELEASED"
    d = entry.get("startDate") or {}
    if not d.get("year"):
        return False
    import calendar
    ms = calendar.timegm((d["year"], d.get("month") or 1, d.get("day") or 1, 0, 0, 0)) * 1000
    return ms > now_ms


def randomize_parity_step(backend: str, auth: dict) -> None:
    step(13, "on the admin's own list, the page's not-watchable rows are exactly what Hide Not English hides")
    if not requests.get(f"{backend}/api/jellyfin/status", headers=auth, timeout=15).json().get("configured"):
        step(13, "SKIP - Jellyfin is not configured")
        return
    rep = requests.get(f"{backend}/api/sonarr/report", headers=auth, timeout=120).json()
    mine = [r for r in rep["proposed"] + rep["rejected"] if r.get("onMyList") and r.get("anilistId")]
    if not mine:
        step(13, "SKIP - nothing on the admin's list for these seasons")
        return
    # The titles Randomize sends, from the season list it reads.
    entries: dict[int, dict] = {}
    for s in rep["seasons"]:
        r = requests.get(f"{backend}/api/anime", params={"season": s["season"], "year": s["year"]}, timeout=120)
        for e in r.json() if r.ok else []:
            entries[e["id"]] = e
    now_ms = int(time.time() * 1000)
    hidden: set[int] = set()
    for row in mine:
        e = entries.get(row["anilistId"])
        if not e:
            continue
        unaired = is_unaired(e, now_ms)
        info = None
        if not unaired:
            t = e.get("title") or {}
            titles = [x for x in (t.get("english"), t.get("romaji"), t.get("native")) if x][:10]
            info = requests.post(f"{backend}/api/jellyfin/availability", headers=auth, timeout=60,
                                 json={"mediaId": e["id"], "titles": titles, "fresh": True,
                                       "startDate": e.get("startDate")}).json()
        if randomize_hides(info, unaired):
            hidden.add(e["id"])
    # Re-read: the report must now see exactly the verdicts just resolved.
    rep = requests.get(f"{backend}/api/sonarr/report", headers=auth, timeout=120).json()
    by_id = {r["anilistId"]: r for r in rep["proposed"] + rep["rejected"]
             if r.get("onMyList") and r.get("anilistId") in entries}
    not_watchable = {a for a, r in by_id.items() if r.get("watchable") is False}
    if hidden != not_watchable:
        name = lambda a: (by_id.get(a) or {}).get("title") or a
        fail(13, f"Randomize would hide {sorted(map(name, hidden - not_watchable))} that the page calls watchable, "
                 f"and the page flags {sorted(map(name, not_watchable - hidden))} that Randomize keeps")
    for a in not_watchable:
        if by_id[a]["status"]["level"] != "broken":
            fail(13, f"{by_id[a]['title']!r} cannot be watched in English yet reads "
                     f"{by_id[a]['status']['level']} ({by_id[a]['status']['code']}) - it must be red")
    step(13, f"PASS - {len(by_id)} on the list, {len(hidden)} hidden by Hide Not English, the same {len(hidden)} red here")


def trusted_lists_step(backend: str, auth: dict) -> None:
    step(11, "a list adds shows only when its account is trusted")
    rep = requests.get(f"{backend}/api/sonarr/report", headers=auth, timeout=60).json()
    proposed_ids = {p.get("anilistId") for p in rep["proposed"]}
    # A show the rules skip that nobody trusted has listed, with a settled match.
    target = next((r for r in rep["rejected"]
                   if r.get("reason") == "notFirstSeason" and r.get("tvdbId")
                   and r.get("anilistId") and r["anilistId"] not in proposed_ids
                   and r.get("grade") in ("map", "confirmed", "dateVerified", "adminOverride")
                   and r.get("format") != "MOVIE"), None)
    if target is None:
        step(11, "SKIP - no rule-skipped show with a settled match to list")
        return
    season, year = target.get("season"), target.get("year")
    username, password = "sonarr_list_fixture", "sonarr_pw_123"
    r = requests.post(f"{backend}/api/auth/signup", json={"username": username, "password": password}, timeout=10)
    if r.status_code != 200:
        r = requests.post(f"{backend}/api/auth/login", json={"username": username, "password": password}, timeout=10)
    if r.status_code != 200 or not r.json().get("token"):
        fail(11, f"could not authenticate the fixture account: {r.status_code} {r.text[:160]}")
    fx = {"Authorization": f"Bearer {r.json()['token']}"}
    users = requests.get(f"{backend}/api/admin/users", headers=auth, timeout=30).json()["users"]
    me = next(u for u in users if u["username"] == username)
    put = lambda items: requests.put(f"{backend}/api/list", headers=fx, timeout=30,
                                     json={"season": season, "year": year, "items": items})

    def on_list() -> bool:
        rr = requests.get(f"{backend}/api/sonarr/report", headers=auth, timeout=60).json()
        return any(p.get("anilistId") == target["anilistId"] for p in rr["proposed"])

    try:
        put([{"mediaId": target["anilistId"]}])
        if on_list():
            fail(11, f"an untrusted account's list put shows on the auto-add list "
                     f"({target['title']!r}) - anyone who signs up could start downloads")
        rr = requests.patch(f"{backend}/api/admin/users/{me['id']}/sonarr-trusted", headers=auth,
                            json={"trusted": True}, timeout=30)
        if rr.status_code != 200:
            fail(11, f"trusting the account failed: {rr.status_code} {rr.text[:160]}")
        if not on_list():
            fail(11, f"a trusted account's list did not put {target['title']!r} on the auto-add list")
    finally:
        requests.patch(f"{backend}/api/admin/users/{me['id']}/sonarr-trusted", headers=auth,
                       json={"trusted": False}, timeout=30)
        put([])
    step(11, f"PASS - {target['title'][:40]!r} added only once the listing account was trusted")


SUB_STATES = ("fullEng", "signsOnly", "engAudio", "none", "unknown")
ROW_STATES = {"stale", "missing", "unknown", "allSubbed", "error"}


def jellyfin_episodes_direct(series_id: str) -> list | None:
    """A series' episodes straight from Jellyfin, bypassing the backend.

    Reads the URL and key read-only from the local DB, so the cross-check asks
    Jellyfin what the backend asked rather than trusting the backend's answer.
    Returns None when that is not possible, and the caller skips the comparison.
    """
    db = REPO / "backend" / "prisma" / "prisma" / "data.db"
    try:
        con = sqlite3.connect(f"file:{db.as_posix()}?mode=ro", uri=True)
        cfg = dict(con.execute(
            "SELECT key, value FROM AppConfig WHERE key IN ('jellyfinUrl', 'jellyfinApiKey')"
        ).fetchall())
        con.close()
        token = cfg["jellyfinApiKey"]
        r = requests.get(
            f"{cfg['jellyfinUrl'].rstrip('/')}/Shows/{series_id}/Episodes",
            params={"Fields": "Path,MediaStreams", "EnableImages": "false"},
            headers={"Authorization": f"MediaBrowser Token=\"{token}\""},
            timeout=60,
        )
        r.raise_for_status()
        return r.json().get("Items", [])
    except Exception:
        return None


def library_check_step(backend: str, auth: dict) -> None:
    step(10, "the library check: totals add up, scope is the marker tag")
    # A fresh snapshot first: it is what records which series are ours, so a
    # scoping bug there only shows up in a snapshot taken by the code under test.
    snap = requests.post(f"{backend}/api/sonarr/snapshot", headers=auth, timeout=120).json()
    if snap.get("error") == "Sonarr is not configured":
        step(10, "SKIP - Sonarr is not configured")
        return
    if snap.get("ok") and isinstance(snap.get("ours"), list):
        # Two independent computations of the same set: `taggedIds` is the
        # marker-tag filter that has always existed, `ours` is the new list the
        # library check reads. The `anime` tag sits on 692 series here, so a
        # list built from any applied tag would not match.
        ours_ids = {o["tvdbId"] for o in snap["ours"]}
        tagged = set(snap.get("taggedIds") or [])
        if ours_ids != tagged:
            fail(10, f"the snapshot lists {len(ours_ids)} series as ours but {len(tagged)} carry "
                     f"the marker tag - the library check's scope drifted from the marker")
    rr = requests.post(f"{backend}/api/sonarr/library/check", headers=auth, timeout=120)
    if rr.status_code not in (200, 202):
        fail(10, f"POST /library/check returned {rr.status_code} {rr.text[:160]}")
    # A run another caller started is fine - wait for it to land.
    for _ in range(60):
        rep = requests.get(f"{backend}/api/sonarr/report", headers=auth, timeout=60).json()
        if not rep["library"]["running"]:
            break
        time.sleep(2)
    lib = rep["library"]
    last = lib.get("last")
    if last is None:
        if lib.get("lastError") and "not configured" in lib["lastError"]:
            step(10, f"SKIP - {lib['lastError']}")
            return
        fail(10, f"no stored audit after a check (lastError={lib.get('lastError')!r})")

    rows, totals = last["rows"], last["totals"]
    if totals["series"] != len(rows):
        fail(10, f"totals.series={totals['series']} but {len(rows)} rows")
    audited = [r for r in rows if r.get("audit")]
    if totals["episodes"] != sum(r["audit"]["episodes"] for r in audited):
        fail(10, "totals.episodes is not the sum of the rows")
    for k in SUB_STATES:
        if totals["counts"][k] != sum(r["audit"]["counts"][k] for r in audited):
            fail(10, f"totals.counts.{k} is not the sum of the rows")
    for r in rows:
        if r["state"] not in ROW_STATES:
            fail(10, f"row {r['title']!r} has state {r['state']!r}")
        a = r.get("audit")
        if not a:
            continue
        if sum(a["counts"][k] for k in SUB_STATES) != a["episodes"]:
            fail(10, f"{r['title']!r}: subtitle counts do not sum to its episodes")
        if not 0 <= a.get("dubbed", 0) <= a["episodes"]:
            fail(10, f"{r['title']!r}: {a.get('dubbed')} dubbed of {a['episodes']} episodes")
        if sum(1 for p in a["problems"] if p["sub"] == "none") != a["counts"]["none"]:
            fail(10, f"{r['title']!r}: a no-subs episode is missing from its problem list")
    if totals.get("dubbed") != sum(r["audit"].get("dubbed", 0) for r in audited):
        fail(10, "totals.dubbed is not the sum of the rows")
    if totals["seriesMissing"] != sum(1 for r in rows if r["state"] == "missing"):
        fail(10, "totals.seriesMissing disagrees with the rows")

    # Scope: the marker-tagged series with files plus the season's held series
    # we did not add (`seasonHeld`), as the snapshot saw them - nothing else.
    snapshot = rep.get("snapshot") or {}
    if isinstance(snapshot.get("ours"), list):
        scope = snapshot["ours"] + (snapshot.get("seasonHeld") or [])
        want = {o["sonarrId"] for o in scope if o.get("episodeFileCount", 0) > 0}
        got = {r["sonarrId"] for r in rows}
        if want != got:
            fail(10, f"audited {len(got)} series, the snapshot scope has {len(want)} with "
                     f"files - scope drifted (extra {sorted(got - want)[:5]}, missing "
                     f"{sorted(want - got)[:5]})")

    # One series against Jellyfin directly: "none" means no English subtitle
    # track and no English audio, which is checkable without the backend's rules.
    target = next((r for r in audited
                   if r["audit"]["source"] == "jellyfin" and r["audit"]["stale"] == 0
                   and r["audit"]["counts"]["none"] > 0 and r.get("jellyfinId")), None)
    note = "no series to cross-check"
    if target:
        eps = jellyfin_episodes_direct(target["jellyfinId"])
        files = [e for e in (eps or []) if e.get("Path")]
        if eps is None:
            note = "Jellyfin not readable directly - cross-check skipped"
        elif len(files) != target["audit"]["episodes"]:
            note = (f"{target['title'][:30]!r}: {len(files)} Jellyfin files vs "
                    f"{target['audit']['episodes']} Sonarr episodes (multi-episode files) - skipped")
        else:
            def is_en(code):
                return (code or "").lower() in ("en", "eng", "english")
            raw = 0
            for e in files:
                streams = e.get("MediaStreams") or []
                en_sub = any(m.get("Type") == "Subtitle" and (
                    is_en(m.get("Language")) or "english" in (m.get("Title") or "").lower())
                    for m in streams)
                en_audio = any(m.get("Type") == "Audio" and is_en(m.get("Language")) for m in streams)
                if streams and not en_sub and not en_audio:
                    raw += 1
            if raw != target["audit"]["counts"]["none"]:
                fail(10, f"{target['title']!r}: Jellyfin shows {raw} episodes with no English "
                         f"track at all, the audit says {target['audit']['counts']['none']}")
            note = f"{target['title'][:30]!r} matches Jellyfin ({raw} raw)"
    step(10, f"PASS - {len(rows)} series, {totals['episodes']} episodes, "
             f"{totals['counts']['none'] + totals['counts']['signsOnly']} without English subs, "
             f"{totals['seriesStale']} stale; {note}")


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nSonarr: FAIL - backend unreachable: {e}", flush=True)
        sys.exit(1)
