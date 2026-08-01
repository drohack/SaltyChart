"""
Pre-deploy smoke test: frontend UI interactions.

Beyond `test_frontend_smoke.py` (which only checks pages render), this
tests that clicking buttons actually triggers the right behavior — login
flow, search filter, season change, add-to-list, theme dropdown, logout,
hide 18+, trailer modal Escape close.

Catches the class of regression where a button is rendered but its click
handler is broken or the reactive state isn't wired correctly.

Usage:
  pip install playwright
  playwright install chromium
  py -3.13 -u tools/tests/test_ui_interactions.py [--frontend http://localhost:5173]
"""
import argparse
import json
import re
import subprocess
import sys
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

TOTAL = 14
# `stores/season.ts` restores the last selection from this key (1h TTL). The
# pages open on the *look-ahead* season otherwise, which is not the one these
# tests seed — and a list whose ids aren't in the displayed season renders
# nothing at all, since entries are joined against that season's metadata.
SEASON_KEY = "season-year"
SEEDED_SEASON, SEEDED_YEAR = "SUMMER", 2026


def season_ids(backend: str, n: int = 3) -> list[int]:
    """Real mediaIds from the seeded season.

    These used to be hardcoded (158036/158037/158038). AniList season contents
    change, and by now not one of those three is in Summer 2026 — so every
    seeded list joined against zero shows and the pages rendered empty, which
    the older assertions were loose enough to pass anyway.
    """
    r = requests.get(f"{backend}/api/anime",
                     params={"season": SEEDED_SEASON, "year": SEEDED_YEAR}, timeout=120)
    r.raise_for_status()
    ids = [a["id"] for a in r.json()[:n]]
    assert len(ids) == n, f"{SEEDED_SEASON} {SEEDED_YEAR} returned only {len(ids)} shows"
    return ids


def seed_list(backend: str, token: str, ids: list[int]) -> None:
    r = requests.put(f"{backend}/api/list", timeout=15,
                     headers={"Authorization": f"Bearer {token}"},
                     json={"season": SEEDED_SEASON, "year": SEEDED_YEAR,
                           "items": [{"mediaId": m} for m in ids]})
    assert r.status_code == 200, f"seeding failed: {r.status_code} {r.text[:120]}"


def pin_season(page) -> None:
    page.evaluate(
        "([k, s, y]) => localStorage.setItem(k, JSON.stringify("
        "{ season: s, year: y, saved: Date.now() }))",
        [SEASON_KEY, SEEDED_SEASON, SEEDED_YEAR])


UNKNOWN_BODY = '{"available": false, "unknown": true}'

# Availability is asked two ways — one show at a time for the pop-up, and a
# whole page at once for the wheel — so a pattern that only matches the single
# route lets the batch call through to the real server. That would not fail
# loudly: the wheel would get genuine answers, most shows would be available,
# and the "unknown never hides" test would pass while testing nothing.
AVAILABILITY_ROUTE = "**/api/jellyfin/availability**"


def unknown_availability(route) -> None:
    """Answer either availability route with `unknown`, in that route's shape."""
    if route.request.url.rstrip("/").endswith("/batch"):
        try:
            items = (route.request.post_data_json or {}).get("items", [])
        except Exception:
            items = []
        body = json.dumps({str(it["mediaId"]): {"available": False, "unknown": True}
                           for it in items})
    else:
        body = UNKNOWN_BODY
    route.fulfill(status=200, content_type="application/json", body=body)
COUNT_COLOURS = """async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = Math.min(img.naturalWidth, 200);
    c.height = Math.min(img.naturalHeight, 200);
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4)
        seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
    return seen.size;
}"""
REPO = Path(__file__).resolve().parents[2]


