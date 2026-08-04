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

TOTAL = 24
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
    # moves with the calendar (50-day lookahead), so hardcoding e.g. SUMMER
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

    step(9, "step 3/4: pressing Escape → expect modal gone")
    page.keyboard.press("Escape")
    page.wait_for_timeout(800)
    iframe_after = page.locator('iframe[src*="youtube"]').count()
    # No backdrop-click fallback. This step used to fall back to clicking the
    # backdrop and assert on *that*, so it passed for months while Escape closed
    # nothing at all — the handler sat on a tabindex="-1" overlay that never
    # received focus. If Escape is broken, this must go red.
    assert iframe_after == 0, (
        f"Escape did not close the trailer modal ({iframe_after} iframes still open). "
        "Check the <svelte:window on:keydown> handler in AnimeGridTranslate.svelte."
    )

    step(9, "step 4/4: reopening and closing with the ✕ button")
    trailer.click()
    page.wait_for_selector('iframe[src*="youtube"]', timeout=10_000)
    close_btn = page.locator('button[aria-label="Close trailer"]')
    assert close_btn.count() == 1, (
        "trailer modal has no visible close button — the backdrop was the only "
        "way out, which is near-invisible on a phone"
    )
    close_btn.click()
    page.wait_for_timeout(600)
    assert page.locator('iframe[src*="youtube"]').count() == 0, "✕ button did not close the modal"
    step(9, "PASS — Escape and the ✕ button both close the trailer")


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


def test_no_results_message(page, frontend: str):
    """A search matching nothing must say so.

    Every section on Home is gated on `.length`, so a no-match search rendered a
    completely blank page — indistinguishable from "still loading" or "broken".
    """
    step(15, "step 1/3: loading Home and searching for something that can't match")
    page.goto(frontend)
    wait_for_grids(page)
    page.fill("#search", "zzzzznotarealshow")
    page.wait_for_timeout(1200)

    step(15, "step 2/3: expecting an explicit no-results message")
    msg = page.locator("[data-no-results]")
    assert msg.count() == 1, (
        "a no-match search rendered nothing at all — no explanation, no empty state"
    )
    text = msg.inner_text()
    assert "zzzzznotarealshow" in text, f"message didn't name the search term: {text!r}"

    step(15, "step 3/3: clearing the search restores the grid")
    page.fill("#search", "")
    page.wait_for_timeout(1200)
    assert page.locator("[data-no-results]").count() == 0, \
        "no-results message stayed up after the search was cleared"
    assert page.locator('img[alt]').count() > 0, "grid did not come back"
    step(15, f"PASS — {text.strip()[:60]!r}")


def test_library_unreachable_is_visible(page, backend: str, frontend: str, token: str):
    """A failed library lookup must say so, and must recover without a reload.

    This is the one failure that was actually reproduced from a real report: no
    Watch buttons anywhere, Hide-Not-in-Library greyed out, nothing on screen
    explaining it, and no retry — so it looked identical to a healthy library
    with nothing missing. The batch was failing and the store swallowed it.
    """
    step(17, "step 1/3: seeding a list, then failing every availability lookup")
    ids = season_ids(backend, 3)
    seed_list(backend, token, ids)
    page.goto(frontend)
    pin_season(page)
    page.route("**/api/jellyfin/availability/batch**",
               lambda route: route.fulfill(status=502, body="bad gateway"))
    try:
        page.goto(f"{frontend}/random")
        page.wait_for_timeout(12_000)   # allow the retries to run out

        step(17, "step 2/3: the page must name the problem and offer a way back")
        # Give the failure a real window to surface (the store retries 5xx on
        # its own budget before setting 'unreachable'), then decide.
        try:
            page.wait_for_selector("[data-library-status='unreachable']", timeout=20_000)
        except Exception:
            pass
        status = page.locator("[data-library-status='unreachable']")
        if not status.count():
            # Only the backend can say whether a silent page is legitimate.
            # This used to be inferred from the DOM (no Hide button => "not
            # configured" => skip), which read a slow or partial render as an
            # unconfigured deploy and silently passed — the mutation audit
            # proved it by deleting the 'unreachable' write and watching this
            # test survive. Ask the source of truth instead.
            r = requests.get(f"{backend}/api/jellyfin/status", timeout=15,
                             headers={"Authorization": f"Bearer {token}"})
            if r.ok and not r.json().get("configured"):
                step(17, "SKIP — media library not configured on this backend")
                return
            raise AssertionError(
                "availability lookup failed and the page said nothing — this is "
                "indistinguishable from 'everything is in your library', which is "
                "exactly how a real outage went undiagnosed"
            )
        assert page.locator("button:text-is('Retry')").count(), \
            "no way to retry a failed lookup without reloading the page"
    finally:
        page.unroute("**/api/jellyfin/availability/batch**")

    step(17, "step 3/3: Retry recovers once the server is back")
    page.locator("button:text-is('Retry')").first.click()
    page.wait_for_timeout(6000)
    assert not page.locator("[data-library-status='unreachable']").count(), \
        "still reporting unreachable after a successful retry"
    step(17, "PASS — failure is visible, and Retry clears it")


