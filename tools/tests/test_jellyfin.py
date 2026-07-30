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
import sys
from datetime import date

import requests

TOTAL_STEPS = 8


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} Jellyfin] {msg}", flush=True)


def fail(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} Jellyfin] FAIL — {msg}", flush=True)
    sys.exit(1)


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
    step(6, "PASS — availability responses well-formed")

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
            playable = av
            break
    if not playable:
        step(7, "PASS — proxy reached Jellyfin (no playable episode in this season to check a manifest)")
    else:
        pb = requests.get(f"{backend}/api/jellyfin/playback/{playable['itemId']}"
                          f"?mediaSourceId={playable['mediaSourceId']}", headers=auth, timeout=30)
        if pb.status_code != 200 or not pb.json().get("playSessionId"):
            fail(7, f"/playback did not return a session: {pb.status_code} {pb.text[:200]}")
        psid = pb.json()["playSessionId"]
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

    # ───────── 8/8  Subtitles ─────────
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

    print(f"Jellyfin: {TOTAL_STEPS}/{TOTAL_STEPS} passed — OK", flush=True)


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nJellyfin: FAIL — backend unreachable: {e}", flush=True)
        sys.exit(1)