def admin_token() -> str:
    """A JWT for ADMIN_USER_ID, signed with the backend's own secret.

    /admin is gated on the user id, and the fixture users this suite creates are
    never that user — so without minting one, the admin UI cannot be reached at
    all. Signed through node so the suite gains no dependency and signs exactly
    the way the app does. Reading local config for a test is established
    practice here: tools/bench_player.py reads the Jellyfin key from the DB.
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


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL} UI-interact] {msg}", flush=True)


def wait_for_grids(page, timeout: int = 30_000) -> None:
    """
    Wait until Home has finished loading *every* section.

    Sections load independently, so cards being on screen no longer means the
    page is done — the Leftovers grid frequently renders while the current
    season is still a skeleton. Anything that counts or clicks cards has to
    wait for the skeletons to go away, not just for the first image.
    """
    page.wait_for_selector('img[src*="anilist"]', timeout=timeout)
    page.wait_for_selector(".skeleton", state="detached", timeout=timeout)


def signup_and_login(page, frontend: str) -> tuple[str, str]:
    """Sign up a fresh user, return (username, password)."""
    username = f"ui_test_{int(time.time())}"
    password = "ui_test_pw_123"
    page.goto(f"{frontend}/signup")
    page.wait_for_selector('input[placeholder="Username"]')
    page.fill('input[placeholder="Username"]', username)
    page.fill('input[type="password"]', password)
    page.get_by_role("button", name=re.compile(r"sign\s*up|create", re.I)).click()
    page.wait_for_url(re.compile(r"/$|/home"), timeout=10_000)
    return username, password


# ─────────────────────────────────────────────────────────────────────────────
# 1/10  Login form
# ─────────────────────────────────────────────────────────────────────────────
def test_login_form(page, frontend: str, username: str, password: str):
    step(1, "step 1/3: logging out first to test fresh login")
    page.evaluate("localStorage.removeItem('token'); localStorage.removeItem('username')")
    page.goto(f"{frontend}/login")
    page.wait_for_selector('input[placeholder="Username"]', timeout=5_000)

    step(1, f"step 2/3: typing creds + clicking Login as {username}")
    page.fill('input[placeholder="Username"]', username)
    page.fill('input[type="password"]', password)
    page.get_by_role("button", name=re.compile(r"^log\s*in$", re.I)).click()

    step(1, "step 3/3: verifying redirect + authToken stored")
    page.wait_for_url(re.compile(r"/$|/home"), timeout=10_000)
    token = page.evaluate("localStorage.getItem('token')")
    assert token, f"authToken not set in localStorage after login"
    step(1, f"PASS — redirected, token set (len={len(token)})")


# ─────────────────────────────────────────────────────────────────────────────
# 2/10  Search filter
# ─────────────────────────────────────────────────────────────────────────────
def test_search_filter(page):
    step(2, "step 1/3: navigating Home and counting cards")
    wait_for_grids(page)
    before = page.locator('img[src*="anilist"]').count()
    assert before > 5, f"need more anime to test filter (got {before})"

    step(2, f"step 2/3: typing 'Eren' in search filter ({before} cards before)")
    search = page.locator('input[type="text"]').first
    search.fill("Eren")
    page.wait_for_timeout(300)

    step(2, "step 3/3: verifying card count dropped")
    after = page.locator('img[src*="anilist"]').count()
    assert after < before, f"search didn't filter: {before} → {after}"

    search.fill("")  # cleanup — must fully restore for downstream tests
    page.wait_for_timeout(300)
    step(2, f"PASS — {before} → {after} cards on 'Eren' filter")


# ─────────────────────────────────────────────────────────────────────────────
# 3/10  Hide 18+ filter
# ─────────────────────────────────────────────────────────────────────────────
def test_hide_18plus(page):
    step(3, "step 1/3: counting cards with Hide 18+ unchecked")
    # Find the Hide 18+ checkbox by its associated label text
    checkbox = page.locator('label').filter(has_text=re.compile(r"Hide 18\+", re.I)).locator('input[type="checkbox"]').first
    if checkbox.count() == 0:
        # Fall back to any checkbox near "18+" text
        checkbox = page.get_by_role("checkbox").filter(has_text=re.compile(r"18\+", re.I)).first
    initial_state = checkbox.is_checked()
    if initial_state:
        # Uncheck first so we know we'll have a clear baseline
        checkbox.click()
        page.wait_for_timeout(300)
    before = page.locator('img[src*="anilist"]').count()

    step(3, f"step 2/3: clicking Hide 18+ checkbox ({before} cards before)")
    checkbox.click()
    page.wait_for_timeout(400)

    step(3, "step 3/3: verifying card count changed")
    after = page.locator('img[src*="anilist"]').count()
    # Hide 18+ should reduce count (current season may have 0 adult, in which case it's equal — accept that too)
    assert after <= before, f"after Hide 18+, count went up?? {before} → {after}"

    # Restore initial state
    if checkbox.is_checked() != initial_state:
        checkbox.click()
        page.wait_for_timeout(300)
    step(3, f"PASS — Hide 18+ toggled ({before} → {after})")


# ─────────────────────────────────────────────────────────────────────────────
# 4/10  Season change
# ─────────────────────────────────────────────────────────────────────────────
def test_season_change(page, frontend: str):
    step(4, "step 1/3: ensuring on Home and finding active season button")
    page.goto(frontend)
    wait_for_grids(page)
    page.wait_for_timeout(500)  # let toolbar render

    # Find the current active season via JS — Playwright's has_text+regex fails on
    # the trimmed Svelte button text. JS is more reliable here.
    current = page.evaluate("""() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const t = (b.textContent || '').trim();
        if (['Winter','Spring','Summer','Fall'].includes(t) && b.className.includes('btn-primary')) return t;
      }
      return null;
    }""")
    assert current, "no active season button found among Winter/Spring/Summer/Fall"

    other = "Fall" if current != "Fall" else "Winter"
    step(4, f"step 2/3: clicking {other} (was {current})")
    # Click via JS evaluation by text — bypasses Playwright locator issues
    page.evaluate(f"""() => {{
      const btns = Array.from(document.querySelectorAll('button'));
      const t = btns.find(b => (b.textContent || '').trim() === '{other}');
      if (t) t.click();
    }}""")
    # Wait for anime fetch to settle — networkidle is faster than a fixed sleep
    try:
        page.wait_for_load_state('networkidle', timeout=4_000)
    except Exception:
        page.wait_for_timeout(1_000)  # fallback if events keep firing

    step(4, "step 3/3: verifying active season changed")
    new_active = page.evaluate("""() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const t = (b.textContent || '').trim();
        if (['Winter','Spring','Summer','Fall'].includes(t) && b.className.includes('btn-primary')) return t;
      }
      return null;
    }""")
    assert new_active == other, f"expected active={other}, got {new_active}"

    # Restore
    page.evaluate(f"""() => {{
      const btns = Array.from(document.querySelectorAll('button'));
      const t = btns.find(b => (b.textContent || '').trim() === '{current}');
      if (t) t.click();
    }}""")
    try:
        page.wait_for_load_state('networkidle', timeout=4_000)
    except Exception:
        page.wait_for_timeout(800)
    step(4, f"PASS — {current} → {other} → back to {current}")


# ─────────────────────────────────────────────────────────────────────────────
# 5/10  "watched trailer" button adds to list
# ─────────────────────────────────────────────────────────────────────────────
def test_watched_trailer_button(page, backend: str):
    step(5, "step 1/3: noting current list size via API")
    token = page.evaluate("localStorage.getItem('token')")
    auth = {"Authorization": f"Bearer {token}"}
    # Read the season/year the UI is actually displaying — the default season
    # moves with the calendar (76-day lookahead), so hardcoding e.g. SUMMER
    # breaks once the app rolls over to the next season.
    ui_season = page.evaluate("""() => {
        for (const b of document.querySelectorAll('button')) {
            const t = b.textContent.trim();
            if (['Winter','Spring','Summer','Fall'].includes(t) && b.className.includes('btn-primary'))
                return t.toUpperCase();
        }
        return null;
    }""")
    ui_year = page.evaluate("""() => {
        // `every` alone is vacuously true for an empty <select>, which would
        // pick the wrong control the moment one renders before its options.
        const sel = [...document.querySelectorAll('select')].find(s =>
            s.options.length > 0 && [...s.options].every(o => /^\\d{4}$/.test(o.value)));
        return sel ? Number(sel.value) : null;
    }""")
    assert ui_season and ui_year, f"could not read UI season/year ({ui_season}, {ui_year})"
    def get_list_size() -> int:
        r = requests.get(f"{backend}/api/list",
                         params={"season": ui_season, "year": ui_year},
                         headers=auth, timeout=5)
        return len(r.json()) if r.ok else -1
    before_size = get_list_size()

    step(5, "step 2/3: clicking first 'watched trailer' button")
    # Sections load independently now, and Leftovers (the *previous* season)
    # often lands first. Clicking then would PATCH the wrong season, so wait
    # for every skeleton to be replaced by real cards before picking a button.
    wait_for_grids(page)
    btns = page.get_by_role("button", name=re.compile(r"^watched trailer$", re.I))
    count = btns.count()
    assert count > 0, "no 'watched trailer' buttons on Home — page not rendering buttons correctly"
    btns.first.click()
    page.wait_for_timeout(800)  # PATCH /api/list/watched + toast

    step(5, "step 3/3: verifying list grew by 1 via API")
    after_size = get_list_size()
    assert after_size == before_size + 1, \
        f"list size should have grown by 1: {before_size} → {after_size}"
    step(5, f"PASS — list grew {before_size} → {after_size} after button click")


# ─────────────────────────────────────────────────────────────────────────────
# 6/10  Theme dropdown applies theme
# ─────────────────────────────────────────────────────────────────────────────
def test_theme_change(page):
    step(6, "step 1/3: noting current data-theme attribute")
    initial = page.evaluate("document.documentElement.getAttribute('data-theme')")

    step(6, "step 2/3: opening Options modal and changing theme")
    # Settings gear button — its inner text is the "settings" material icon ligature
    page.get_by_role("button", name="Options").click()
    page.wait_for_selector('select#themeSelect', timeout=3_000)
    # Pick a value different from current
    new_theme = "NIGHT" if initial != "dark" else "LIGHT"
    page.locator('select#themeSelect').select_option(new_theme)
    page.wait_for_timeout(300)

    step(6, "step 3/3: verifying data-theme attribute changed")
    after = page.evaluate("document.documentElement.getAttribute('data-theme')")
    assert after != initial, f"data-theme didn't change: {initial} → {after}"

    # Restore — SYSTEM is the default install state for fresh signup
    page.locator('select#themeSelect').select_option("SYSTEM")
    page.wait_for_timeout(200)
    # Close modal by clicking backdrop or close button
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    step(6, f"PASS — theme changed from {initial} to {after}")


# ─────────────────────────────────────────────────────────────────────────────
# 7/10  Wheel spin opens result modal (Randomize page, auth required)
# ─────────────────────────────────────────────────────────────────────────────
def test_wheel_spin(page, backend: str, frontend: str, token: str):
    """Verify Randomize page is interactive — wheel renders (if items in
    current season) or empty-state shows. Spin if possible, verify modal."""
    step(7, "step 1/3: navigating to /random")
    page.goto(f"{frontend}/random")
    page.wait_for_timeout(3_000)
    # Confirm we didn't get redirected to /login
    assert "/random" in page.url, f"redirected away from /random: {page.url}"

    step(7, "step 2/3: looking for Spin button or empty state")
    # Either the wheel has items (Spin button exists) or empty-state message
    state = page.evaluate("""() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const spin = buttons.find(b => (b.textContent || '').trim() === 'Spin');
      if (spin) return { state: 'wheel', has_spin: true };
      const bodyText = (document.body.textContent || '').toLowerCase();
      if (bodyText.includes('no shows') || bodyText.includes('empty') || bodyText.includes('add some')) {
        return { state: 'empty' };
      }
      return { state: 'unknown', sample: bodyText.slice(0, 200) };
    }""")
    if state.get("state") == "wheel":
        step(7, "step 3/3: clicking Spin button → expect result modal")
        page.evaluate("""() => {
          const b = Array.from(document.querySelectorAll('button'))
            .find(b => (b.textContent || '').trim() === 'Spin');
          if (b) b.click();
        }""")
        page.wait_for_timeout(5_500)
        has_modal = page.locator('button').filter(
            has_text=re.compile(r"mark.*watched|hide.*series", re.I)).count() > 0
        assert has_modal, f"result modal didn't appear after spin"
        step(7, "PASS — wheel spun, result modal appeared")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
    elif state.get("state") == "empty":
        step(7, "PASS — Randomize page loaded (empty state, no items in season)")
    else:
        assert False, f"Randomize page in unknown state: {state}"


# ─────────────────────────────────────────────────────────────────────────────
# 8/10  Logout clears auth and kicks out of auth-gated pages
# ─────────────────────────────────────────────────────────────────────────────
def test_logout(page, frontend: str):
    step(8, "step 1/3: navigating to Home (ensures no modal overlay) + clicking Logout")
    # Previous wheel test may have left a result modal open over the header —
    # navigate fresh to ensure logout link is clickable
    page.goto(frontend)
    wait_for_grids(page)
    logout = page.get_by_role("link", name=re.compile(r"^logout$", re.I))
    if logout.count() == 0:
        logout = page.locator('button, a').filter(has_text=re.compile(r"^Logout$", re.I)).first
    logout.click()
    page.wait_for_timeout(500)

    step(8, "step 2/3: verifying authToken cleared from localStorage")
    tok = page.evaluate("localStorage.getItem('token')")
    assert not tok, f"authToken still set after logout: {tok}"

    step(8, "step 3/3: navigating to /random — should redirect/disable")
    page.goto(f"{frontend}/random")
    page.wait_for_timeout(1_500)
    # Either we're redirected away, or the page shows a "please log in" state.
    # The simplest check: no wheel SVG rendered.
    wheel_count = page.locator('svg[viewBox="-50 -50 100 100"]').count()
    assert wheel_count == 0, "wheel still rendered after logout — auth-gate broken"
    step(8, "PASS — logout cleared token, /random not accessible")


# ─────────────────────────────────────────────────────────────────────────────
# 9/10  Trailer modal Escape closes
# ─────────────────────────────────────────────────────────────────────────────
def test_trailer_modal_escape(page, frontend: str):
    step(9, "step 1/3: returning to Home and opening a trailer")
    page.goto(frontend)
    wait_for_grids(page)
    # Click any YouTube thumbnail to open the modal
    trailer = page.locator('button:has(img[src*="ytimg.com"])').first
    trailer.click()
    page.wait_for_selector('iframe[src*="youtube"]', timeout=10_000)

    step(9, "step 2/3: confirming modal is open")
    iframe_count = page.locator('iframe[src*="youtube"]').count()
    assert iframe_count > 0, "iframe didn't open"

    step(9, "step 3/3: pressing Escape → expect modal gone")
    page.keyboard.press("Escape")
    page.wait_for_timeout(800)
    iframe_after = page.locator('iframe[src*="youtube"]').count()
    if iframe_after > 0:
        # Some implementations use backdrop click instead of Escape — try that
        page.locator('.fixed.inset-0.bg-black\\/80').click(position={"x": 5, "y": 5})
        page.wait_for_timeout(500)
        iframe_after = page.locator('iframe[src*="youtube"]').count()
    assert iframe_after == 0, f"modal still open after Escape: {iframe_after} iframes"
    step(9, "PASS — modal closed cleanly")


# ─────────────────────────────────────────────────────────────────────────────
# 10/10  Compare page with 2 users — table renders with diff
# ─────────────────────────────────────────────────────────────────────────────
def test_compare_two_users(page, backend: str, frontend: str):
    """Compare must show the right numbers, not merely render.

    This used to assert `any(s in body_text for s in ("Compare", "compare",
    "2nd user", "vs"))`, which passes on a page that rendered no rows at all —
    and it never even selected a second user. Both lists are seeded here with
    deliberately different orders so every rank and diff on screen is known in
    advance, and the page is read through `data-compare-row` hooks rather than
    by scraping text.
    """
    ts = int(time.time())
    user_a, user_b = f"ui_cmp_A_{ts}", f"ui_cmp_B_{ts}"
    step(10, f"step 1/5: seeding {user_a} and {user_b} with known, differing orders")
    tokens = {}
    for name in (user_a, user_b):
        r = requests.post(f"{backend}/api/auth/signup",
                          json={"username": name, "password": "pw"}, timeout=10)
        assert r.status_code == 200, f"{name} signup failed: {r.status_code} {r.text[:120]}"
        tokens[name] = r.json()["token"]

    # rank == position in the list (idx + 1); diff == |rankA - rankB|.
    x, y, z = season_ids(backend, 3)
    ORDER_A, ORDER_B = [x, y, z], [z, x, y]
    EXPECTED = {x: (1, 2, 1), y: (2, 3, 1), z: (3, 1, 2)}
    for name, order in ((user_a, ORDER_A), (user_b, ORDER_B)):
        seed_list(backend, tokens[name], order)

    step(10, "step 2/5: signing in as user A and opening /compare")
    page.goto(frontend)
    page.evaluate("([t, u]) => { localStorage.setItem('token', t);"
                  " localStorage.setItem('username', u); }", [tokens[user_a], user_a])
    pin_season(page)
    page.goto(f"{frontend}/compare")
    page.wait_for_timeout(2500)
    assert "/login" not in page.url, "Compare redirected to /login despite a valid token"

    step(10, f"step 3/5: picking {user_b} as the second user")
    # svelte-select puts the id on the input itself and only commits a
    # *highlighted* option, so typing alone leaves `selectedOther` unset and
    # every rankB renders blank.
    box = page.locator("#otherUser").first
    box.wait_for(timeout=15_000)
    box.click()
    box.type(user_b, delay=40)
    # The suggestion list is fetched from /api/users on a debounce, so the
    # option is not there the instant typing stops.
    option = page.get_by_text(user_b, exact=True).last
    for _ in range(10):
        page.wait_for_timeout(800)
        if option.count():
            break
    if option.count():
        option.click()
    else:
        page.keyboard.press("ArrowDown")
        page.keyboard.press("Enter")
    page.wait_for_timeout(2000)

    step(10, "step 4/5: confirming the second user was actually selected")
    picked = page.evaluate(
        "() => [...document.querySelectorAll('[data-rank-b]')]"
        ".some(e => e.getAttribute('data-rank-b'))")
    # This is an assertion, not a skip. The picker searches the backend as you
    # type, so a freshly created user IS findable — that was broken once
    # (`bind:searchText` + `on:search`, neither of which svelte-select 5 has),
    # which capped the picker at whatever `/api/users` returns unfiltered and
    # made anyone outside that slice unselectable. Skipping here would hide
    # exactly that regression coming back.
    assert picked, (f"{user_b} was never offered by the picker — the search box is "
                    f"not querying the backend, so users outside the unfiltered "
                    f"/api/users slice cannot be compared with")
    try:
        page.wait_for_function("() => document.querySelectorAll('[data-compare-row]').length > 0",
                               timeout=20_000)
    except Exception:
        raise AssertionError(f"no comparison rows rendered after picking {user_b}")

    step(10, "step 5/5: verifying the ranks and diffs on screen")
    rows = page.evaluate("""() => [...document.querySelectorAll('[data-compare-row]')].map(e => ({
        id: +e.getAttribute('data-compare-row'),
        a: e.getAttribute('data-rank-a'),
        b: e.getAttribute('data-rank-b'),
        d: e.getAttribute('data-diff'),
    }))""")
    seen = {r["id"]: r for r in rows}
    missing = [m for m in EXPECTED if m not in seen]
    assert not missing, f"seeded shows absent from Compare: {missing} (rendered: {list(seen)})"
    for media_id, (want_a, want_b, want_d) in EXPECTED.items():
        got = seen[media_id]
        assert (got["a"], got["b"], got["d"]) == (str(want_a), str(want_b), str(want_d)), (
            f"media {media_id}: expected rankA={want_a} rankB={want_b} diff={want_d}, "
            f"got rankA={got['a']} rankB={got['b']} diff={got['d']}")
    step(10, f"PASS — {len(EXPECTED)} shared rows, ranks and diffs all match the seeded orders")

def test_admin_page(page, backend: str, frontend: str):
    """The admin page and its playback-account picker.

    Never loaded by any test before this. The Jellyfin config UI was covered
    only at the API level, so the picker could render empty -- or leak the API
    key into the DOM -- and every check would still have passed.
    """
    step(11, "step 1/3: minting an admin token")
    tok = admin_token()
    if not tok:
        step(11, "SKIP -- could not sign an admin token (node or backend/.env missing)")
        return

    step(11, "step 2/3: loading /admin as the admin user")
    page.goto(frontend)
    page.evaluate("t => { localStorage.setItem('token', t);"
                  " localStorage.setItem('username', 'admin_probe'); }", tok)
    page.goto(f"{frontend}/admin")
    page.wait_for_selector("#jf-url", timeout=20_000)
    body = page.evaluate("document.body.textContent || ''")
    assert "only available to the site admin" not in body, \
        "admin page refused a token for ADMIN_USER_ID"

    step(11, "step 3/3: picker populated, and no API key anywhere in the DOM")
    opts = page.eval_on_selector_all("#jf-user option",
                                     "els => els.map(e => e.textContent.trim())")
    assert opts, "no playback-account picker rendered"
    # The key is stored server-side and must never reach a browser; a Jellyfin
    # API key is 32 hex characters.
    leak = re.search(r"\b[0-9a-f]{32}\b", page.content())
    assert not leak, f"a 32-hex string resembling the API key is in the DOM: {leak.group()[:8]}..."
    if len(opts) == 1:
        step(11, f"PASS -- picker present with only the default option "
                 f"(Jellyfin may be unconfigured), no key in the DOM")
    else:
        step(11, f"PASS -- {len(opts)} accounts offered, no key in the DOM")


def test_unknown_never_hides(page, backend: str, frontend: str, token: str):
    """`unknown` means "couldn't ask", never "not in the library".

    Treating a slow or dead Jellyfin as a definite no would let "Hide Not in
    Library" empty the entire wheel. The control is gated on
    `hasNonLibraryVisible`, which counts only definite answers, so with every
    lookup unknown it must refuse to act.
    """
    step(12, "step 1/3: seeding a list, forcing every availability lookup to unknown")
    seed_list(backend, token, season_ids(backend, 3))
    page.route(AVAILABILITY_ROUTE, unknown_availability)
    try:
        step(12, "step 2/3: opening the wheel")
        page.goto(frontend)
        page.evaluate("t => localStorage.setItem('token', t)", token)
        pin_season(page)
        page.goto(f"{frontend}/random")
        page.wait_for_timeout(5000)
        before = page.locator('li[role="button"]').count()
        assert before, "no unwatched entries rendered -- nothing to test hiding against"

        step(12, "step 3/3: the hide control must refuse to act on unknowns")
        hide = page.locator("button", has_text="Hide Not in Library")
        if hide.count():
            assert hide.first.is_disabled(), (
                "'Hide Not in Library' is enabled while every lookup returned unknown "
                "-- one slow moment would empty the wheel")
        page.wait_for_timeout(1500)
        after = page.locator('li[role="button"]').count()
        assert after == before, f"entries vanished on unknown verdicts: {before} -> {after}"
        step(12, f"PASS -- {before} entries kept; control is "
                 f"{'disabled' if hide.count() else 'not offered'} on unknown verdicts")
    finally:
        page.unroute(AVAILABILITY_ROUTE)


def test_share_as_image(page, backend: str, frontend: str, token: str):
    """Share-as-image really produces an image.

    `shareMyList()` resolves `toJpeg` as `mod.toJpeg ?? mod.default?.toJpeg`
    inside a try/catch that swallows everything -- the same shape that once
    downgraded every ASS release to WebVTT without a word. CLAUDE.md says to
    verify this by hand; this is that check, automated.
    """
    step(13, "step 1/3: opening Home with a populated list")
    seed_list(backend, token, season_ids(backend, 3))
    page.goto(frontend)
    page.evaluate("t => localStorage.setItem('token', t)", token)
    pin_season(page)
    page.goto(frontend)
    wait_for_grids(page)
    share = page.locator("[data-share-btn]").first
    if not share.count():
        step(13, "SKIP -- the share control is not rendered at this viewport")
        return

    step(13, "step 2/3: clicking Share and capturing what it writes")
    # The image is rendered first and `window.open` runs after that await, by
    # which point Chrome no longer treats it as user-activated and blocks the
    # popup. Stub the window so this tests the part that fails *silently* — the
    # rendering — rather than the browser's popup policy.
    # The stub has to answer the whole document API the real code uses —
    # open(), write(), close(). Missing `open` made this look like the feature
    # was broken when the only thing broken was the stub.
    page.evaluate("""() => {
        window.__shared = null;
        window.open = () => ({
            document: {
                open() {}, close() {},
                write: (html) => { window.__shared = (window.__shared || '') + html; },
            },
            focus() {}, close() {},
        });
    }""")
    share.click()
    try:
        page.wait_for_function("() => window.__shared", timeout=90_000)
    except Exception:
        raise AssertionError("Share produced nothing — toJpeg most likely resolved to "
                             "undefined and the failure was swallowed by its try/catch")
    src = page.evaluate("""() => (window.__shared.match(/src="([^"]+)"/) || [])[1] || ''""")
    assert src.startswith("data:image/jpeg"), (
        f"share produced no JPEG data URL (got {src[:60]!r}) -- toJpeg most likely "
        f"resolved to undefined and the failure was swallowed")
    assert len(src) > 5000, f"share produced a suspiciously tiny image ({len(src)} chars)"

    step(13, "step 3/3: the image has content, not a blank rectangle")
    # Size alone would pass on a large all-white render, which is the realistic
    # silent failure when the off-screen clone is styled wrong.
    colours = page.evaluate(COUNT_COLOURS, src)
    assert colours > 1, "the shared image is one flat colour -- it rendered blank"
    step(13, f"PASS -- {len(src) // 1024} KB JPEG, {colours} distinct colour buckets")


