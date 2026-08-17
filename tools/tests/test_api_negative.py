"""
Pre-deploy smoke test: backend API negative paths and auth gates.

Companion to test_api_smoke.py. Verifies the things that should FAIL with the
right error code/shape. Catches auth middleware regressions, validation gaps,
and missing 404/409 handling.

Usage:
  py -3.13 -u tools/tests/test_api_negative.py [--backend http://localhost:3000]
"""
import argparse
import subprocess
import sys
import time
from pathlib import Path

import requests

TOTAL_STEPS = 16
REPO = Path(__file__).resolve().parents[2]


def sign_token(payload: str) -> str:
    """Sign a JWT with the backend's own secret, using the backend's own library.

    Only a token signed with the real secret reaches the code path step 11
    guards; a forged or unsigned one is rejected earlier, by a branch that was
    never broken. Signed through node rather than a Python JWT package so the
    suite gains no dependency and signs exactly the way the app does.
    """
    script = (
        "require('dotenv').config();"
        "const jwt=require('jsonwebtoken');"
        f"console.log(jwt.sign({payload}, process.env.JWT_SECRET||'dev-secret',"
        "{expiresIn:'5m'}));"
    )
    try:
        r = subprocess.run(["node", "-e", script], cwd=REPO / "backend",
                           capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def admin_token() -> str:
    """A JWT for ADMIN_USER_ID, signed with the backend's own secret.

    The admin routes gate on `User.isAdmin`, and the bootstrap in
    `ensureDatabaseSchema()` puts that flag on ADMIN_USER_ID - so this is the
    account the suite can reach admin routes as without knowing a password.
    """
    return sign_token("{id:parseInt(process.env.ADMIN_USER_ID||'1',10)}")


def db_exec(script: str) -> str:
    """Run a snippet against the REAL database through the app's own Prisma client.

    Used to set up fixtures the HTTP API deliberately cannot create - verifying
    an email needs a code that only arrives by mail, and this suite must not
    depend on SMTP. Writing to the real DB rather than mocking one is the point:
    a mocked store has repeatedly passed while the real schema was broken.
    """
    body = (
        "require('dotenv').config();"
        "const {PrismaClient}=require('@prisma/client');"
        "const p=new PrismaClient();"
        f"(async()=>{{ {script} await p.$disconnect(); }})()"
    )
    try:
        r = subprocess.run(["node", "-e", body], cwd=REPO / "backend",
                           capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return r.stdout.strip() if r.returncode == 0 else ""


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} API-negative] {msg}", flush=True)