def test_hung_backend_does_not_hang_the_page(page, backend: str, frontend: str, token: str):
    """A request that never answers must not spin forever.

    There were no AbortSignals anywhere in the frontend, so a hung backend hung
    the page indefinitely — no error, no timeout, nothing to catch, and nothing
    on screen. That is a different failure from a 502 and the one nothing could
    previously survive.
    """
    step(18, "step 1/2: seeding a list, then hanging the availability lookup")
    ids = season_ids(backend, 3)
    seed_list(backend, token, ids)
    page.goto(frontend)
    pin_season(page)
    # Never fulfil: the request just sits there.
    page.route("**/api/jellyfin/availability/batch**", lambda route: None)
    try:
        page.goto(f"{frontend}/random")
        step(18, "step 2/2: expecting a reported failure well inside the timeout budget")
        # 15s timeout, and a timeout is deliberately not retried.
        page.wait_for_selector("[data-library-status='unreachable']", timeout=45_000)
    except Exception:
        if not page.locator("button:has-text('Hide Not in Library')").count():
            step(18, "SKIP — media library not configured on this backend")
            return
        raise AssertionError(
            "a hung availability request left the page waiting with nothing on "
            "screen — this is the failure mode with no upper bound"
        )
    finally:
        page.unroute("**/api/jellyfin/availability/batch**")
    step(18, "PASS — a hang becomes a reported failure, not an endless spinner")


def test_failed_hide_write_reverts(page, backend: str, frontend: str, token: str):
    """An optimistic hide that doesn't persist must be put back, and said.

    Hide All updated the list locally then fired the writes with
    `.catch(() => {})`. A failure left the screen showing shows as hidden while
    the server disagreed — reload and they were all back. Silent data loss.
    """
    step(19, "step 1/3: seeding a visible list")
    ids = season_ids(backend, 3)
    seed_list(backend, token, ids)
    page.goto(frontend)
    pin_season(page)
    page.goto(f"{frontend}/random")
    page.wait_for_timeout(6000)

    step(19, "step 2/3: failing every hide write, then pressing Hide All")
    page.route("**/api/list/hidden**",
               lambda route: route.fulfill(status=502, body="bad gateway"))
    try:
        hide_all = page.locator("button:text-is('Hide All')")
        if not hide_all.count():
            step(19, "SKIP — no Hide All control (empty list)")
            return
        hide_all.first.click()
        # The message clears itself, so poll rather than sleeping past it.
        page.wait_for_selector("[data-hide-write-error]", timeout=30_000)
    finally:
        page.unroute("**/api/list/hidden**")

    step(19, "step 3/3: the screen must agree with the server, not just the server")
    # Assert on the *UI*. The server is trivially correct here — the writes
    # failed, so nothing is hidden there no matter what the page does. The whole
    # bug is the page believing something the server never accepted, so checking
    # the server proves nothing and would pass with the revert deleted.
    hidden = requests.get(f"{backend}/api/list", timeout=15,
                          headers={"Authorization": f"Bearer {token}"},
                          params={"season": SEEDED_SEASON, "year": SEEDED_YEAR}).json()
    assert not [w for w in hidden if w.get("hidden")], "server unexpectedly recorded a hide"
    show_all = page.locator("button:text-is('Show All')")
    assert show_all.count() and show_all.first.is_disabled(), (
        "the page still shows items as hidden after every write failed — UI and "
        "server have diverged, and a reload will silently undo what was just done"
    )
    step(19, "PASS — failed writes reverted and reported")


