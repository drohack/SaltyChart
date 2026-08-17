"""
Pre-deploy test: the account and admin guards, against a THROWAWAY database.

Why its own backend instead of steps in test_api_negative.py: these assertions
attempt destructive admin actions. While the guards hold they are refused and
nothing changes, which is why running them against the dev server looked
harmless. Under `mutation_audit.py` a guard is removed on purpose and the same
calls then SUCCEED against whatever account they picked - which was the real
admin, because it is the only one. One audit run reset the dev admin's password,
cleared its email, and left a fixture promoted; the audit reverts source, never
data, so nothing put it back.

So this boots a second backend in production mode on a spare port with an empty
SQLite file, the same way test_rate_limits.py does. Nothing here can touch the
dev database, the dev admin, or anybody's real credentials - and an empty DB is
the only place the first-run claim flow can be exercised at all.

Usage:
  py -3.13 -u tools/tests/test_account_security.py [--port 3998]
"""
import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import requests

TOTAL = 13
REPO = Path(__file__).resolve().parents[2]
BACKEND = REPO / "backend"


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL} account-sec] {msg}", flush=True)


def fail(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL} account-sec] FAIL - {msg}", flush=True)
    print(f"\nAccount security: FAIL at step {n}", flush=True)
    sys.exit(1)


def skip_all(n: int, why: str) -> None:
    step(n, f"SKIP - {why}")
    print(f"Account security: skipped - {why}", flush=True)
    sys.exit(0)


def port_is_free(port: int) -> bool:
    """Refuse to start on an occupied port.

    Without this the run is silently meaningless: a leftover backend from an
    earlier session answers /api/health, our own child dies on EADDRINUSE, and
    every assertion below grades a process with a different database and a
    different in-memory setup code. That happened - the claim code read from our
    log could never match the server actually answering.
    """
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("127.0.0.1", port)) != 0