def test_progressive_loading(page, frontend: str):
    """One section failing must not blank the other.

    Home fetches the current season and the previous season's leftovers
    independently, tracking `errorMain` / `errorLeftovers` separately. Only the
    leftovers request carries `format=TV`, so it can be failed on its own.
    """
    step(14, "step 1/2: failing only the leftovers fetch")
    page.route("**/api/anime?**format=TV**", lambda route: route.abort())
    try:
        page.goto(frontend)
        page.wait_for_timeout(6000)
        retry = page.locator("button:text-is('Retry')")
        assert retry.count(), "a failed section offered no Retry control"
        covers = page.locator("img[alt]").count()
        assert covers > 0, ("the page blanked when one section failed -- the two "
                            "sections are meant to fail independently")
        step(14, f"step 2/2: Retry offered, and {covers} covers still rendered from "
                 f"the section that succeeded")
    finally:
        page.unroute("**/api/anime?**format=TV**")
    page.locator("button:text-is('Retry')").first.click()
    page.wait_for_timeout(4000)
    assert not page.locator("button:text-is('Retry')").count(), \
        "Retry did not clear the error state once the network recovered"
    step(14, "PASS -- one section failed alone, Retry recovered it")



# ─────────────────────────────────────────────────────────────────────────────
# Main
# ─────────────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frontend", default="http://localhost:5173")
    parser.add_argument("--backend",  default="http://localhost:3000")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    frontend = args.frontend.rstrip("/")
    print(f"UI interaction smoke test — {frontend}", flush=True)

    failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        page = browser.new_page()
        try:
            username, password = signup_and_login(page, frontend)
            # Capture the token now so we can use it for the wheel test seeding
            token_a = page.evaluate("localStorage.getItem('token')")
            print(f"  signed up as {username}\n", flush=True)

            # Order: tests 1-7 auth'd, 8 logs out, 9 unauth'd, 10 re-auths user B
            tests = [
                ("login form",         lambda: test_login_form(page, frontend, username, password)),
                ("search filter",      lambda: test_search_filter(page)),
                ("hide 18+ filter",    lambda: test_hide_18plus(page)),
                ("season change",      lambda: test_season_change(page, frontend)),
                ("watched trailer btn",lambda: test_watched_trailer_button(page, args.backend)),
                ("theme dropdown",     lambda: test_theme_change(page)),
                ("wheel spin",         lambda: test_wheel_spin(page, args.backend, frontend, token_a)),
                ("logout",             lambda: test_logout(page, frontend)),
                ("trailer modal esc",  lambda: test_trailer_modal_escape(page, frontend)),
                ("compare 2 users",    lambda: test_compare_two_users(page, args.backend, frontend)),
                # 11-14 re-auth as the original user where they need a session;
                # 8 logged out, so each sets its own token rather than assuming one.
                ("admin page",         lambda: test_admin_page(page, args.backend, frontend)),
                ("unknown never hides",lambda: test_unknown_never_hides(page, args.backend, frontend, token_a)),
                ("share as image",     lambda: test_share_as_image(page, args.backend, frontend, token_a)),
                ("progressive loading",lambda: test_progressive_loading(page, frontend)),
            ]
            for label, fn in tests:
                try:
                    fn()
                except AssertionError as e:
                    print(f"  FAIL [{label}] — {e}", flush=True)
                    failed += 1
                except Exception as e:
                    print(f"  ERROR [{label}] — {type(e).__name__}: {e}", flush=True)
                    failed += 1
        finally:
            browser.close()

    if failed:
        print(f"\nDone: {TOTAL - failed}/{TOTAL} passed, {failed} failed", flush=True)
        sys.exit(1)
    print(f"\nDone: {TOTAL}/{TOTAL} passed", flush=True)


if __name__ == "__main__":
    main()