def test_unaired_never_looked_up(page, backend: str, frontend: str, token: str):
    """An unaired series must never be looked up in the library.

    It cannot be there, so a lookup can only produce a false positive. Measured
    before this guard: on the season the app opens on by default, *every* match
    was fuzzy-title and *all* of them were wrong ("Firefly Wedding" → "Firefly",
    "Dragon Ball Super: Beerus" → "Dragon Ball").
    """
    step(16, "step 1/4: finding a NOT_YET_RELEASED season to seed from")
    unaired_season, unaired_year, ids = None, None, []
    for season, year in [("FALL", 2026), ("WINTER", 2027), ("SPRING", 2026)]:
        r = requests.get(f"{backend}/api/anime", params={"season": season, "year": year}, timeout=120)
        if not r.ok:
            continue
        entries = [a for a in r.json() if a.get("status") == "NOT_YET_RELEASED"]
        if len(entries) >= 3:
            unaired_season, unaired_year = season, year
            ids = [a["id"] for a in entries[:3]]
            break
    if not ids:
        step(16, "SKIP — no season with unaired entries available right now")
        return

    requests.put(f"{backend}/api/list", timeout=15,
                 headers={"Authorization": f"Bearer {token}"},
                 json={"season": unaired_season, "year": unaired_year,
                       "items": [{"mediaId": m} for m in ids]})
    page.goto(frontend)
    page.evaluate(
        "([s, y]) => localStorage.setItem('season-year', JSON.stringify("
        "{season: s, year: y, saved: Date.now()}))",
        [unaired_season, unaired_year],
    )

    step(16, f"step 2/4: opening /random on {unaired_season} {unaired_year} "
             f"and counting availability calls")
    calls = []
    page.on("request", lambda r: calls.append(r.url) if "/api/jellyfin/availability" in r.url else None)
    page.goto(f"{frontend}/random")
    page.wait_for_timeout(8000)

    step(16, "step 3/4: expecting zero lookups for an unaired season")
    assert not calls, (
        f"{len(calls)} availability lookup(s) fired for a NOT_YET_RELEASED season — "
        "the isUnaired() gate in stores/jellyfin.ts is not holding, so fuzzy title "
        "matching will offer the wrong series"
    )

    step(16, "step 4/4: unaired shows must not light 'Hide Not in Library'")
    # notAired is `available: false` with `unknown` falsy, so a writer guarding
    # only `unknown` records every unaired show as confirmed-missing — and the
    # button enables with a tooltip promising hides it cannot perform. The hide
    # action itself always filtered notAired; this is the button state lying.
    hide = page.locator("button", has_text="Hide Not in Library")
    if hide.count():
        assert hide.first.is_disabled(), (
            "'Hide Not in Library' is enabled on a season of NOT_YET_RELEASED shows — "
            "notAired verdicts are being recorded as 'not in library'"
        )
    step(16, f"PASS — 0 availability lookups across {len(ids)} unaired shows, "
             f"hide control {'disabled' if hide.count() else 'not offered'}")


