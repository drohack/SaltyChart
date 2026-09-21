"""
`/api/status` - the upstream service status page and its alert settings.

Why it exists: two third-party services changed and broke silently in one week
(YouTube's media requests, skyhook's User-Agent), and in both cases a `catch`
turned the failure into a plausible empty answer that nothing could see. This
route is what makes "could not ask" visible, so the things worth pinning are the
gates and the two states that exist purely to stop a reader being misled.

**The assertion that matters most is the `notConfigured` one.** A service nobody
has set up must NOT read as a failure, and a service nobody has checked must NOT
read as OK. Getting either wrong turns the page into one that is ignored, which
is indistinguishable from not having it.

Needs the dev backend on :3000. Backs up `AppConfig.upstreamHealth` and
`AppConfig.alertSettings` and restores both in a `finally`. Signs up one
throwaway non-admin to prove the 403.
"""

import json
import os
import sqlite3
import subprocess
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
DB = os.path.join(REPO, "backend", "prisma", "prisma", "data.db")
BASE = os.environ.get("SALTY_BACKEND", "http://localhost:3000")
KEYS = ("upstreamHealth", "alertSettings")

fails = 0


def check(name, ok, detail=""):
    global fails
    fails += not ok
    print(f"  {'PASS  ' if ok else 'FAIL: '}{name}{('  - ' + detail) if detail and not ok else ''}", flush=True)


def admin_token() -> str:
    script = ("require('dotenv').config();const jwt=require('jsonwebtoken');"
              "const id=parseInt(process.env.ADMIN_USER_ID||'1',10);"
              "console.log(jwt.sign({id}, process.env.JWT_SECRET||'dev-secret',{expiresIn:'10m'}));")
    r = subprocess.run(["node", "-e", script], cwd=os.path.join(REPO, "backend"),
                       capture_output=True, text=True, timeout=60)
    return r.stdout.strip()


def nonadmin_token() -> str:
    name = f"st_{int(time.time())}"
    r = requests.post(f"{BASE}/api/auth/signup", json={"username": name, "password": "throwaway-pw-1"}, timeout=10)
    return ((r.json() or {}).get("token") or "") if r.ok else ""


def backup():
    c = sqlite3.connect(DB)
    try:
        out = {}
        for k in KEYS:
            row = c.execute("SELECT value FROM AppConfig WHERE key = ?", (k,)).fetchone()
            out[k] = row[0] if row else None
        return out
    finally:
        c.close()


