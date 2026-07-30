"""
Pre-deploy smoke test: Plex integration endpoints (/api/plex/*).

Runs against http://localhost:3000. Auth gates and the unconfigured shape are
always tested; the availability/stream steps that need a live Plex connection
are skipped (still exit 0) when the server reports configured=false — the
Plex URL + token live in the AppConfig DB table, set via the /admin page.

Usage:
  py -3.13 -u tools/tests/test_plex.py [--backend http://localhost:3000]

Exits 0 if all steps pass (or the configured-only steps were skipped),
1 on any failure. Each progress line is self-contained per the global
CLAUDE.md convention:
  [k/7 Plex] step name — detail
"""
import argparse
import sys
from datetime import date

import requests

TOTAL_STEPS = 7


def current_season_year() -> tuple[str, int]:
    """The calendar season, so the test isn't pinned to a hardcoded one."""
    today = date.today()
    season = ("WINTER", "SPRING", "SUMMER", "FALL")[(today.month - 1) // 3]
    return season, today.year


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} Plex] {msg}", flush=True)


def fail(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} Plex] FAIL — {msg}", flush=True)
    sys.exit(1)


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
    username = "plex_test_fixture"
    password = "plex_pw_123"

    print(f"Plex smoke test — backend={backend}", flush=True)

    # ───────── 1/7  Fixture user (signup first run, login after) ─────────
    step(1, f"auth as {username}")
    r = requests.post(f"{backend}/api/auth/signup",
                      json={"username": username, "password": password}, timeout=5)
    if r.status_code != 200:
        r = requests.post(f"{backend}/api/auth/login",
                          json={"username": username, "password": password}, timeout=5)
    if r.status_code != 200 or not r.json().get("token"):
        fail(1, f"could not authenticate: {r.status_code} {r.text[:200]}")
    auth = {"Authorization": f"Bearer {r.json()['token']}"}
    step(1, "PASS — got JWT")

    # ───────── 2/7  Auth gates ─────────
    step(2, "unauthenticated /status + /availability — expect 401")
    r = requests.get(f"{backend}/api/plex/status", timeout=5)
    if r.status_code != 401:
        fail(2, f"/status without token: expected 401, got {r.status_code}")
    r = requests.post(f"{backend}/api/plex/availability",
                      json={"mediaId": 1, "titles": ["x"]}, timeout=5)
    if r.status_code != 401:
        fail(2, f"/availability without token: expected 401, got {r.status_code}")
    step(2, "PASS — both 401")

    # ───────── 3/7  Admin gate for non-admin ─────────
    step(3, "GET /api/plex/config as non-admin — expect 403 ADMIN_REQUIRED")
    r = requests.get(f"{backend}/api/plex/config", headers=auth, timeout=5)
    if r.status_code != 403 or r.json().get("code") != "ADMIN_REQUIRED":
        fail(3, f"expected 403 ADMIN_REQUIRED, got {r.status_code} {r.text[:200]}")
    step(3, "PASS — 403 for non-admin")

    # ───────── 4/7  Status shape ─────────
    step(4, "GET /api/plex/status")
    r = requests.get(f"{backend}/api/plex/status", headers=auth, timeout=5)
    body = r.json() if r.status_code == 200 else {}
    if r.status_code != 200 or not isinstance(body.get("configured"), bool) \
            or not isinstance(body.get("isAdmin"), bool):
        fail(4, f"unexpected status response: {r.status_code} {r.text[:200]}")
    if body["isAdmin"]:
        fail(4, "fixture user unexpectedly reported as admin")
    configured = body["configured"]
    step(4, f"PASS — configured={configured}, isAdmin=False")

    # ───────── 5/7  Availability validation ─────────
    step(5, "POST /api/plex/availability with bad body — expect 400")
    r = requests.post(f"{backend}/api/plex/availability",
                      headers=auth, json={"mediaId": "nope"}, timeout=5)
    if r.status_code != 400 or r.json().get("code") != "BAD_REQUEST":
        fail(5, f"expected 400 BAD_REQUEST, got {r.status_code} {r.text[:200]}")
    # The admin-only writes and the two hand-rolled JWT paths (?token= is how
    # <track src> authenticates) each get one gate check — they're the riskiest
    # auth code in the router and were otherwise untested.
    for method, path, payload in (
        ("PUT", "/api/plex/config", {"url": "http://example.invalid"}),
        ("POST", "/api/plex/config/test", {"url": "http://example.invalid"}),
    ):
        r = requests.request(method, f"{backend}{path}", headers=auth, json=payload, timeout=5)
        if r.status_code != 403 or r.json().get("code") != "ADMIN_REQUIRED":
            fail(5, f"{method} {path} as non-admin: expected 403 ADMIN_REQUIRED, "
                    f"got {r.status_code} {r.text[:200]}")
    for label, url in (
        ("no token", f"{backend}/api/plex/subtitles?partId=1&streamIndex=0"),
        ("bad token", f"{backend}/api/plex/subtitles?partId=1&streamIndex=0&token=not.a.jwt"),
        ("bad token", f"{backend}/api/plex/stream/identity?token=not.a.jwt"),
    ):
        r = requests.get(url, timeout=5)
        if r.status_code != 401:
            fail(5, f"{label} on {url.split('?')[0]}: expected 401, got {r.status_code}")
    step(5, "PASS — 400 on malformed body, admin writes + ?token= paths gated")

    if not configured:
        step(6, "SKIP — Plex not configured (set URL+token on /admin to enable)")
        step(7, "SKIP — Plex not configured")
        print("Plex: 5/7 passed, 2 skipped (unconfigured) — OK", flush=True)
        return

    # ───────── 6/7  Availability lookups (live Plex) ─────────
    season, year = current_season_year()
    step(6, f"availability: nonsense title → available=false (corpus: {season} {year})")
    r = requests.post(f"{backend}/api/plex/availability", headers=auth,
                      json={"mediaId": 999999901, "titles": ["zzz no such show xyz 42"]},
                      timeout=15)
    body = r.json() if r.status_code == 200 else {}
    if r.status_code != 200 or body.get("available") is not False:
        fail(6, f"expected available=false, got {r.status_code} {r.text[:200]}")
    # A dead Plex answers available=false too — but with unknown=true. Without
    # this the step passes while the integration is entirely broken.
    if body.get("unknown"):
        fail(6, f"Plex reported configured but the lookup failed: {body}")
    # Shape check with real titles from the anime endpoint (result depends on
    # what's in the library, so only the shape is asserted).
    r = requests.get(f"{backend}/api/anime?season={season}&year={year}&format=TV", timeout=120)
    if r.status_code != 200 or not isinstance(r.json(), list) or not r.json():
        fail(6, f"could not load {season} {year} anime to test with: "
                f"{r.status_code} {r.text[:200]}")
    show = r.json()[0]
    titles = [t for t in (show.get("title") or {}).values() if t]
    r = requests.post(f"{backend}/api/plex/availability", headers=auth,
                      json={"mediaId": show["id"], "titles": titles[:10]}, timeout=15)
    if r.status_code != 200:
        fail(6, f"availability with real titles: {r.status_code} {r.text[:200]}")
    body = r.json()
    if not isinstance(body.get("available"), bool):
        fail(6, f"availability shape wrong: {body}")
    if body["available"]:
        for key in ("showRatingKey", "episodeRatingKey", "plexTitle"):
            if not body.get(key):
                fail(6, f"available=true but missing {key}: {body}")
    step(6, "PASS — availability responses well-formed")

    # ───────── 7/7  Stream proxy (no transcode started) ─────────
    step(7, "GET /api/plex/stream/identity — proxy + token injection")
    r = requests.get(f"{backend}/api/plex/stream/identity", headers=auth, timeout=15)
    if r.status_code != 200:
        fail(7, f"expected 200 from proxied /identity, got {r.status_code} {r.text[:200]}")
    if b"machineIdentifier" not in r.content:
        fail(7, f"proxied /identity response missing machineIdentifier: {r.content[:200]!r}")
    step(7, "PASS — proxy reaches Plex with server-side token")

    print("Plex: 7/7 passed — OK", flush=True)


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nPlex: FAIL — backend unreachable: {e}", flush=True)
        sys.exit(1)