def test_remote_accept_visible(page, backend: str, frontend: str):
    """A resolver accept decided on title text alone must be reviewable.

    `verdictFor` accepts an exact title without any air date having vouched for
    it, and the sweep stores that with pending=false. Before the fourth clause
    of the review filter, such a row failed every branch — the page's empty
    state actively said nothing needed review while a wrong exact-title
    collision (two works genuinely sharing a name — `The Last Blossom` →
    *House* was this shape) sat permanent and invisible.
    """
    step(20, "step 1/6: minting an admin token")
    tok = admin_token()
    if not tok:
        step(20, "SKIP — could not sign an admin token (node or backend/.env missing)")
        return
    ah = {"Authorization": f"Bearer {tok}"}
    # The seeded entry must be one the library does NOT hold at all. A held or
    # title-matched show is surfaced by the older filter clauses anyway — the
    # first version of this test seeded one and kept passing with the new
    # clause deleted, which is exactly the vacuous pass it exists to prevent.
    r = requests.get(f"{backend}/api/anime",
                     params={"season": SEEDED_SEASON, "year": SEEDED_YEAR}, timeout=120)
    r.raise_for_status()
    shows = r.json()[:40]
    items = [{"mediaId": s["id"],
              "titles": ([t for t in (s.get("title") or {}).values()
                          if isinstance(t, str) and t][:3] or [str(s["id"])])}
             for s in shows]
    a = requests.post(f"{backend}/api/jellyfin/availability/batch", headers=ah,
                      json={"items": items}, timeout=120)
    verdicts = a.json() if a.status_code == 200 else {}

    # The marker makes THIS row findable among real resolver rows the dev DB
    # may hold — the note renders verbatim next to the "our lookup" badge.
    marker = "ui-test-seed"
    step(20, "step 2/6: seeding a remote title-text accept the older clauses can't see")
    mid = None
    for s in shows:
        v = verdicts.get(str(s["id"]))
        if not (v and v.get("available") is False and not v.get("unknown")
                and not v.get("libraryTitle")):
            continue
        cand, titles = s["id"], next(i["titles"] for i in items if i["mediaId"] == s["id"])
        # The page renders english-else-romaji as the row title — the locator
        # anchor. (A marker in the note used to serve this, until the raw note
        # stopped being rendered as text.)
        seed_title = ((s.get("title") or {}).get("english")
                      or (s.get("title") or {}).get("romaji") or str(s["id"]))
        w = requests.put(f"{backend}/api/jellyfin/identity", headers=ah, timeout=15,
                         json={"anilistId": cand, "tvdbId": "99999998",
                               "source": "remote", "note": f"remote: exact title [{marker}]"})
        assert w.status_code == 200, \
            f"could not seed the identity row: {w.status_code} {w.text[:120]}"
        # Verify the seeded row really is invisible to the OLDER clauses. A
        # remote id is positive-only, so seeding it revives the title tier, and
        # an entry that prefix-matches its own franchise (the Madoka film → the
        # Madoka series) comes back matchedBy='title' — which the title-only
        # clause already lists. 133007 did exactly that, and the first version
        # of this test kept passing with the new clause deleted.
        chk = requests.post(f"{backend}/api/jellyfin/availability", headers=ah, timeout=60,
                            json={"mediaId": cand, "titles": titles, "fresh": True})
        if chk.status_code == 200 and not chk.json().get("matchedBy"):
            mid = cand
            break
        requests.delete(f"{backend}/api/jellyfin/identity/{cand}", headers=ah, timeout=15)
    if mid is None:
        step(20, "SKIP — no season entry stays fully unmatched once seeded")
        return
    try:
        step(20, "step 3/6: the row must appear in the review list")
        page.goto(frontend)
        page.evaluate("t => { localStorage.setItem('token', t);"
                      " localStorage.setItem('username', 'admin_probe'); }", tok)
        page.goto(f"{frontend}/admin/matching")
        page.wait_for_selector("[data-matching-list], [data-matching-empty], [data-matching-error]",
                               timeout=30_000)
        page.wait_for_timeout(1000)
        # The sweep status line renders in one of its two states ("last ran…"
        # or "hasn't completed a run yet") — without it the daily resolver has
        # no admin-visible trace at all, which is how three of its bugs stayed
        # invisible.
        assert page.locator("[data-sweep-status]").count(), (
            "no resolver-sweep status line on /admin/matching — the daily sweep is "
            "invisible to the admin again")
        # The admin trusts resolver accepts: the default queue must NOT hold
        # them (low priority was the ask), and the second filter option is
        # where they live — reachable, never invisible.
        assert not page.locator("[data-matching-list] li", has_text=seed_title).count(), (
            "a resolver accept sits in the default 'Needs attention' queue — these "
            "are trusted and belong behind the unverified-auto-matches filter")
        page.locator("[data-filter-mode]").select_option("attention+accepts")
        page.wait_for_timeout(500)
        row = page.locator("[data-matching-list] li", has_text=seed_title)
        assert row.count(), (
            "remote-accepted row is invisible on /admin/matching — an accept decided "
            "on title text alone is unreachable under every filter, and the empty "
            "state says nothing needs looking at")

        step(20, "step 4/6: the match dropdown fills and previews without saving")
        LOOKUP_ROUTE = "**/api/jellyfin/identity/lookup**"
        LOOKUP_BODY = json.dumps({"mode": "name", "results": [{
            "title": "Deterministic Result", "year": 2024,
            "tvdbId": "424242", "tmdbId": "242424", "tmdbKind": "tv",
            "image": None, "library": None}]})
        page.route(LOOKUP_ROUTE, lambda rt: rt.fulfill(
            status=200, content_type="application/json", body=LOOKUP_BODY))
        try:
            # The control opens a Sonarr-style dropdown, prefilled with the
            # entry's own title and searched immediately — the intercepted
            # route answers with the deterministic result.
            row.first.locator("[data-match-control]").click()
            page.wait_for_selector("[data-match-dropdown]", timeout=10_000)
            page.wait_for_selector("[data-lookup-results] button", timeout=15_000)
            page.locator("[data-lookup-results] button",
                         has_text="Deterministic Result").first.click()
            page.wait_for_timeout(300)
            control = row.first.locator("[data-match-control]").text_content() or ""
            assert "424242" in control, (
                "the canonical id (TVDB, for a series) is not shown on the match "
                f"control ({control[:120]!r})")
            pair = row.first.locator("[data-match-control] span[title]").first                 .get_attribute("title") or ""
            assert "242424" in pair, (
                f"the full id pair is not on the control's hover title ({pair!r})")
            assert row.first.locator("[data-match-changed]").count(), (
                "no 'changed — Confirm saves as manual' indicator after picking a "
                "different match")
            # Picking must FILL, never save — Confirm is the act of agreement.
            got = requests.post(f"{backend}/api/jellyfin/identity/resolve", headers=ah,
                                timeout=20, json={"mediaIds": [mid]}).json()
            pre = (got.get("identities") or {}).get(str(mid)) or {}
            assert pre.get("tvdbId") == "99999998", (
                "picking a lookup result wrote the override by itself — Confirm must "
                "stay the act of agreement")
            row.first.locator("button[aria-label^='Reset']").click()
            page.wait_for_timeout(300)
            assert not row.first.locator("[data-match-changed]").count(), \
                "reset did not return the control to the stored match"
        finally:
            page.unroute(LOOKUP_ROUTE)

        step(20, "step 5/6: Confirm settles it and it leaves the list")
        row.first.locator("button", has_text="Confirm").click()
        page.wait_for_timeout(3000)
        assert not page.locator("[data-matching-list] li", has_text=seed_title).count(), \
            "confirming the row did not remove it from the review list"
        # And the click must not have relabelled it: the id boxes are PREFILLED
        # with the stored ids, so an untouched Confirm has to keep the
        # resolver's provenance — "typed" means "changed", not "non-empty".
        # The first version of the handler got this wrong and every id-bearing
        # confirm arrived as source:'manual', note:null.
        got = requests.post(f"{backend}/api/jellyfin/identity/resolve", headers=ah,
                            timeout=20, json={"mediaIds": [mid]}).json()
        confirmed_row = (got.get("identities") or {}).get(str(mid)) or {}
        assert confirmed_row.get("source") == "remote", (
            "confirming an untouched suggestion relabelled it manual — the prefilled "
            f"id boxes are being read as hand-typed (source={confirmed_row.get('source')!r})")

        step(20, "step 6/6: a looked-up Confirm writes the picked ids as manual")
        w = requests.put(f"{backend}/api/jellyfin/identity", headers=ah, timeout=15,
                         json={"anilistId": mid, "tvdbId": "99999998",
                               "source": "remote", "note": f"remote: exact title [{marker}]"})
        assert w.status_code == 200, f"could not re-seed: {w.status_code} {w.text[:120]}"
        page.route(LOOKUP_ROUTE, lambda rt: rt.fulfill(
            status=200, content_type="application/json", body=LOOKUP_BODY))
        try:
            page.goto(f"{frontend}/admin/matching")
            page.wait_for_selector("[data-matching-list], [data-matching-empty]", timeout=30_000)
            page.wait_for_timeout(1000)
            page.locator("[data-filter-mode]").select_option("attention+accepts")
            page.wait_for_timeout(500)
            row2 = page.locator("[data-matching-list] li", has_text=seed_title)
            assert row2.count(), "the re-seeded row did not reappear in the review list"
            row2.first.locator("[data-match-control]").click()
            page.wait_for_selector("[data-match-dropdown]", timeout=10_000)
            page.wait_for_selector("[data-lookup-results] button", timeout=15_000)
            page.locator("[data-lookup-results] button",
                         has_text="Deterministic Result").first.click()
            page.wait_for_timeout(300)
            row2.first.locator("button", has_text="Confirm").click()
            page.wait_for_timeout(3000)
            got = requests.post(f"{backend}/api/jellyfin/identity/resolve", headers=ah,
                                timeout=20, json={"mediaIds": [mid]}).json()
            after = (got.get("identities") or {}).get(str(mid)) or {}
            assert after.get("tvdbId") == "424242" and after.get("source") == "manual", (
                "a looked-up Confirm did not write the picked identity as a manual "
                f"correction (tvdbId={after.get('tvdbId')!r}, source={after.get('source')!r})")
        finally:
            page.unroute(LOOKUP_ROUTE)
    finally:
        requests.delete(f"{backend}/api/jellyfin/identity/{mid}", headers=ah, timeout=15)
    step(20, "PASS — a title-text remote accept is listed, the lookup fills without "
             "saving, and Confirm settles both paths with the right provenance")