def restore(saved):
    c = sqlite3.connect(DB)
    try:
        for k, v in saved.items():
            if v is None:
                c.execute("DELETE FROM AppConfig WHERE key = ?", (k,))
            else:
                c.execute(
                    "INSERT INTO AppConfig(key, value) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, v))
        c.commit()
    finally:
        c.close()


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(f"Service status route test - backend={BASE}", flush=True)

    try:
        requests.get(f"{BASE}/api/health", timeout=5).raise_for_status()
    except Exception as e:
        print(f"Done: FAIL - backend not reachable at {BASE} ({e})", flush=True)
        return 1

    saved = backup()
    admin = admin_token()
    if not admin:
        print("Done: FAIL - could not mint an admin token", flush=True)
        return 1
    ah = {"Authorization": f"Bearer {admin}"}

    try:
        print("[1/6] every route refuses an unauthenticated caller", flush=True)
        for method, path in (("get", "/api/status/report"),
                             ("put", "/api/status/alerts"),
                             ("post", "/api/status/probe")):
            r = getattr(requests, method)(f"{BASE}{path}", json={}, timeout=15)
            check(f"{method.upper()} {path} is 401 without a token", r.status_code == 401, f"got {r.status_code}")

        print("[2/6] a signed-up non-admin is refused", flush=True)
        na = nonadmin_token()
        if not na:
            check("could sign up a throwaway user", False, "signup failed")
        else:
            nh = {"Authorization": f"Bearer {na}"}
            r = requests.get(f"{BASE}/api/status/report", headers=nh, timeout=15)
            check("GET /report is 403 for a non-admin", r.status_code == 403, f"got {r.status_code}")
            r = requests.put(f"{BASE}/api/status/alerts", headers=nh, json={}, timeout=15)
            check("PUT /alerts is 403 for a non-admin", r.status_code == 403, f"got {r.status_code}")

        print("[3/6] the report names every service and carries a verdict for each", flush=True)
        r = requests.get(f"{BASE}/api/status/report", headers=ah, timeout=30)
        check("GET /report is 200 for an admin", r.status_code == 200, f"got {r.status_code}")
        body = r.json() if r.ok else {}
        services = body.get("services") or []
        check("the report lists services", len(services) >= 8, f"{len(services)} listed")
        ids = {s.get("id") for s in services}
        for expected in ("youtube", "skyhook", "tmdb", "anilist", "jellyfin", "sonarr", "smtp"):
            check(f"{expected} has a row", expected in ids)
        allowed = {"ok", "failing", "down", "unknown", "notConfigured"}
        bad = [s for s in services if s.get("state") not in allowed]
        check("every row carries a known state", not bad, repr([s.get("id") for s in bad]))
        check("every row says what a viewer loses", all((s.get("impact") or "").strip() for s in services))
        check("the report says whether SMTP is configured at all", isinstance(body.get("smtpConfigured"), bool))
        # Where alerts actually land. `owner` is derived (the first admin with a
        # verified address), so this asserts the shape, not a particular
        # address - a hardcoded one would fail on anyone else's machine.
        check("the report names the owner alerts go to, or says there is none",
              "owner" in body and (body["owner"] is None or "@" in str(body["owner"])),
              repr(body.get("owner")))
        check("YouTube is reported as passive-only",
              any(s["id"] == "youtube" and s.get("passiveOnly") for s in services))

        print("[4/6] a service that is not set up is not reported as broken", flush=True)
        # THE load-bearing assertion. An unconfigured Sonarr/Jellyfin/SMTP is a
        # deliberate state; recording it as an outage would put a permanent red
        # row on the page and train the reader to ignore it.
        r = requests.post(f"{BASE}/api/status/probe", headers=ah, json={}, timeout=180)
        check("POST /probe is 200 for an admin", r.status_code == 200, f"got {r.status_code}")
        check("the probe run reports what it did", bool((r.json() or {}).get("summary")) if r.ok else False)
        after = requests.get(f"{BASE}/api/status/report", headers=ah, timeout=30).json()
        unknown_probed = [s["id"] for s in after.get("services") or []
                          if s.get("state") == "unknown" and s.get("probed")]
        check("after a forced probe, no probeable service is still 'unknown'",
              not unknown_probed, repr(unknown_probed))

        # A skip has to be INJECTED rather than waited for. On a fully
        # configured box nothing skips, so an "if it skipped, check it" loop
        # asserts nothing at all - the vacuous-row trap this repo keeps
        # relearning. Writing the record directly makes the rule testable on
        # every machine, configured or not.
        c = sqlite3.connect(DB)
        try:
            c.execute(
                "INSERT INTO AppConfig(key, value) VALUES(?, ?) "
                "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                ("upstreamHealth", json.dumps({"sonarr": {
                    "lastOkAt": None, "lastFailAt": None, "lastFailReason": None,
                    "lastFailStatus": None, "consecutiveFailures": 0, "okCount": 0,
                    "failCount": 0, "lastCheckedAt": "2026-09-20T12:00:00.000Z",
                    "lastSkipped": "no Sonarr server configured"}})))
            c.commit()
        finally:
            c.close()
        injected = requests.get(f"{BASE}/api/status/report", headers=ah, timeout=30).json()
        row = next((s for s in injected.get("services") or [] if s["id"] == "sonarr"), {})
        check("a skipped service reads notConfigured, not down",
              row.get("state") == "notConfigured", f"state={row.get('state')}")
        check("and the page is told why", bool(row.get("lastSkipped")))

        print("[5/6] alert settings round-trip", flush=True)
        r = requests.put(f"{BASE}/api/status/alerts", headers=ah, timeout=15, json={
            "masterEnabled": True,
            "perService": {"skyhook": False},
            "extraRecipients": ["ops@example.com", "not-an-email"],
        })
        check("PUT /alerts is 200", r.status_code == 200, f"got {r.status_code}")
        saved_settings = (r.json() or {}).get("settings") or {}
        check("a silenced service is stored", saved_settings.get("perService", {}).get("skyhook") is False)
        check("a malformed address is dropped rather than stored",
              saved_settings.get("extraRecipients") == ["ops@example.com"],
              repr(saved_settings.get("extraRecipients")))
        back = requests.get(f"{BASE}/api/status/report", headers=ah, timeout=30).json()
        sky = next((s for s in back.get("services") or [] if s["id"] == "skyhook"), {})
        check("the report shows that service's alerts as off", sky.get("alertsEnabled") is False)

        print("[6/6] rubbish input is coerced, never a 500", flush=True)
        for junk in ({"masterEnabled": "yes", "perService": 7, "extraRecipients": "no"}, {}, {"nope": 1}):
            r = requests.put(f"{BASE}/api/status/alerts", headers=ah, json=junk, timeout=15)
            check(f"PUT /alerts survives {json.dumps(junk)[:34]}", r.status_code == 200, f"got {r.status_code}")
    finally:
        restore(saved)
        print("[done] restored the stored health and alert settings", flush=True)

    print(f"Done: {'FAIL' if fails else 'PASS'} - {fails} failing check(s)", flush=True)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
