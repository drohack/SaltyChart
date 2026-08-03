"""
Pre-deploy smoke test: Jellyfin integration endpoints (/api/jellyfin/*).

Runs against http://localhost:3000. Auth gates and the unconfigured shape are
always tested; the availability/stream/subtitle steps that need a live Jellyfin
connection are skipped (still exit 0) when the server reports configured=false
— the URL + API key live in the AppConfig DB table, set via the /admin page.

Usage:
  py -3.13 -u tools/tests/test_jellyfin.py [--backend http://localhost:3000]

Exits 0 if all steps pass (or the configured-only steps were skipped),
1 on any failure. Each progress line is self-contained per the global
CLAUDE.md convention:
  [k/8 Jellyfin] step name — detail
"""
import argparse
import atexit
import subprocess
import sys
from datetime import date
from pathlib import Path

import requests

TOTAL_STEPS = 11


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} Jellyfin] {msg}", flush=True)


def fail(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} Jellyfin] FAIL — {msg}", flush=True)
    sys.exit(1)


REPO = Path(__file__).resolve().parents[2]


def admin_token() -> str:
    """A JWT for ADMIN_USER_ID, signed with the backend's own secret.

    The identity endpoints are admin-gated and the fixture user here never is,
    so without minting one they can't be exercised at all. Same helper as
    `test_ui_interactions.admin_token` — signed through node so the suite gains
    no dependency and signs exactly the way the app does.
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


def current_season_year() -> tuple[str, int]:
    """The calendar season, so the test isn't pinned to a hardcoded one."""
    today = date.today()
    season = ("WINTER", "SPRING", "SUMMER", "FALL")[(today.month - 1) // 3]
    return season, today.year


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", default="http://localhost:3000")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    backend = args.backend.rstrip("/")
    # A fixed fixture account, reused across runs: a per-run signup left a new
    # user behind every time, and enough of them eventually pushed the newest
    # one out of /api/users' 20-row window and broke an unrelated test.
    username = "jf_test_fixture"
    password = "jf_pw_123"

    print(f"Jellyfin smoke test — backend={backend}", flush=True)

    # ───────── 1/8  Fixture user (signup first run, login after) ─────────
    step(1, f"auth as {username}")
    r = requests.post(f"{backend}/api/auth/signup",
                      json={"username": username, "password": password}, timeout=5)
    if r.status_code != 200:
        r = requests.post(f"{backend}/api/auth/login",
                          json={"username": username, "password": password}, timeout=5)
    if r.status_code != 200 or not r.json().get("token"):
        fail(1, f"could not authenticate: {r.status_code} {r.text[:200]}")
    token = r.json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    step(1, "PASS — got JWT")

    # ───────── 2/8  Auth gates ─────────
    step(2, "unauthenticated /status + /availability — expect 401")
    r = requests.get(f"{backend}/api/jellyfin/status", timeout=5)
    if r.status_code != 401:
        fail(2, f"/status without token: expected 401, got {r.status_code}")
    r = requests.post(f"{backend}/api/jellyfin/availability",
                      json={"mediaId": 1, "titles": ["x"]}, timeout=5)
    if r.status_code != 401:
        fail(2, f"/availability without token: expected 401, got {r.status_code}")
    step(2, "PASS — both 401")

    # ───────── 3/8  Admin gates ─────────
    step(3, "config endpoints as non-admin — expect 403 ADMIN_REQUIRED")
    checks = [
        ("GET", "/api/jellyfin/config", None),
        ("PUT", "/api/jellyfin/config", {"url": "http://example.invalid"}),
        ("POST", "/api/jellyfin/config/test", {"url": "http://example.invalid"}),
    ]
    for method, path, payload in checks:
        r = requests.request(method, f"{backend}{path}", headers=auth, json=payload, timeout=5)
        if r.status_code != 403 or r.json().get("code") != "ADMIN_REQUIRED":
            fail(3, f"{method} {path}: expected 403 ADMIN_REQUIRED, got {r.status_code} {r.text[:160]}")
    step(3, "PASS — all three admin endpoints gated")

    # ───────── 4/8  Status shape ─────────
    step(4, "GET /api/jellyfin/status")
    r = requests.get(f"{backend}/api/jellyfin/status", headers=auth, timeout=5)
    body = r.json() if r.status_code == 200 else {}
    if r.status_code != 200 or not isinstance(body.get("configured"), bool) \
            or not isinstance(body.get("isAdmin"), bool):
        fail(4, f"unexpected status response: {r.status_code} {r.text[:200]}")
    if body["isAdmin"]:
        fail(4, "fixture user unexpectedly reported as admin")
    configured = body["configured"]
    step(4, f"PASS — configured={configured}, isAdmin=False")

    # ───────── 5/8  Validation + the ?token= paths ─────────
    step(5, "malformed bodies and query-token gates")
    r = requests.post(f"{backend}/api/jellyfin/availability",
                      headers=auth, json={"mediaId": "nope"}, timeout=5)
    if r.status_code != 400 or r.json().get("code") != "BAD_REQUEST":
        fail(5, f"expected 400 BAD_REQUEST, got {r.status_code} {r.text[:200]}")
    # `<track src>` and libass fetches authenticate via ?token=, which bypasses
    # requireAuth and is hand-rolled — the riskiest auth code in the router.
    for label, url in (
        ("no token", f"{backend}/api/jellyfin/subtitles?itemId=abcdef123456&mediaSourceId=abcdef123456&index=0"),
        ("bad token", f"{backend}/api/jellyfin/subtitles?itemId=abcdef123456&mediaSourceId=abcdef123456&index=0&token=not.a.jwt"),
        ("bad token", f"{backend}/api/jellyfin/stream/System/Info?token=not.a.jwt"),
        ("bad token", f"{backend}/api/jellyfin/attachments?itemId=abcdef123456&mediaSourceId=abcdef123456&index=0&token=not.a.jwt"),
    ):
        r = requests.get(url, timeout=5)
        if r.status_code != 401:
            fail(5, f"{label} on {url.split('?')[0]}: expected 401, got {r.status_code}")
    step(5, "PASS — 400 on bad body, 401 on every ?token= path")

    if not configured:
        for n in (6, 7, 8):
            step(n, "SKIP — Jellyfin not configured (set URL+key on /admin to enable)")
        print("Jellyfin: 5/8 passed, 3 skipped (unconfigured) — OK", flush=True)
        return

    # ───────── 6/8  Availability (live Jellyfin) ─────────
    season, year = current_season_year()
    step(6, f"availability: nonsense title → available=false (corpus: {season} {year})")
    r = requests.post(f"{backend}/api/jellyfin/availability", headers=auth,
                      json={"mediaId": 999999901, "titles": ["zzz no such show xyz 42"]},
                      timeout=90)
    body = r.json() if r.status_code == 200 else {}
    if r.status_code != 200 or body.get("available") is not False:
        fail(6, f"expected available=false, got {r.status_code} {r.text[:200]}")
    # A dead Jellyfin answers available=false too — but with unknown=true.
    # Without this the step passes while the integration is entirely broken.
    if body.get("unknown"):
        fail(6, f"Jellyfin reported configured but the lookup failed: {body}")

    r = requests.get(f"{backend}/api/anime?season={season}&year={year}&format=TV", timeout=120)
    if r.status_code != 200 or not isinstance(r.json(), list) or not r.json():
        fail(6, f"could not load {season} {year} anime to test with: {r.status_code} {r.text[:200]}")
    show = r.json()[0]
    titles = [t for t in (show.get("title") or {}).values() if t]
    r = requests.post(f"{backend}/api/jellyfin/availability", headers=auth,
                      json={"mediaId": show["id"], "titles": titles[:10]}, timeout=90)
    if r.status_code != 200:
        fail(6, f"availability with real titles: {r.status_code} {r.text[:200]}")
    body = r.json()
    if not isinstance(body.get("available"), bool):
        fail(6, f"availability shape wrong: {body}")
    if body["available"]:
        for key in ("itemId", "mediaSourceId", "libraryTitle"):
            if not body.get(key):
                fail(6, f"available=true but missing {key}: {body}")
        if body.get("matchedBy") not in ("id", "title"):
            fail(6, f"available=true but matchedBy is {body.get('matchedBy')!r}: {body}")

    # The id tier has to be shown to still fire. Accepting `matchedBy in
    # ("id", "title")` above is satisfied by a build where the AniList->TVDB
    # chain is completely dead and every match fell back to fuzzy titles — a
    # regression that is invisible here, degrades silently, and has already
    # produced a real false positive (2026 "Nanoha EXCEEDS" -> 2004 "Nanoha").
    # Measured against this library a season resolves ~35 of 52 by id, so a
    # floor of one is far below the noise while still catching a total loss.
    #
    # Eight, not twenty: each lookup makes Jellyfin resolve a series and its
    # episode list, and this test runs on every suite pass and every mutation
    # audit row. Twenty was a meaningful share of the load that pegged the
    # server, and buys nothing — ~15 of 20 matched by id, so the floor of one is
    # never close either way.
    tiers = {"id": 0, "title": 0, "missing": 0}
    for s in requests.get(f"{backend}/api/anime?season={season}&year={year}&format=TV",
                          timeout=120).json()[:8]:
        t = [x for x in (s.get("title") or {}).values() if x]
        if not t:
            continue
        # `fresh` is mandatory here, not a nicety. This step exists to prove the
        # AniList->TVDB id tier still fires, and the availability cache now
        # survives a restart — so without it the sample reads back a previous
        # run's `matchedBy` values and passes happily against a build where the
        # tier is entirely dead. A mutation audit caught exactly that: disabling
        # the tier changed nothing, because nothing re-resolved.
        av = requests.post(f"{backend}/api/jellyfin/availability", headers=auth,
                           json={"mediaId": s["id"], "titles": t[:10], "fresh": True},
                           timeout=90).json()
        if av.get("unknown"):
            continue
        tiers[av["matchedBy"] if av.get("available") else "missing"] += 1
    matched = tiers["id"] + tiers["title"]
    if not matched:
        step(6, f"PASS — availability well-formed (nothing from {season} {year} "
                f"is in the library, so the match tiers can't be checked)")
    else:
        if not tiers["id"]:
            fail(6, f"{matched} of the sampled series matched, but NONE by id — the "
                    f"AniList->TVDB tier is dead and everything is falling back to "
                    f"fuzzy titles: {tiers}")
        step(6, f"PASS — availability well-formed; match tiers {tiers['id']} by id, "
                f"{tiers['title']} by title, {tiers['missing']} missing")

    # ───────── 7/8  Stream proxy + no credential in the manifest ─────────
    step(7, "stream proxy reaches Jellyfin, and manifests carry no API key")
    r = requests.get(f"{backend}/api/jellyfin/stream/System/Info", headers=auth, timeout=20)
    if r.status_code != 200 or b"ServerName" not in r.content:
        fail(7, f"proxied /System/Info: {r.status_code} {r.content[:200]!r}")
    # Find something playable and pull its master playlist through the proxy.
    playable = None
    for s in requests.get(f"{backend}/api/anime?season={season}&year={year}&format=TV",
                          timeout=120).json()[:12]:
        t = [x for x in (s.get("title") or {}).values() if x]
        av = requests.post(f"{backend}/api/jellyfin/availability", headers=auth,
                           json={"mediaId": s["id"], "titles": t[:10]}, timeout=90).json()
        if av.get("available"):
            # Carry the inputs through: step 11 has to re-ask about this exact
            # entry after writing an override, and the response alone doesn't
            # say which AniList entry produced it.
            av["mediaId"] = s["id"]
            av["titles"] = t[:10]
            playable = av
            break
    if not playable:
        step(7, "PASS — proxy reached Jellyfin (no playable episode in this season to check a manifest)")
    else:
        pb = requests.get(f"{backend}/api/jellyfin/playback/{playable['itemId']}"
                          f"?mediaSourceId={playable['mediaSourceId']}", headers=auth, timeout=30)
        if pb.status_code != 200 or not pb.json().get("playSessionId"):
            fail(7, f"/playback did not return a session: {pb.status_code} {pb.text[:200]}")
        # Jellyfin writes `ApiKey=<the key>` into the TranscodingUrl it returns,
        # and this response goes straight to a browser. The manifest guard below
        # does not cover it: that inspects response *bodies*, so a leak here
        # surfaced only as "video never advanced" from a completely different
        # test. Assert the strip directly, where the diagnostic is the truth.
        turl = pb.json().get("transcodingUrl") or ""
        for leak in ("api_key", "apikey", "x-emby-token"):
            if leak in turl.lower():
                fail(7, f"/playback returned a transcodingUrl containing a credential "
                        f"({leak}) — it would be handed to every viewer")
        psid = pb.json()["playSessionId"]
        # Registered before the stream is started, not after the assertions.
        # `fail()` exits via SystemExit, so on any failure below the stop call at
        # the end of this step never ran and the encode was left going — which
        # is precisely what happens on every mutation-audit row.
        atexit.register(lambda: requests.post(
            f"{backend}/api/jellyfin/playback/stop", headers=auth,
            json={"playSessionId": psid}, timeout=10))
        q = (f"mediaSourceId={playable['mediaSourceId']}&playSessionId={psid}"
             f"&videoCodec=h264&audioCodec=aac&container=ts&deviceId=saltychart"
             f"&maxStreamingBitrate=120000000")
        m = requests.get(f"{backend}/api/jellyfin/stream/Videos/{playable['itemId']}/master.m3u8?{q}",
                         headers=auth, timeout=60)
        if m.status_code != 200 or b"#EXTM3U" not in m.content:
            fail(7, f"master.m3u8 through the proxy: {m.status_code} {m.content[:200]!r}")
        # Jellyfin embeds the caller's API key in subtitle rendition URIs when
        # asked for HLS subtitles. We never ask, and the proxy refuses such a
        # manifest — this asserts the key genuinely never reaches a browser.
        lowered = m.text.lower()
        for leak in ("api_key", "apikey", "x-emby-token", "mediabrowser token"):
            if leak in lowered:
                fail(7, f"manifest contains a credential ({leak}) — it would reach the browser")
        requests.post(f"{backend}/api/jellyfin/playback/stop", headers=auth,
                      json={"playSessionId": psid}, timeout=20)
        step(7, "PASS — proxy works, manifest carries no credential")

    # ───────── 8/10  Subtitles ─────────
    step(8, "subtitle track fetch")
    if not playable:
        step(8, "SKIP — no playable episode in this season")
    else:
        pb = requests.get(f"{backend}/api/jellyfin/playback/{playable['itemId']}"
                          f"?mediaSourceId={playable['mediaSourceId']}", headers=auth, timeout=30).json()
        subs = [s for s in pb.get("subtitles", []) if s.get("isTextSubtitle")]
        if not subs:
            step(8, "SKIP — this episode has no text subtitle tracks")
        else:
            s0 = subs[0]
            fmt = "ass" if s0["codec"] in ("ass", "ssa") else "vtt"
            r = requests.get(f"{backend}/api/jellyfin/subtitles", timeout=120, params={
                "itemId": playable["itemId"], "mediaSourceId": playable["mediaSourceId"],
                "index": s0["index"], "format": fmt, "token": token})
            if r.status_code != 200 or len(r.content) < 200:
                fail(8, f"subtitle fetch ({fmt}): {r.status_code}, {len(r.content)} bytes")
            head = r.content[:400].decode("utf-8", "replace")
            ok = ("[Script Info]" in head or "[V4+ Styles]" in head) if fmt == "ass" \
                else head.lstrip("﻿").startswith("WEBVTT")
            if not ok:
                fail(8, f"subtitle body does not look like {fmt}: {head[:80]!r}")
            step(8, f"PASS — {fmt} track fetched, {len(r.content):,} bytes")

    # ───────── 9/10  Subtitles and fonts are cacheable ─────────
    #
    # A rewatch, or reopening the same episode, must not refetch a font pack.
    # These are immutable for an item+index: replacing the release changes the
    # item id too.
    step(9, "subtitles and attachments are cacheable")
    if not playable:
        step(9, "SKIP — no playable episode in this season")
    else:
        # Indices are the file's own stream numbers — they do NOT start at 0,
        # so they have to come from the playback info or every request 502s.
        pb = requests.get(f"{backend}/api/jellyfin/playback/{playable['itemId']}"
                          f"?mediaSourceId={playable['mediaSourceId']}",
                          headers=auth, timeout=30).json()
        wanted = [("subtitles", s["index"], {"format": "vtt"})
                  for s in pb.get("subtitles", [])[:1]]
        wanted += [("attachments", a["index"], {}) for a in pb.get("attachments", [])[:1]]
        if not wanted:
            step(9, "SKIP — episode has no subtitle tracks or attachments")
        else:
            cacheable = []
            for kind, index, extra in wanted:
                r = requests.get(f"{backend}/api/jellyfin/{kind}", timeout=90, params={
                    "itemId": playable["itemId"], "mediaSourceId": playable["mediaSourceId"],
                    "index": index, "token": token, **extra})
                if r.status_code != 200:
                    fail(9, f"/{kind} index {index}: {r.status_code} {r.text[:120]}")
                cc = r.headers.get("Cache-Control", "")
                if "max-age" not in cc:
                    fail(9, f"/{kind} has no Cache-Control max-age (got {cc!r})")
                cacheable.append(f"{kind}[{index}]={cc}")
            step(9, f"PASS — {', '.join(cacheable)}")

    # ───────── 10/10  WebVTT header is well-formed ─────────
    #
    # Jellyfin emits `Region:` *after* the blank line that closes the WebVTT
    # header. Per spec that blank line ends the header, so a browser parser
    # reads `Region:` as a cue identifier and then throws on the missing
    # timestamp — costing a console error and one dropped cue. The proxy lifts
    # those lines back into the header; this guards that.
    step(10, "WebVTT header: region definitions sit inside the header")
    if not playable:
        step(10, "SKIP — no playable episode in this season")
    else:
        pb = requests.get(f"{backend}/api/jellyfin/playback/{playable['itemId']}"
                          f"?mediaSourceId={playable['mediaSourceId']}",
                          headers=auth, timeout=30).json()
        text_subs = [s for s in pb.get("subtitles", []) if s.get("isTextSubtitle")]
        if not text_subs:
            step(10, "SKIP — no text subtitle tracks on this episode")
        else:
            r = requests.get(f"{backend}/api/jellyfin/subtitles", timeout=120, params={
                "itemId": playable["itemId"], "mediaSourceId": playable["mediaSourceId"],
                "index": text_subs[0]["index"], "format": "vtt", "token": token})
            body = r.content.decode("utf-8-sig", "replace").replace("\r\n", "\n")
            head, _, rest = body.partition("\n\n")
            if not head.startswith("WEBVTT"):
                fail(10, f"not WebVTT: {head[:60]!r}")
            stray = [ln for ln in rest.split("\n\n")[0].split("\n")
                     if ln.startswith(("Region:", "STYLE", "NOTE:"))]
            if stray:
                fail(10, f"header line stranded below the blank line: {stray[0][:70]!r}")
            cues = body.count(" --> ")
            if cues < 1:
                fail(10, "no cues in the converted WebVTT")
            regions = head.count("Region:")
            step(10, f"PASS — {cues} cues, {regions} region(s) inside the header")

    # ───────── 11/11  An identity override changes the verdict ─────────
    #
    # The admin matching page's entire promise is that a correction sticks. If
    # the override layer were skipped, the page would report success and change
    # nothing — worse than not offering the control, because it looks fixed.
    #
    # Asserted as a round trip against a show the library really has: point its
    # AniList id at a TVDB id nothing carries, and availability must flip to
    # false. With the negative-evidence rule that is the whole mechanism —
    # a known id the library lacks ends the lookup instead of falling back to
    # titles.
    step(11, "an identity override changes the verdict")
    admin = admin_token()
    if not admin:
        step(11, "SKIP — could not sign an admin token (node or backend/.env missing)")
    elif not playable:
        step(11, "SKIP — no available show in this season to override")
    else:
        ah = {"Authorization": f"Bearer {admin}"}
        mid = playable["mediaId"]
        titles = playable["titles"]
        body = {"mediaId": mid, "titles": titles, "fresh": True}
        before = requests.post(f"{backend}/api/jellyfin/availability",
                               headers=auth, json=body, timeout=60).json()
        if not before.get("available"):
            step(11, "SKIP — control show is not available to begin with")
        else:
            w = requests.put(f"{backend}/api/jellyfin/identity", headers=ah, timeout=20,
                             json={"anilistId": mid, "tvdbId": "99999999", "confirmed": True,
                                   "note": "test_jellyfin step 11"})
            if w.status_code != 200:
                fail(11, f"could not write the override: {w.status_code} {w.text[:160]}")
            try:
                after = requests.post(f"{backend}/api/jellyfin/availability",
                                      headers=auth, json=body, timeout=60).json()
                if after.get("available"):
                    fail(11, "override did not change the verdict — a correction saved on "
                             f"/admin/matching has no effect (still {after.get('libraryTitle')!r})")
            finally:
                # Always put it back: a stray override would quietly break this
                # show for every later run and for the live site.
                requests.delete(f"{backend}/api/jellyfin/identity/{mid}", headers=ah, timeout=20)
            restored = requests.post(f"{backend}/api/jellyfin/availability",
                                     headers=auth, json=body, timeout=60).json()
            if not restored.get("available"):
                fail(11, "removing the override did not restore availability — the row was "
                         "not cleaned up and this show is now broken for everyone")

            # The Reject button, which is a DIFFERENT path and shipped broken.
            # A rejection carries no ids at all, so unless it short-circuits
            # before matching it falls straight through to the title tier — i.e.
            # to the very match being rejected. The row saved, the entry left the
            # review list, and the wrong Watch button stayed on screen. Nothing
            # above catches it, because that case writes a bogus id instead.
            w = requests.put(f"{backend}/api/jellyfin/identity", headers=ah, timeout=20,
                             json={"anilistId": mid, "tvdbId": None, "tmdbId": None,
                                   "confirmed": True, "rejected": True,
                                   "note": "test_jellyfin step 11 reject"})
            if w.status_code != 200:
                fail(11, f"could not write the rejection: {w.status_code} {w.text[:160]}")
            try:
                rej = requests.post(f"{backend}/api/jellyfin/availability",
                                    headers=auth, json=body, timeout=60).json()
                if rej.get("available"):
                    fail(11, "override did not change the verdict — a rejection with no ids "
                             "fell through to the title tier, so Reject on /admin/matching "
                             f"leaves the Watch button in place ({rej.get('libraryTitle')!r})")
            finally:
                requests.delete(f"{backend}/api/jellyfin/identity/{mid}", headers=ah, timeout=20)
            # A film id must resolve against FILMS, and — when we don't hold the
            # film — must NOT fall through to title-matching a list that contains
            # only TV series. That fall-through is where "The Last Blossom" ->
            # *House*, "ChaO" -> *ChäoS;Head* and "Demon Slayer: Infinity Castle"
            # -> the television show came from: 26 category errors across 8
            # seasons, against exactly 1 case where it found something real.
            w = requests.put(f"{backend}/api/jellyfin/identity", headers=ah, timeout=20,
                             json={"anilistId": mid, "tmdbId": "999999999",
                                   "tmdbKind": "movie", "note": "test_jellyfin film"})
            if w.status_code != 200:
                fail(11, f"could not write the film override: {w.status_code} {w.text[:160]}")
            try:
                film = requests.post(f"{backend}/api/jellyfin/availability",
                                     headers=auth, json=body, timeout=60).json()
                # Order matters: check the *specific* symptom first. When the
                # fall-through is restored the series match is usually available
                # too, so a generic "resolved anyway" would fire first and the
                # mutation row would be caught for the wrong reason — red, but
                # naming nothing.
                if film.get("libraryTitle"):
                    fail(11, "a film we do not hold fell through to a SERIES title match "
                             f"({film.get('libraryTitle')!r}) — the category error is back")
                if film.get("available"):
                    fail(11, "override did not change the verdict — a film we do not hold "
                             "resolved anyway")
            finally:
                requests.delete(f"{backend}/api/jellyfin/identity/{mid}", headers=ah, timeout=20)
            step(11, "PASS — wrong id, outright rejection and an unheld film all flip the "
                     "verdict, and clearing restores")

    print(f"Jellyfin: {TOTAL_STEPS}/{TOTAL_STEPS} passed — OK", flush=True)


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nJellyfin: FAIL — backend unreachable: {e}", flush=True)
        sys.exit(1)