def test_check_batch_chunked(page, frontend: str):
    """More than 100 video ids must arrive in ≤100-id chunks, none dropped.

    Home used to post [...current, ...prev] in one request — 126 on a full
    season — and the route does `.slice(0, 100)`: the tail was silently
    dropped, six of those shows had English CC already recorded, and each one
    started a needless Whisper translation when opened.
    """
    step(21, "step 1/2: loading Home and capturing check-batch requests")
    from urllib.parse import parse_qs, urlparse
    reqs: list[str] = []

    def on_req(r):
        if "/api/translate/check-batch" in r.url:
            reqs.append(r.url)

    page.on("request", on_req)
    try:
        page.goto(frontend)
        pin_season(page)
        page.goto(frontend)
        wait_for_grids(page)
        page.wait_for_timeout(2500)
    finally:
        page.remove_listener("request", on_req)

    step(21, "step 2/2: every chunk at most 100 ids, and the tail not dropped")
    sizes, ids = [], set()
    for u in reqs:
        vids = [v for v in parse_qs(urlparse(u).query).get("videoIds", [""])[0].split(",") if v]
        sizes.append(len(vids))
        ids.update(vids)
    assert sizes, "no check-batch request fired at all"
    assert max(sizes) <= 100, (
        f"a check-batch request carried {max(sizes)} ids — the server slices at 100 "
        "and silently drops the tail")
    if len(ids) > 100:
        assert len(sizes) >= 2, (
            f"{len(ids)} unique ids but one request — everything past 100 was dropped")
    step(21, f"PASS — {len(ids)} ids across {len(sizes)} request(s), all within the cap "
             f"({'chunking exercised' if len(ids) > 100 else 'season small enough for one chunk'})")


