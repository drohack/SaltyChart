"""
`POST /api/translate/local-run` - the Sunday GPU run's self-report - and its
gates.

Why it exists: the server could not see that job at all. Four Sunday runs with
46 of 49 downloads failing left nothing an admin could see, because the only
signal was uploads and a failed run uploads nothing. The run now posts its
`run_verdict` here at the end; this pins that the route stores it, that
`/report` carries it, and that nobody but an admin can write it - the card on
/admin/subtitles repeats whatever is stored, so an open route would let any
account rewrite what the page says about the job.

Needs the dev backend on :3000. Backs up `AppConfig.subtitleLocalRunStatus` and
restores it in a `finally`. Signs up one throwaway non-admin user (the same
thing test_api_negative does) to prove the 403.
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
KEY = "subtitleLocalRunStatus"

fails = 0


def check(name, ok, detail=""):
    global fails
    fails += not ok
    print(f"  {'PASS  ' if ok else 'FAIL: '}{name}{('  - ' + detail) if detail and not ok else ''}", flush=True)


def admin_token() -> str:
    """Same recipe as tools/sonarr_dryrun.py: sign for ADMIN_USER_ID with the backend's secret."""
    script = ("require('dotenv').config();const jwt=require('jsonwebtoken');"
              "const id=parseInt(process.env.ADMIN_USER_ID||'1',10);"
              "console.log(jwt.sign({id}, process.env.JWT_SECRET||'dev-secret',{expiresIn:'10m'}));")
    r = subprocess.run(["node", "-e", script], cwd=os.path.join(REPO, "backend"), capture_output=True, text=True, timeout=60)
    return r.stdout.strip()


def nonadmin_token() -> str:
    name = f"lr_{int(time.time())}"
    r = requests.post(f"{BASE}/api/auth/signup", json={"username": name, "password": "throwaway-pw-1"}, timeout=10)
    tok = (r.json() or {}).get("token") if r.ok else None
    if not tok:
        r = requests.post(f"{BASE}/api/auth/login", json={"username": name, "password": "throwaway-pw-1"}, timeout=10)
        tok = (r.json() or {}).get("token")
    return tok or ""


print("[1/4] backend reachable?", flush=True)
requests.get(f"{BASE}/api/health", timeout=5).raise_for_status()
adm = admin_token()
check("could mint an admin token", bool(adm))

c = sqlite3.connect(DB)
saved = c.execute("select value from AppConfig where key=?", (KEY,)).fetchone()
saved = saved[0] if saved else None
report = {"exitCode": 2, "line": "Done: FAILED - 46 of 49 downloads failed (44 forbidden, 2 other). HTTP 403 on download is a stale yt-dlp (test)",
          "attempted": 49, "errors": 46, "kinds": {"forbidden": 44, "other": 2}, "aborted": False,
          "startedAt": "2026-09-20T05:00:00-05:00"}
# A non-zero verdict is a state change, so posting one MAILS the admins - and
# since alerts default to the owner, running the deploy gate put a fake "Sunday
# subtitle run failed" in a real inbox. An alert that cries wolf on every gate
# run is exactly what this alerting design exists to prevent, so the switch goes
# off for the few seconds the fake report is in flight and back on in the
# `finally` below, beside the report it already restores.
ALERT_KEY = "alertSettings"
saved_alerts = c.execute("select value from AppConfig where key=?", (ALERT_KEY,)).fetchone()
saved_alerts = saved_alerts[0] if saved_alerts else None
c.execute("insert into AppConfig(key,value) values(?,?) "
          "on conflict(key) do update set value=excluded.value",
          (ALERT_KEY, json.dumps({"masterEnabled": False, "perService": {}, "extraRecipients": []})))
c.commit()

try:
    print("[2/4] gates", flush=True)
    r = requests.post(f"{BASE}/api/translate/local-run", json=report, timeout=10)
    check("local-run rejects unauthenticated", r.status_code == 401, f"got {r.status_code}")
    na = nonadmin_token()
    check("could obtain a non-admin token", bool(na))
    r = requests.post(f"{BASE}/api/translate/local-run", json=report, headers={"Authorization": f"Bearer {na}"}, timeout=10)
    check("local-run rejects a non-admin", r.status_code == 403, f"got {r.status_code} {r.text[:120]}")
    r = requests.post(f"{BASE}/api/translate/local-run", json={"line": "no numbers"}, headers={"Authorization": f"Bearer {adm}"}, timeout=10)
    check("local-run rejects a malformed body with 400", r.status_code == 400 and r.json().get("code") == "BAD_REQUEST", f"got {r.status_code} {r.text[:120]}")

    print("[3/4] a real failed verdict round-trips", flush=True)
    r = requests.post(f"{BASE}/api/translate/local-run", json=report, headers={"Authorization": f"Bearer {adm}"}, timeout=10)
    check("admin can post a verdict", r.status_code == 200 and r.json().get("ok") is True, f"got {r.status_code} {r.text[:120]}")
    rep = requests.get(f"{BASE}/api/translate/report", headers={"Authorization": f"Bearer {adm}"}, timeout=60).json()
    lr = (rep.get("schedule") or {}).get("lastLocalRun") or {}
    check("report carries the run verdict", lr.get("exitCode") == 2 and lr.get("line") == report["line"], f"lastLocalRun={lr!r}")
    check("report carries the counts and breakdown", lr.get("attempted") == 49 and lr.get("errors") == 46 and (lr.get("kinds") or {}).get("forbidden") == 44, f"lastLocalRun={lr!r}")
    check("report stamps when it was reported", bool(lr.get("reportedAt")), f"lastLocalRun={lr!r}")
    print("[4/4] restoring the stored report", flush=True)
finally:
    if saved is None:
        c.execute("delete from AppConfig where key=?", (KEY,))
    else:
        c.execute("insert into AppConfig(key,value) values(?,?) on conflict(key) do update set value=excluded.value", (KEY, saved))
    # Restore the switch whatever happened above: leaving alerts off after a
    # crashed test is the silent half of this bug, and nothing else would say so.
    if saved_alerts is None:
        c.execute("delete from AppConfig where key=?", (ALERT_KEY,))
    else:
        c.execute("insert into AppConfig(key,value) values(?,?) on conflict(key) do update set value=excluded.value", (ALERT_KEY, saved_alerts))
    c.commit()

print(f"Done: {'FAIL' if fails else 'PASS'} - {fails} failing check(s)", flush=True)
sys.exit(1 if fails else 0)