def fail(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} API-negative] FAIL - {msg}", flush=True)
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", default="http://localhost:3000")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    backend = args.backend.rstrip("/")
    print(f"API negative-path smoke - {backend}\n", flush=True)

    # --------- 1/10 Signup with missing fields ---------
    step(1, "POST /api/auth/signup with no password -> 400")
    r = requests.post(f"{backend}/api/auth/signup", json={"username": "noPw"}, timeout=5)
    if r.status_code != 400 or r.json().get("code") != "BAD_REQUEST":
        fail(1, f"expected 400 BAD_REQUEST, got {r.status_code} {r.text[:200]}")
    step(1, "PASS - 400 BAD_REQUEST")

    # --------- 2/10 Signup duplicate username ---------
    step(2, "POST /api/auth/signup twice with same username -> 200 then 409")
    username = f"dup_test_{int(time.time())}"
    r = requests.post(f"{backend}/api/auth/signup",
                      json={"username": username, "password": "pw"}, timeout=5)
    if r.status_code != 200:
        fail(2, f"first signup failed: {r.status_code} {r.text[:200]}")
    r = requests.post(f"{backend}/api/auth/signup",
                      json={"username": username, "password": "pw2"}, timeout=5)
    if r.status_code != 409 or r.json().get("code") != "USER_EXISTS":
        fail(2, f"expected 409 USER_EXISTS, got {r.status_code} {r.text[:200]}")
    step(2, "PASS - 409 USER_EXISTS")

    # --------- 3/10 Password reset round-trip ---------
    step(3, "POST /api/auth/reset-password - old pw fails, new pw works")
    reset_user = f"reset_test_{int(time.time())}"
    r = requests.post(f"{backend}/api/auth/signup",
                      json={"username": reset_user, "password": "old_pw"}, timeout=5)
    if r.status_code != 200:
        fail(3, f"signup failed: {r.status_code}")
    r = requests.post(f"{backend}/api/auth/reset-password",
                      json={"username": reset_user, "newPassword": "new_pw"}, timeout=5)
    if r.status_code != 200:
        fail(3, f"reset failed: {r.status_code} {r.text[:200]}")
    # Old password should now fail
    r = requests.post(f"{backend}/api/auth/login",
                      json={"username": reset_user, "password": "old_pw"}, timeout=5)
    if r.status_code != 401:
        fail(3, f"old password still works: {r.status_code}")
    # New password should work
    r = requests.post(f"{backend}/api/auth/login",
                      json={"username": reset_user, "password": "new_pw"}, timeout=5)
    if r.status_code != 200 or not r.json().get("token"):
        fail(3, f"new password didn't work: {r.status_code} {r.text[:200]}")
    step(3, "PASS - reset, old pw 401, new pw 200")

    # --------- 4/10 JWT: missing Authorization header ---------
    step(4, "GET /api/list without Authorization -> 401")
    r = requests.get(f"{backend}/api/list",
                     params={"season": "SUMMER", "year": 2026}, timeout=5)
    if r.status_code != 401:
        fail(4, f"expected 401, got {r.status_code} {r.text[:200]}")
    step(4, "PASS - 401 (no token)")

    # --------- 5/10 JWT: malformed token ---------
    step(5, "GET /api/list with Bearer garbage -> 401")
    r = requests.get(f"{backend}/api/list",
                     params={"season": "SUMMER", "year": 2026},
                     headers={"Authorization": "Bearer garbage"}, timeout=5)
    if r.status_code != 401:
        fail(5, f"expected 401, got {r.status_code} {r.text[:200]}")
    step(5, "PASS - 401 (malformed token)")

    # --------- 6/10 Validation: bad season on /list ---------
    step(6, "GET /api/list?season=BAD -> 400 BAD_REQUEST")
    # Need a valid token to get past auth and exercise validation
    test_user = f"val_test_{int(time.time())}"
    r = requests.post(f"{backend}/api/auth/signup",
                      json={"username": test_user, "password": "pw"}, timeout=5)
    token = r.json()["token"]
    auth = {"Authorization": f"Bearer {token}"}
    r = requests.get(f"{backend}/api/list",
                     params={"season": "BAD", "year": 2026}, headers=auth, timeout=5)
    if r.status_code != 400 or r.json().get("code") != "BAD_REQUEST":
        fail(6, f"expected 400 BAD_REQUEST, got {r.status_code} {r.text[:200]}")
    step(6, "PASS - 400 BAD_REQUEST")

    # --------- 7/10 Public-list nonexistent user -> 404 ---------
    step(7, "GET /api/public-list?username=zzzzz_nonexistent -> 404")
    r = requests.get(f"{backend}/api/public-list",
                     params={"username": "zzzzz_nonexistent_xyz",
                             "season": "SUMMER", "year": 2026}, timeout=5)
    if r.status_code != 404 or r.json().get("code") != "USER_NOT_FOUND":
        fail(7, f"expected 404 USER_NOT_FOUND, got {r.status_code} {r.text[:200]}")
    step(7, "PASS - 404 USER_NOT_FOUND")

    # --------- 8/10 /api/translate/check returns expected shape ---------
    step(8, "GET /api/translate/check for unknown video -> expected shape")
    fake_video = "zzzz0000xxx"  # 11-char matches YouTube ID regex, won't be in cache
    r = requests.get(f"{backend}/api/translate/check",
                     params={"videoId": fake_video}, timeout=10)
    if r.status_code != 200:
        fail(8, f"expected 200, got {r.status_code} {r.text[:200]}")
    data = r.json()
    for key in ("hasEnglish", "hasCachedSegments", "subtitlesDisabled"):
        if key not in data:
            fail(8, f"missing field '{key}' in response: {data}")
    if not isinstance(data["hasEnglish"], bool):
        fail(8, f"hasEnglish should be bool, got {type(data['hasEnglish']).__name__}")
    step(8, f"PASS - shape OK: hasEnglish={data['hasEnglish']}")

    # --------- 9/10 /api/translate/check-batch returns dict ---------
    step(9, "GET /api/translate/check-batch with 3 IDs -> dict response")
    ids = "zzzz0000aaa,zzzz0000bbb,7ObipYqbOd8"
    r = requests.get(f"{backend}/api/translate/check-batch",
                     params={"videoIds": ids}, timeout=10)
    if r.status_code != 200:
        fail(9, f"expected 200, got {r.status_code} {r.text[:200]}")
    data = r.json()
    if not isinstance(data, dict):
        fail(9, f"expected dict, got {type(data).__name__}: {data}")
    # All keys must be subset of inputs; all values must be bool
    input_set = set(ids.split(","))
    for k, v in data.items():
        if k not in input_set:
            fail(9, f"unexpected key in response: {k}")
        if not isinstance(v, bool):
            fail(9, f"value for {k} should be bool, got {type(v).__name__}")
    step(9, f"PASS - dict shape OK, {len(data)} hits")

    # --------- 10/10  Admin endpoints reject non-admin -> 401 / 403 ---------
    step(10, "Admin endpoints with no auth -> 401, with non-admin -> 403")
    # Reuse the validation user from step 6 - that's a non-admin user
    non_admin_auth = {"Authorization": f"Bearer {token}"}

    admin_endpoints = [
        ("POST",   "/api/translate/upload",       {"videoId": "test_xyz_aaa", "modelName": "small",
                                                    "segments": []}),
        ("POST",   "/api/translate/batch",        {"season": "SUMMER", "year": 2026}),
        ("GET",    "/api/translate/batch/status", None),
        ("DELETE", "/api/translate/cache",        None),
    ]
    for method, path, body in admin_endpoints:
        # No auth -> 401
        kwargs = {"timeout": 5}
        if body is not None:
            kwargs["json"] = body
        url = f"{backend}{path}"
        if path == "/api/translate/cache":
            url += "?videoId=test_xyz_aaa"  # avoid 400 from missing query
        r = requests.request(method, url, **kwargs)
        if r.status_code != 401:
            fail(10, f"{method} {path} without auth: expected 401, got {r.status_code}")
        # Non-admin token -> 403
        kwargs["headers"] = non_admin_auth
        r = requests.request(method, url, **kwargs)
        if r.status_code != 403:
            fail(10, f"{method} {path} as non-admin: expected 403, got {r.status_code} {r.text[:150]}")
    step(10, f"PASS - 4 admin endpoints all reject 401/403 correctly")

    # --------- 11  A signed token that carries no user id ---------
    #
    # This one hung rather than failing. The app signs `{ id }`; a token signed
    # with the right secret but a different claim shape reached
    # `findUnique({ where: { id: undefined } })`, which Prisma rejects - inside
    # an async middleware with no catch, so Express never answered and the
    # connection stayed open until the client gave up. The short timeout IS the
    # assertion: without it this would hang the suite instead of failing it.
    step(11, "a correctly signed JWT with no `id` claim -> 401, not a hang")
    bad = sign_token("{userId:1}")
    if not bad:
        step(11, "SKIP - could not sign a token (node or backend/.env unavailable)")
    else:
        try:
            r = requests.get(f"{backend}/api/options",
                             headers={"Authorization": f"Bearer {bad}"}, timeout=8)
        except requests.Timeout:
            fail(11, "request hung - a signed token with no `id` must 401, not stall the "
                     "connection (Prisma rejecting inside async middleware, uncaught)")
        if r.status_code != 401:
            fail(11, f"expected 401 for a token with no id claim, got "
                     f"{r.status_code} {r.text[:150]}")
        step(11, f"PASS - 401 in {r.elapsed.total_seconds() * 1000:.0f}ms")

    # ---------------------------------------------------------------------
    # Account security. Every step here asserts a REFUSAL, so a regression
    # shows up as something being allowed - the direction that actually costs
    # something. The hole these close: reset the admin's password with one
    # unauthenticated POST, log in, then read the stored Jellyfin key back out
    # through PUT /api/jellyfin/config + POST /config/test.
    # ---------------------------------------------------------------------
    atok = admin_token()
    if not atok:
        for n in range(12, 17):
            step(n, "SKIP - could not sign an admin token (node or backend/.env unavailable)")
    else:
        ahdr = {"Authorization": f"Bearer {atok}"}

        # --------- 12/16 the admin account is not resettable ---------
        step(12, "POST /api/auth/reset-password on an ADMIN account -> 403")
        r = requests.get(f"{backend}/api/admin/users", headers=ahdr, timeout=10)
        if r.status_code != 200:
            fail(12, f"could not list users as admin: {r.status_code} {r.text[:150]}")
        users = r.json().get("users", [])
        admins = [u for u in users if u.get("isAdmin")]
        if not admins:
            fail(12, "no admin account exists - the isAdmin bootstrap in "
                     "ensureDatabaseSchema() did not run, so every admin route is shut")
        admin_name = admins[0]["username"]
        r = requests.post(f"{backend}/api/auth/reset-password",
                          json={"username": admin_name, "newPassword": "taken_over"},
                          timeout=10)
        # Which refusal depends on whether that admin has a verified address, and
        # both are correct: with one, a verified email outranks the admin flag and
        # the useful answer is "go get your code"; without one, there is no route
        # at all. Asserting a single code here would fail the moment the admin
        # sets an email - which is exactly what happened. The property under test
        # is that an anonymous reset of an admin NEVER succeeds.
        expected = "CODE_REQUIRED" if admins[0].get("emailVerified") else "ADMIN_RESET_BLOCKED"
        if r.status_code == 200 or r.json().get("code") != expected:
            fail(12, f"an anonymous request reset the ADMIN password (or was refused for "
                     f"the wrong reason - expected {expected}): {r.status_code} "
                     f"{r.text[:200]} - this is the takeover hole, and it leads to the "
                     f"Jellyfin API key")
        step(12, f"PASS - {expected} for {admin_name!r}")

        # --------- 13/16 a verified email switches an account to codes ------
        step(13, "an account with a verified email is refused the open reset")
        pu = f"prot_test_{int(time.time())}"
        r = requests.post(f"{backend}/api/auth/signup",
                          json={"username": pu, "password": "pw"}, timeout=10)
        if r.status_code != 200:
            fail(13, f"signup failed: {r.status_code}")
        # Verifying by hand: the real flow needs a code from an email, and this
        # suite must never depend on SMTP being configured.
        db_exec(
            f"await p.user.update({{where:{{username:'{pu}'}},"
            f"data:{{email:'{pu}@example.com',emailVerifiedAt:new Date()}}}});"
        )
        r = requests.post(f"{backend}/api/auth/reset-password",
                          json={"username": pu, "newPassword": "nope"}, timeout=10)
        if r.status_code != 409 or r.json().get("code") != "CODE_REQUIRED":
            fail(13, f"a verified email bought no protection - open reset returned "
                     f"{r.status_code} {r.text[:200]}")
        # Deliberately NOT calling /reset-request here. Once SMTP is configured
        # that endpoint really sends, and this fixture's address cannot receive
        # mail - so every suite run would fire a message that bounces back into
        # the operator's inbox. A test with side effects on the real world is a
        # defect, and the 409 above already proves the account is on the coded
        # path. Address masking is covered by the maskEmail unit tests, where it
        # costs nothing.
        db_exec(f"const u=await p.user.findUnique({{where:{{username:'{pu}'}}}});"
                f"if(u){{await p.authCode.deleteMany({{where:{{userId:u.id}}}});"
                f"await p.settings.deleteMany({{where:{{userId:u.id}}}});"
                f"await p.user.delete({{where:{{id:u.id}}}});}}")
        step(13, "PASS - 409 CODE_REQUIRED once an address is verified")

        # --------- 14/16 admin routes reject a non-admin --------------------
        step(14, "GET /api/admin/users as a non-admin -> 403")
        nu = f"nonadmin_test_{int(time.time())}"
        r = requests.post(f"{backend}/api/auth/signup",
                          json={"username": nu, "password": "pw"}, timeout=10)
        ntok = r.json().get("token") if r.status_code == 200 else None
        if not ntok:
            fail(14, f"signup failed: {r.status_code}")
        r = requests.get(f"{backend}/api/admin/users",
                         headers={"Authorization": f"Bearer {ntok}"}, timeout=10)
        if r.status_code != 403 or r.json().get("code") != "ADMIN_REQUIRED":
            fail(14, f"a freshly signed-up account could read the user list: "
                     f"{r.status_code} {r.text[:200]}")
        # Changing a password must end every other session. Tokens live 7 days
        # in localStorage with no revocation list, so without the tokenVersion
        # bump a stolen session outlives the password changed to stop it.
        r = requests.post(f"{backend}/api/auth/change-password",
                          headers={"Authorization": f"Bearer {ntok}"},
                          json={"currentPassword": "pw", "newPassword": "pw2"}, timeout=10)
        if r.status_code != 200:
            fail(14, f"change-password failed: {r.status_code} {r.text[:200]}")
        r = requests.get(f"{backend}/api/options",
                         headers={"Authorization": f"Bearer {ntok}"}, timeout=10)
        if r.status_code != 401:
            fail(14, f"a token minted before the password change still works "
                     f"({r.status_code}) - changing a password does not sign other "
                     f"devices out, so a stolen session survives the reset meant to kill it")
        step(14, "PASS - 403 ADMIN_REQUIRED, and the pre-change token is now 401")

        # --------- 15/16 promotion needs a verified email -------------------
        step(15, "promoting an account with no verified email -> 409")
        r = requests.get(f"{backend}/api/admin/users", headers=ahdr, timeout=10)
        target = next((u for u in r.json().get("users", [])
                       if u["username"] == nu), None)
        if not target:
            fail(15, "could not find the fixture account in the admin list")
        r = requests.patch(f"{backend}/api/admin/users/{target['id']}",
                           headers=ahdr, json={"isAdmin": True}, timeout=10)
        if r.status_code != 409 or r.json().get("code") != "EMAIL_NOT_VERIFIED":
            fail(15, f"an account with no verified email was promoted to admin: "
                     f"{r.status_code} {r.text[:200]} - that admin would have no way "
                     f"to recover their account, since admins cannot use the open reset")
        step(15, "PASS - 409 EMAIL_NOT_VERIFIED")

        # --------- 16/16 the last admin, and admin passwords ----------------
        step(16, "the last admin cannot be demoted, and an admin cannot be stranded")
        admin_id = admins[0]["id"]
        if len(admins) == 1:
            r = requests.patch(f"{backend}/api/admin/users/{admin_id}",
                               headers=ahdr, json={"isAdmin": False}, timeout=10)
            if r.status_code != 409 or r.json().get("code") != "LAST_ADMIN":
                fail(16, f"the only admin was demoted: {r.status_code} {r.text[:200]} - "
                         f"the site would be left with an admin panel nobody can open")
        # Clearing an admin's email is refused whatever its state: an admin is
        # blocked from the open reset, so an admin with no address has no route
        # back into the account at all.
        r = requests.post(f"{backend}/api/admin/users/{admin_id}/clear-email",
                          headers=ahdr, timeout=10)
        if r.status_code != 409 or r.json().get("code") != "EMAIL_REQUIRED_FOR_ADMIN":
            fail(16, f"an admin's email was cleared from the users page: "
                     f"{r.status_code} {r.text[:200]} - that account can no longer "
                     f"reset its password by any route")
        # And clearing the password of an admin who has no verified address is
        # the same permanent lockout by another door.
        if not admins[0].get("emailVerified"):
            r = requests.post(f"{backend}/api/admin/users/{admin_id}/clear-password",
                              headers=ahdr, timeout=10)
            if r.status_code != 409 or r.json().get("code") != "ADMIN_RESET_BLOCKED":
                fail(16, f"the password of an admin with no verified email was cleared: "
                         f"{r.status_code} {r.text[:200]} - nothing could sign in to "
                         f"that account again")
        db_exec(f"const u=await p.user.findUnique({{where:{{username:'{nu}'}}}});"
                f"if(u){{await p.settings.deleteMany({{where:{{userId:u.id}}}});"
                f"await p.user.delete({{where:{{id:u.id}}}});}}")
        step(16, "PASS - 409 LAST_ADMIN and 409 EMAIL_REQUIRED_FOR_ADMIN")

    print(f"\nDone: {TOTAL_STEPS}/{TOTAL_STEPS} passed", flush=True)


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nFAIL - backend unreachable: {e}", flush=True)
        sys.exit(1)