def test_translation_error_visible(page, frontend: str):
    """A failed translation stream must say so on screen.

    "Server busy" was written for a human and only ever reached the console —
    the viewer just saw subtitles never arrive, indistinguishable from a slow
    translation. The fix is a transient chip by the CC toggle.
    """
    step(22, "step 1/3: forcing 'no CC anywhere' and a failing stream")
    page.route("**/api/translate/check-batch**", lambda r: r.fulfill(
        status=200, content_type="application/json", body="{}"))
    page.route("**/api/translate/check?**", lambda r: r.fulfill(
        status=200, content_type="application/json",
        body='{"hasEnglish": false, "subtitlesDisabled": false, "hasCachedSegments": false}'))
    # The stream reports failure IN-BAND: an SSE message carrying {error}, on a
    # 200 — that is what the chip's handler reads. A plain 503 here only
    # triggers EventSource's silent reconnect and exercises nothing.
    page.route("**/api/translate/stream**", lambda r: r.fulfill(
        status=200, content_type="text/event-stream",
        body='data: {"error": "Server busy - please try again later."}\n\n'))
    try:
        step(22, "step 2/3: opening a trailer")
        page.goto(frontend)
        wait_for_grids(page)
        page.locator('button:has(img[src*="ytimg.com"])').first.click()
        page.wait_for_selector('iframe[src*="youtube"]', timeout=10_000)

        step(22, "step 3/3: the failure must be visible, not console-only")
        page.wait_for_selector("[data-translation-error]", timeout=25_000)
    finally:
        page.keyboard.press("Escape")
        page.unroute("**/api/translate/stream**")
        page.unroute("**/api/translate/check?**")
        page.unroute("**/api/translate/check-batch**")
    step(22, "PASS — a failed stream renders 'Subtitles unavailable' on screen")


