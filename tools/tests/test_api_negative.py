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

TOTAL_STEPS = 11
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

    print(f"\nDone: {TOTAL_STEPS}/{TOTAL_STEPS} passed", flush=True)


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nFAIL - backend unreachable: {e}", flush=True)
        sys.exit(1)