def wait_for_health(base: str, proc: subprocess.Popen, timeout: float = 60.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if proc.poll() is not None:
            return False
        try:
            if requests.get(f"{base}/api/health", timeout=2).status_code == 200:
                # Belt and braces: a health check can only be trusted if the
                # process we launched is the one still holding the port.
                return proc.poll() is None
        except requests.RequestException:
            time.sleep(0.5)
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=3998)
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    base = f"http://127.0.0.1:{args.port}"
    print(f"Account security - throwaway backend on :{args.port}", flush=True)

    step(1, "step 1/13: building and starting a backend on an EMPTY database")
    if not port_is_free(args.port):
        skip_all(1, f"port {args.port} is already in use - a leftover backend there would "
                    f"answer every request from a different database, which is how this "
                    f"test once graded a server from an hour earlier")
    entry = BACKEND / "dist" / "index.js"
    # ALWAYS rebuild. Reusing whatever is in dist/ silently grades old code: this
    # test booted a pre-fix build and reported a bug that had already been fixed,
    # because `tsc --noEmit` had been the only compile since. ~10s is cheap next
    # to a false result, and a false PASS in the other direction is worse.
    build = subprocess.run(["npm", "run", "build"], cwd=BACKEND, capture_output=True,
                           text=True, timeout=300, shell=sys.platform == "win32")
    if build.returncode != 0 or not entry.exists():
        # FAIL, never skip. `skip_all` exits 0, and mutation_audit.py reads exit 0
        # as "the test passed" - so a mutation that merely broke the build reported
        # SURVIVED, which claims a working guard is unguarded. A build that does
        # not compile is a real failure of this test, whatever caused it.
        fail(1, "`npm run build` failed, so nothing below was actually exercised: "
                f"{(build.stdout + build.stderr).strip()[-400:]}")

    scratch = Path(tempfile.gettempdir()) / f"saltychart-acctsec-{os.getpid()}.db"
    for leftover in scratch.parent.glob(f"{scratch.name}*"):
        leftover.unlink(missing_ok=True)
    logfile = Path(tempfile.gettempdir()) / f"saltychart-acctsec-{os.getpid()}.log"

    env = {
        **os.environ,
        "NODE_ENV": "production",
        "PORT": str(args.port),
        "DATABASE_URL": f"file:{scratch.as_posix()}",
        "JWT_SECRET": "account-security-test-secret-not-used-elsewhere",
        # Never send real mail from a test. An unset host makes the mailer refuse
        # at the point of use, which is the behaviour we want to assert anyway.
        "SMTP_HOST": "",
        "SMTP_USER": "",
        "SMTP_PASS": "",
    }

    def db(script: str) -> str:
        """Run a snippet against the THROWAWAY database via the app's own client.

        Used only to set `emailVerifiedAt`, which the HTTP API can only do with a
        code from a real email - and this test must never send one.
        """
        body = ("const {PrismaClient}=require('@prisma/client');"
                "const p=new PrismaClient();"
                f"(async()=>{{ {script} await p.$disconnect(); }})()")
        r = subprocess.run(["node", "-e", body], cwd=BACKEND, env=env,
                           capture_output=True, text=True, timeout=90)
        return r.stdout.strip() if r.returncode == 0 else ""

    # Output to a FILE, not an unread PIPE: the setup code has to be read back,
    # and a pipe nobody drains can block the child once it fills.
    with open(logfile, "w", encoding="utf-8") as sink:
        proc = subprocess.Popen(["node", str(entry)], cwd=BACKEND, env=env,
                                stdout=sink, stderr=subprocess.STDOUT, text=True)
    try:
        if not wait_for_health(base, proc):
            tail = logfile.read_text(encoding="utf-8", errors="replace")[-400:]
            skip_all(1, f"the backend did not come up: {tail}")
        step(1, "step 1/13: PASS - backend healthy on an empty database")

        # --------- 2 the first-run setup code ---------
        step(2, "step 2/13: an empty database prints a [SETUP] claim code")
        # Poll: node buffers stdout when it is a file rather than a terminal, so
        # the line can lag the health check that let us get this far.
        m = None
        deadline = time.time() + 20
        while time.time() < deadline:
            log = logfile.read_text(encoding="utf-8", errors="replace")
            m = re.search(r"claim admin:\s*([0-9a-f]{8})", log)
            if m:
                break
            time.sleep(0.5)
        if not m:
            tail = logfile.read_text(encoding="utf-8", errors="replace")[-600:]
            fail(2, "no [SETUP] claim code in the log on an empty database - the first "
                    "admin would fall to whoever signs up first, which on a public "
                    f"domain is a land-grab. Log tail:\n{tail}")
        setup_code = m.group(1)
        step(2, "step 2/13: PASS - a claim code was printed")

        # --------- 3 signing up does not make you admin ---------
        step(3, "step 3/13: the first signup is NOT automatically an admin")
        r = requests.post(f"{base}/api/auth/signup",
                          json={"username": "alice", "password": "alice-pw-1"}, timeout=15)
        if r.status_code != 200:
            fail(3, f"signup failed: {r.status_code} {r.text[:150]}")
        alice = r.json()["token"]
        ah = {"Authorization": f"Bearer {alice}"}
        r = requests.get(f"{base}/api/admin/users", headers=ah, timeout=15)
        if r.status_code != 403:
            fail(3, f"the first signed-up account could read the admin user list "
                    f"({r.status_code}) - signing up must not confer admin")
        acct = requests.get(f"{base}/api/auth/account", headers=ah, timeout=15).json()
        if not acct.get("setupNeeded"):
            fail(3, "setupNeeded was false on a database with no admin, so the claim "
                    "form would never be offered")
        step(3, "step 3/13: PASS - 403, and setupNeeded is true")

        # --------- 4 the claim code is actually required ---------
        step(4, "step 4/13: a wrong setup code is refused")
        r = requests.post(f"{base}/api/auth/claim-admin", headers=ah,
                          json={"code": "deadbeef"}, timeout=15)
        if r.status_code != 403 or r.json().get("code") != "SETUP_CODE_INVALID":
            fail(4, f"a wrong setup code was accepted: {r.status_code} {r.text[:150]} - "
                    f"anyone who can sign up could claim the server")
        step(4, "step 4/13: PASS - 403 SETUP_CODE_INVALID")

        # --------- 5 claiming works, once ---------
        step(5, "step 5/13: the real code claims admin, and only once")
        r = requests.post(f"{base}/api/auth/claim-admin", headers=ah,
                          json={"code": setup_code}, timeout=15)
        if r.status_code != 200:
            fail(5, f"the real setup code did not claim admin: {r.status_code} {r.text[:150]}")
        if requests.get(f"{base}/api/admin/users", headers=ah, timeout=15).status_code != 200:
            fail(5, "claiming reported success but admin routes still refuse")
        r = requests.post(f"{base}/api/auth/claim-admin", headers=ah,
                          json={"code": setup_code}, timeout=15)
        if r.status_code != 409 or r.json().get("code") != "ALREADY_INITIALIZED":
            fail(5, f"a second claim was not refused: {r.status_code} {r.text[:150]} - the "
                    f"code would stay live for anyone who read the log")
        step(5, "step 5/13: PASS - claimed, then 409 ALREADY_INITIALIZED")

        def users():
            return requests.get(f"{base}/api/admin/users", headers=ah, timeout=15).json()["users"]

        def uid(name):
            return next(u["id"] for u in users() if u["username"] == name)

        alice_id = uid("alice")

        # --------- 6 an admin with no email cannot be reset by any route ---------
        step(6, "step 6/13: an admin with no verified email has no reset path")
        r = requests.post(f"{base}/api/auth/reset-password",
                          json={"username": "alice", "newPassword": "taken-over"}, timeout=15)
        if r.status_code != 403 or r.json().get("code") != "ADMIN_RESET_BLOCKED":
            fail(6, f"an anonymous request reset an ADMIN password: {r.status_code} "
                    f"{r.text[:150]} - this is the takeover hole, and it leads to the "
                    f"Jellyfin API key")
        r = requests.post(f"{base}/api/admin/users/{alice_id}/clear-password",
                          headers=ah, timeout=15)
        if r.status_code != 409 or r.json().get("code") != "ADMIN_RESET_BLOCKED":
            fail(6, f"the password of an admin with no verified email was cleared: "
                    f"{r.status_code} {r.text[:150]} - nothing could ever sign in again")
        if requests.post(f"{base}/api/auth/login",
                         json={"username": "alice", "password": "alice-pw-1"},
                         timeout=15).status_code != 200:
            fail(6, "alice's original password stopped working, so something reset it "
                    "despite refusing")
        step(6, "step 6/13: PASS - 403 and 409, password untouched")

        # --------- 7 promotion requires a verified email ---------
        step(7, "step 7/13: promoting an account with no verified email is refused")
        r = requests.post(f"{base}/api/auth/signup",
                          json={"username": "bob", "password": "bob-pw-1"}, timeout=15)
        bob = r.json()["token"]
        bob_id = uid("bob")
        r = requests.patch(f"{base}/api/admin/users/{bob_id}", headers=ah,
                           json={"isAdmin": True}, timeout=15)
        if r.status_code != 409 or r.json().get("code") != "EMAIL_NOT_VERIFIED":
            fail(7, f"an account with no verified email was promoted to admin: "
                    f"{r.status_code} {r.text[:150]} - that admin could not recover "
                    f"their own account by any route")
        step(7, "step 7/13: PASS - 409 EMAIL_NOT_VERIFIED")

        # --------- 8 a verified email switches to the coded path ---------
        step(8, "step 8/13: a verified email closes the open reset")
        db(f"await p.user.update({{where:{{username:'bob'}},"
           f"data:{{email:'bob@example.test',emailVerifiedAt:new Date()}}}});")
        r = requests.post(f"{base}/api/auth/reset-password",
                          json={"username": "bob", "newPassword": "taken-over"}, timeout=15)
        if r.status_code != 409 or r.json().get("code") != "CODE_REQUIRED":
            fail(8, f"a verified email bought no protection - the open reset returned "
                    f"{r.status_code} {r.text[:150]}")
        # And an account with NO email keeps the frictionless reset, which is the
        # whole point of the rule keying on the address rather than on a role.
        r = requests.post(f"{base}/api/auth/signup",
                          json={"username": "carol", "password": "carol-pw-1"}, timeout=15)
        r = requests.post(f"{base}/api/auth/reset-password",
                          json={"username": "carol", "newPassword": "carol-pw-2"}, timeout=15)
        if r.status_code != 200:
            fail(8, f"an ordinary account with no email lost the one-step reset: "
                    f"{r.status_code} {r.text[:150]}")
        if requests.post(f"{base}/api/auth/login",
                         json={"username": "carol", "password": "carol-pw-2"},
                         timeout=15).status_code != 200:
            fail(8, "the open reset reported success but the new password does not work")
        step(8, "step 8/13: PASS - 409 for a verified account, 200 for one with no email")

        # --------- 9 promotion works once verified ---------
        step(9, "step 9/13: promotion succeeds once the email is verified")
        r = requests.patch(f"{base}/api/admin/users/{bob_id}", headers=ah,
                           json={"isAdmin": True}, timeout=15)
        if r.status_code != 200:
            fail(9, f"a verified account could not be promoted: {r.status_code} {r.text[:150]}")
        step(9, "step 9/13: PASS - promoted")

        # --------- 10 an admin's email cannot be cleared ---------
        step(10, "step 10/13: clearing an admin's email is refused")
        r = requests.post(f"{base}/api/admin/users/{bob_id}/clear-email", headers=ah, timeout=15)
        if r.status_code != 409 or r.json().get("code") != "EMAIL_REQUIRED_FOR_ADMIN":
            fail(10, f"an admin's email was cleared: {r.status_code} {r.text[:150]} - that "
                     f"account can no longer reset its password by any route")
        step(10, "step 10/13: PASS - 409 EMAIL_REQUIRED_FOR_ADMIN")

        # --------- 11 the last admin cannot be demoted ---------
        step(11, "step 11/13: the site can never run out of admins")
        # Two admins now, so demoting alice is allowed - and leaves bob as the last.
        r = requests.patch(f"{base}/api/admin/users/{alice_id}", headers=ah,
                           json={"isAdmin": False}, timeout=15)
        if r.status_code != 200:
            fail(11, f"demoting one of two admins was refused: {r.status_code} {r.text[:150]}")
        bh = {"Authorization": f"Bearer {bob}"}
        r = requests.patch(f"{base}/api/admin/users/{bob_id}", headers=bh,
                           json={"isAdmin": False}, timeout=15)
        if r.status_code != 409 or r.json().get("code") != "LAST_ADMIN":
            fail(11, f"the only admin was demoted: {r.status_code} {r.text[:150]} - the site "
                     f"would be left with an admin panel nobody can open")
        r = requests.delete(f"{base}/api/admin/users/{bob_id}", headers=bh, timeout=15)
        if r.status_code == 200:
            fail(11, "the only admin was deleted outright, which is the same lockout by "
                     "another door")
        step(11, "step 11/13: PASS - 409 LAST_ADMIN on both demote and delete")

        # --------- 12 a password change ends other sessions ---------
        step(12, "step 12/13: changing a password invalidates existing tokens")
        r = requests.post(f"{base}/api/auth/change-password", headers=bh,
                          json={"currentPassword": "bob-pw-1", "newPassword": "bob-pw-2"},
                          timeout=15)
        if r.status_code != 200:
            fail(12, f"change-password failed: {r.status_code} {r.text[:150]}")
        r = requests.get(f"{base}/api/options", headers=bh, timeout=15)
        if r.status_code != 401:
            fail(12, f"a token minted before the password change still works ({r.status_code}) - "
                     f"changing a password does not sign other devices out, so a stolen "
                     f"session survives the reset meant to kill it")
        newtok = requests.post(f"{base}/api/auth/login",
                               json={"username": "bob", "password": "bob-pw-2"},
                               timeout=15)
        if newtok.status_code != 200:
            fail(12, "the new password does not work after change-password")
        # Everything after this must use the FRESH token: the change above bumped
        # tokenVersion, which is the whole point of step 12.
        bh = {"Authorization": f"Bearer {newtok.json()['token']}"}
        step(12, "step 12/13: PASS - old token 401, new password works")

        # --------- 13 an abandoned email change keeps the old protection ------
        step(13, "step 13/13: starting an email change does not drop the current one")
        # bob is an admin with a verified address. Ask to change it and never
        # enter the code. Before the address moved onto the code row, this wrote
        # the new value into `email` and nulled `emailVerifiedAt` immediately -
        # leaving an ADMIN with no verified address, and therefore no reset path
        # at all, until they finished typing a code they might never see.
        r = requests.post(f"{base}/api/auth/email", headers=bh,
                          json={"email": "typo@example.test", "currentPassword": "bob-pw-2"},
                          timeout=20)
        if r.status_code not in (200, 502, 503):
            fail(13, f"requesting an email change answered unexpectedly: "
                     f"{r.status_code} {r.text[:150]}")
        acct = requests.get(f"{base}/api/auth/account", headers=bh, timeout=15).json()
        # The new address must be recorded against the CODE, or the code proves
        # nothing about which address it was sent to - and the "enter your code"
        # state would vanish the moment the modal closed.
        if not acct.get("pendingEmail"):
            fail(13, f"no pending address reported after requesting a change: {acct} - the "
                     f"code is not bound to an address, so verification could stamp "
                     f"emailVerifiedAt on an inbox nobody can read")
        if acct.get("email") != "bob@example.test" or not acct.get("emailVerified"):
            fail(13, f"an abandoned email change dropped the confirmed address: {acct} - "
                     f"an admin is left with no reset path at all until a code that may "
                     f"never arrive is entered")
        r = requests.post(f"{base}/api/auth/reset-password",
                          json={"username": "bob", "newPassword": "taken-over"}, timeout=15)
        if r.status_code != 409 or r.json().get("code") != "CODE_REQUIRED":
            fail(13, f"protection lapsed during an unfinished email change: "
                     f"{r.status_code} {r.text[:150]}")
        step(13, "step 13/13: PASS - confirmed address and protection both intact")

        print(f"\nAccount security: {TOTAL}/{TOTAL} passed", flush=True)
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=15)
        except subprocess.TimeoutExpired:
            proc.kill()
        for leftover in scratch.parent.glob(f"{scratch.name}*"):
            leftover.unlink(missing_ok=True)
        logfile.unlink(missing_ok=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except requests.RequestException as e:
        print(f"\nAccount security: FAIL - backend unreachable: {e}", flush=True)
        sys.exit(1)