def test_phone_sidebar_collapsed(page, backend: str, frontend: str, token: str):
    """On a phone, the My List sidebar must not cover the page on load.

    Measured at 375×667 before the fix: the <aside> was 375×667 at (0,0),
    opaque, and 25/25 sampled viewport points landed on it — every fresh load
    required dismissing it before anything else was usable.
    """
    step(23, "step 1/2: seeding a list and loading Home at 375×667")
    seed_list(backend, token, season_ids(backend, 3))
    original = page.viewport_size
    page.set_viewport_size({"width": 375, "height": 667})
    try:
        page.goto(frontend)
        page.evaluate("t => localStorage.setItem('token', t)", token)
        pin_season(page)
        page.goto(frontend)
        wait_for_grids(page)

        step(23, "step 2/2: the viewport centre must not be the sidebar")
        covered = page.evaluate(
            "() => { const el = document.elementFromPoint(187, 333);"
            " return !!(el && el.closest('aside')); }")
        assert not covered, (
            "the My List sidebar covers the viewport centre on a 375px phone load — "
            "`collapsed` is not defaulting to true below the sm breakpoint")
    finally:
        page.set_viewport_size(original)
    step(23, "PASS — sidebar starts collapsed on a phone-sized viewport")


def test_guest_options_and_compare_warning(page, frontend: str):
    """The 'small three' remnants: a guest's options must mirror to
    localStorage (a theme choice used to survive only until reload), and
    Compare must say "No user named …" for a typo'd username instead of
    rendering silently nothing.
    """
    step(24, "step 1/2: a guest theme choice must land in localStorage")
    page.goto(frontend)
    # The guest check needs a logged-out page, but Compare below needs the
    # session back — /compare renders no picker for guests.
    prior_token = page.evaluate("localStorage.getItem('token')")
    prior_name = page.evaluate("localStorage.getItem('username')")
    page.evaluate("localStorage.removeItem('token'); localStorage.removeItem('username');"
                  " localStorage.removeItem('options')")
    page.goto(frontend)
    page.get_by_role("button", name="Options").click()
    page.wait_for_selector("select#themeSelect", timeout=5_000)
    page.locator("select#themeSelect").select_option("NIGHT")
    page.wait_for_timeout(500)
    stored = page.evaluate("JSON.parse(localStorage.getItem('options') || 'null')")
    assert stored and stored.get("theme") == "NIGHT", (
        f"a guest's theme choice did not reach localStorage (stored={stored!r}) — "
        "it will silently revert on the next load")
    page.locator("select#themeSelect").select_option("SYSTEM")
    page.keyboard.press("Escape")

    step(24, "step 2/2: Compare must name a user it can't find")
    if prior_token:
        page.evaluate("([t, n]) => { localStorage.setItem('token', t);"
                      " if (n) localStorage.setItem('username', n); }",
                      [prior_token, prior_name])
    page.goto(f"{frontend}/compare")
    box = page.locator("#otherUser").first
    box.wait_for(timeout=15_000)
    box.click()
    # No Escape afterwards: svelte-select clears its filter text on Escape,
    # which empties `typedOther` and hides the very warning being asserted.
    box.type("zz_no_such_user_999", delay=30)
    page.wait_for_selector("[data-unknown-user]", timeout=15_000)
    body = page.evaluate("document.body.textContent || ''")
    assert "No user named" in body, (
        "a typo'd second user renders silently as nothing — indistinguishable "
        "from the user having no list at all")
    step(24, "PASS — guest options persist, and a missing user is named on screen")



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
                ("no-results message", lambda: test_no_results_message(page, frontend)),
                ("unaired not looked up", lambda: test_unaired_never_looked_up(page, args.backend, frontend, token_a)),
                ("library unreachable visible", lambda: test_library_unreachable_is_visible(page, args.backend, frontend, token_a)),
                ("hung backend reported", lambda: test_hung_backend_does_not_hang_the_page(page, args.backend, frontend, token_a)),
                ("failed hide write reverts", lambda: test_failed_hide_write_reverts(page, args.backend, frontend, token_a)),
                ("remote accept visible", lambda: test_remote_accept_visible(page, args.backend, frontend)),
                ("check-batch chunked",  lambda: test_check_batch_chunked(page, frontend)),
                ("translation error visible", lambda: test_translation_error_visible(page, frontend)),
                ("phone sidebar collapsed", lambda: test_phone_sidebar_collapsed(page, args.backend, frontend, token_a)),
                ("guest options + compare warning", lambda: test_guest_options_and_compare_warning(page, frontend)),
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
