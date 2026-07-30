"""
Pre-deploy smoke test: backend API integration.

Runs against http://localhost:3000 with a unique-per-run signup and exercises
every critical endpoint, verifying expected response shapes. Catches regressions
that would brick a core feature in prod.

Usage:
  pip install requests
  py -3.13 -u tools/tests/test_api_smoke.py [--backend http://localhost:3000]

Exits 0 if all steps pass, 1 on any failure. Each progress line is
self-contained per the global CLAUDE.md convention:
  [k/10 API-smoke] step name — detail
"""
import argparse
import sys
import time

import requests

# Real shows that exist (used for list/nicknames assertions). Eren the Southpaw
# is a known cached anime in the dev DB; if it isn't present, AniList will
# still return data because the /anime endpoint queries upstream.
TEST_MEDIA_ID = 158036   # Eren the Southpaw (any valid AniList ID works)
TEST_SEASON   = "SUMMER"
TEST_YEAR     = 2026

TOTAL_STEPS = 13


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} API-smoke] {msg}", flush=True)


def fail(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} API-smoke] FAIL — {msg}", flush=True)
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", default="http://localhost:3000")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    backend = args.backend.rstrip("/")
    username = f"smoke_test_{int(time.time())}"
    password = "smoke_pw_123"

    print(f"API smoke test — backend={backend}", flush=True)
    print(f"  test user: {username}\n", flush=True)

    # ───────── 1/10  Health check ─────────
    step(1, "GET /api/health")
    r = requests.get(f"{backend}/api/health", timeout=5)
    if r.status_code != 200 or r.json().get("status") != "ok":
        fail(1, f"unexpected health response: {r.status_code} {r.text[:200]}")
    step(1, "PASS — status=ok")

    # ───────── 2/10  Signup ─────────
    step(2, f"POST /api/auth/signup as {username}")
    r = requests.post(f"{backend}/api/auth/signup",
                      json={"username": username, "password": password}, timeout=5)
    if r.status_code != 200:
        fail(2, f"expected 200, got {r.status_code} {r.text[:200]}")
    data = r.json()
    if not data.get("token") or data.get("username") != username:
        fail(2, f"missing token or username: {data}")
    token = data["token"]
    auth_headers = {"Authorization": f"Bearer {token}"}
    step(2, "PASS — got JWT token")

    # ───────── 3/10  Login with bad password ─────────
    step(3, "POST /api/auth/login with bad password — expect 401")
    r = requests.post(f"{backend}/api/auth/login",
                      json={"username": username, "password": "wrong"}, timeout=5)
    if r.status_code != 401:
        fail(3, f"expected 401, got {r.status_code}")
    if r.json().get("code") != "INVALID_CREDENTIALS":
        fail(3, f"expected code=INVALID_CREDENTIALS, got {r.json()}")
    step(3, "PASS — 401 INVALID_CREDENTIALS")

    # ───────── 4/10  Login with correct password ─────────
    step(4, "POST /api/auth/login with correct password")
    r = requests.post(f"{backend}/api/auth/login",
                      json={"username": username, "password": password}, timeout=5)
    if r.status_code != 200 or not r.json().get("token"):
        fail(4, f"login failed: {r.status_code} {r.text[:200]}")
    step(4, "PASS — got JWT token")

    # ───────── 5/10  List: PUT then GET ─────────
    step(5, f"PUT /api/list with 3 items, then GET")
    items = [
        {"mediaId": TEST_MEDIA_ID,     "customName": "Eren the Lefty"},
        {"mediaId": TEST_MEDIA_ID + 1, "customName": None},
        {"mediaId": TEST_MEDIA_ID + 2, "customName": "Another show"},
    ]
    r = requests.put(f"{backend}/api/list",
                     json={"season": TEST_SEASON, "year": TEST_YEAR, "items": items},
                     headers=auth_headers, timeout=10)
    if r.status_code != 200 or not r.json().get("ok"):
        fail(5, f"PUT failed: {r.status_code} {r.text[:200]}")
    r = requests.get(f"{backend}/api/list",
                     params={"season": TEST_SEASON, "year": TEST_YEAR},
                     headers=auth_headers, timeout=5)
    if r.status_code != 200:
        fail(5, f"GET failed: {r.status_code} {r.text[:200]}")
    got = r.json()
    if len(got) != 3:
        fail(5, f"expected 3 items, got {len(got)}")
    if got[0]["mediaId"] != TEST_MEDIA_ID or got[0]["customName"] != "Eren the Lefty":
        fail(5, f"order or customName wrong: {got[0]}")
    step(5, f"PASS — list has 3 items, ordered, customName preserved")

    # ───────── 6/10  Mark watched + verify rank ─────────
    step(6, f"PATCH /api/list/watched mediaId={TEST_MEDIA_ID} → watched=true")
    r = requests.patch(f"{backend}/api/list/watched",
                       json={"season": TEST_SEASON, "year": TEST_YEAR,
                             "mediaId": TEST_MEDIA_ID, "watched": True},
                       headers=auth_headers, timeout=5)
    if r.status_code != 200:
        fail(6, f"PATCH failed: {r.status_code} {r.text[:200]}")
    r = requests.get(f"{backend}/api/list",
                     params={"season": TEST_SEASON, "year": TEST_YEAR},
                     headers=auth_headers, timeout=5)
    row = next((x for x in r.json() if x["mediaId"] == TEST_MEDIA_ID), None)
    if not row or row["watched"] is not True:
        fail(6, f"watched flag not set: {row}")
    if row.get("watchedRank") != 0:
        fail(6, f"expected watchedRank=0 (first watched), got {row.get('watchedRank')}")
    step(6, f"PASS — watched=true, watchedRank=0")

    # ───────── 7/10  Toggle hidden flag ─────────
    step(7, f"PATCH /api/list/hidden mediaId={TEST_MEDIA_ID + 1} → hidden=true")
    r = requests.patch(f"{backend}/api/list/hidden",
                       json={"season": TEST_SEASON, "year": TEST_YEAR,
                             "mediaId": TEST_MEDIA_ID + 1, "hidden": True},
                       headers=auth_headers, timeout=5)
    if r.status_code != 200:
        fail(7, f"PATCH failed: {r.status_code} {r.text[:200]}")
    r = requests.get(f"{backend}/api/list",
                     params={"season": TEST_SEASON, "year": TEST_YEAR},
                     headers=auth_headers, timeout=5)
    row = next((x for x in r.json() if x["mediaId"] == TEST_MEDIA_ID + 1), None)
    if not row or row.get("hidden") is not True:
        fail(7, f"hidden flag not set: {row}")
    step(7, "PASS — hidden=true")

    # ───────── 8/10  AniList anime endpoint ─────────
    step(8, f"GET /api/anime?season={TEST_SEASON}&year={TEST_YEAR}&format=TV")
    r = requests.get(f"{backend}/api/anime",
                     params={"season": TEST_SEASON, "year": TEST_YEAR, "format": "TV"},
                     timeout=30)
    if r.status_code != 200:
        fail(8, f"expected 200, got {r.status_code} {r.text[:200]}")
    anime = r.json()
    if not isinstance(anime, list) or len(anime) == 0:
        fail(8, f"expected non-empty array, got {type(anime).__name__} len={len(anime) if isinstance(anime, list) else 'n/a'}")
    first = anime[0]
    if "title" not in first or not isinstance(first["title"], dict):
        fail(8, f"missing title object: {first}")
    if not first["title"].get("romaji"):
        fail(8, f"missing title.romaji: {first['title']}")
    step(8, f"PASS — {len(anime)} anime returned, shape OK")

    # ───────── 9/10  Public-list endpoints ─────────
    step(9, "Public-list endpoints (5 sub-requests)")
    # 9a: users-with-ratings
    r = requests.get(f"{backend}/api/list/users-with-ratings",
                     params={"season": TEST_SEASON, "year": TEST_YEAR}, timeout=5)
    if r.status_code != 200 or username not in r.json():
        fail(9, f"users-with-ratings missing test user: {r.text[:200]}")
    # 9b: user-ratings
    r = requests.get(f"{backend}/api/list/user-ratings",
                     params={"username": username, "season": TEST_SEASON, "year": TEST_YEAR},
                     timeout=5)
    if r.status_code != 200 or TEST_MEDIA_ID not in r.json():
        fail(9, f"user-ratings missing mediaId: {r.text[:200]}")
    # 9c: nicknames for our test mediaId
    r = requests.get(f"{backend}/api/list/nicknames",
                     params={"mediaId": TEST_MEDIA_ID}, timeout=5)
    if r.status_code != 200:
        fail(9, f"nicknames bad status: {r.status_code}")
    nicks = r.json()
    found = next((n for n in nicks if n["userName"] == username), None)
    if not found or found["nickname"] != "Eren the Lefty":
        fail(9, f"our nickname missing from /nicknames: {nicks}")
    # 9d: public-list pre-watch
    r = requests.get(f"{backend}/api/public-list",
                     params={"username": username, "season": TEST_SEASON,
                             "year": TEST_YEAR, "type": "pre"}, timeout=5)
    if r.status_code != 200 or len(r.json()) != 3:
        fail(9, f"public-list pre-watch: status={r.status_code} len={len(r.json()) if r.ok else 'n/a'}")
    # 9e: public-list post-watch (should only include watched item)
    r = requests.get(f"{backend}/api/public-list",
                     params={"username": username, "season": TEST_SEASON,
                             "year": TEST_YEAR, "type": "post"}, timeout=5)
    if r.status_code != 200:
        fail(9, f"public-list post status: {r.status_code}")
    post = r.json()
    if len(post) != 1 or post[0]["mediaId"] != TEST_MEDIA_ID:
        fail(9, f"public-list post should have 1 watched item: {post}")
    step(9, "PASS — all 5 public endpoints return expected shapes")

    # ───────── 10/10  Options round-trip ─────────
    step(10, "GET /api/options then PUT with theme change")
    r = requests.get(f"{backend}/api/options", headers=auth_headers, timeout=5)
    if r.status_code != 200:
        fail(10, f"GET options failed: {r.status_code} {r.text[:200]}")
    opts = r.json()
    # New signup creates default Settings, so theme should be 'SYSTEM'
    if opts.get("theme") != "SYSTEM":
        fail(10, f"expected default theme=SYSTEM, got {opts.get('theme')}")
    # Round-trip a change
    payload = {
        "theme": "NIGHT",
        "titleLanguage": "ROMAJI",
        "videoAutoplay": False,
        "hideFromCompare": True,
        "nicknameUserSel": [],
        "addWatchedTo": "TOP",
    }
    r = requests.put(f"{backend}/api/options", json=payload,
                     headers=auth_headers, timeout=5)
    if r.status_code != 200 or r.json().get("theme") != "NIGHT":
        fail(10, f"PUT options failed: {r.status_code} {r.text[:200]}")
    # Verify GET reflects the change
    r = requests.get(f"{backend}/api/options", headers=auth_headers, timeout=5)
    if r.json().get("theme") != "NIGHT" or r.json().get("hideFromCompare") is not True:
        fail(10, f"options change not persisted: {r.json()}")
    step(10, "PASS — options round-trip works")

    # ───────── 11/12  PATCH /api/list/rank — reorder watched items ─────────
    step(11, "PATCH /api/list/rank — mark 2nd item watched, then swap ranks")
    # Mark mediaId+2 as watched (rank=1, second after first watched)
    r = requests.patch(f"{backend}/api/list/watched",
                       json={"season": TEST_SEASON, "year": TEST_YEAR,
                             "mediaId": TEST_MEDIA_ID + 2, "watched": True},
                       headers=auth_headers, timeout=5)
    if r.status_code != 200:
        fail(11, f"prep PATCH watched failed: {r.status_code} {r.text[:200]}")
    # Now swap their watchedRanks via /rank — body is {season, year, ids: [mediaId, ...]}
    # where ids[0] gets rank 0, ids[1] gets rank 1, etc.
    r = requests.patch(f"{backend}/api/list/rank",
                       json={"season": TEST_SEASON, "year": TEST_YEAR,
                             "ids": [TEST_MEDIA_ID + 2, TEST_MEDIA_ID]},
                       headers=auth_headers, timeout=5)
    if r.status_code != 200:
        fail(11, f"PATCH /rank failed: {r.status_code} {r.text[:200]}")
    # Verify: GET /list and check watchedRank values were swapped
    r = requests.get(f"{backend}/api/list",
                     params={"season": TEST_SEASON, "year": TEST_YEAR},
                     headers=auth_headers, timeout=5)
    rows = {x["mediaId"]: x.get("watchedRank") for x in r.json() if x.get("watched")}
    if rows.get(TEST_MEDIA_ID + 2) != 0 or rows.get(TEST_MEDIA_ID) != 1:
        fail(11, f"ranks not swapped: {rows}")
    step(11, f"PASS — ranks swapped (mediaId+2 → 0, mediaId → 1)")

    # ───────── 12/12  Anime endpoint cache hit latency ─────────
    step(12, "GET /api/anime twice — second call should be cached < 200ms")
    t0 = time.time()
    r = requests.get(f"{backend}/api/anime",
                     params={"season": TEST_SEASON, "year": TEST_YEAR, "format": "TV"},
                     timeout=30)
    first_ms = (time.time() - t0) * 1000
    if r.status_code != 200:
        fail(12, f"first call failed: {r.status_code}")
    t0 = time.time()
    r = requests.get(f"{backend}/api/anime",
                     params={"season": TEST_SEASON, "year": TEST_YEAR, "format": "TV"},
                     timeout=5)
    second_ms = (time.time() - t0) * 1000
    if r.status_code != 200:
        fail(12, f"second call failed: {r.status_code}")
    if second_ms > 200:
        fail(12, f"second call too slow ({second_ms:.0f}ms) — cache not used")
    step(12, f"PASS — cache hit: {first_ms:.0f}ms → {second_ms:.0f}ms")

    # ───────── 13/13  /api/users endpoint (Compare username picker) ─────────
    # API returns up to 20 usernames alphabetically, excluding users with
    # hideFromCompare=true. Step 10 set hideFromCompare=true for our test user,
    # so they're correctly filtered out. We need to reset that flag first.
    step(13, "Resetting hideFromCompare=false, then GET /api/users")
    requests.put(f"{backend}/api/options",
                 json={"theme": "SYSTEM", "titleLanguage": "ENGLISH",
                       "videoAutoplay": True, "hideFromCompare": False,
                       "nicknameUserSel": [], "addWatchedTo": "BOTTOM"},
                 headers=auth_headers, timeout=5)
    r = requests.get(f"{backend}/api/users", timeout=5)
    if r.status_code != 200:
        fail(13, f"expected 200, got {r.status_code} {r.text[:200]}")
    users = r.json()
    if not isinstance(users, list) or len(users) == 0:
        fail(13, f"expected non-empty array, got {users!r}")
    if not all(isinstance(u, str) for u in users):
        fail(13, "expected array of strings")
    # Use prefix filter to find our user (Compare dropdown's real usage).
    # Query the full username: /api/users caps results at 20 alphabetically, so
    # a short shared prefix silently drops the newest test user once a handful
    # of them exist.
    r = requests.get(f"{backend}/api/users", params={"q": username}, timeout=5)
    filtered = r.json()
    if username not in filtered:
        fail(13, f"prefix filter didn't include our user (got {len(filtered)} matches)")
    step(13, f"PASS — {len(users)} usernames; prefix filter finds our user")

    print(f"\nDone: {TOTAL_STEPS}/{TOTAL_STEPS} passed", flush=True)


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nFAIL — backend unreachable: {e}", flush=True)
        sys.exit(1)
