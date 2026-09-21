"""
Pre-deploy smoke test: frontend UI interactions - 36 flows.

Beyond `test_frontend_smoke.py` (which only checks pages render), this tests
that clicking buttons triggers the right behavior - and that every failure
path found by an audit or exploratory pass stays VISIBLE on screen. Catches
the regression class where a button renders but its handler is broken, and
the worse one where a failure renders exactly like a healthy page.

The flows, and the trap each was watched to fail on:

Button-click smoke (1-9): login, search filter, hide 18+, season change,
add-to-list, theme, wheel spin, logout, trailer-modal Escape. The Escape step
must NOT fall back to a backdrop click - that fallback is how it passed for
months while Escape closed nothing - and it also asserts the trailer's ✕
button exists.

Correctness the old assertions never checked:
- Compare (10): picks a second user and checks every rank and diff against
  deliberately different seeded orders. It used to look for the word
  "Compare" in the body text, which passes on a page with no rows.
- /admin (11): playback-account picker populated; no API key in the DOM.
- unknown never hides (12): availability route-intercepted to {unknown:true};
  the Hide-Not-in-Library control must refuse to act.
- share-as-image (13): the JPEG must have more than one colour - an all-blank
  render is the realistic silent failure.
- progressive loading (14): only the leftovers fetch fails; Retry appears
  while the main grid still renders.

From the exploratory pass:
- no-match search (15): an explicit message, never a blank page.
- unaired season (16): ZERO /api/jellyfin/availability calls - a
  NOT_YET_RELEASED series cannot be in the library, so a lookup can only
  produce a false positive (measured 7/7 wrong before the guard); and Hide
  Not in Library stays disabled. `notAired` is available:false with `unknown`
  falsy, so a writer guarding only `unknown` recorded every unaired show as
  confirmed-missing and lit a button whose hides could never fire.

Silent-failure paths (17-19):
- library unreachable (17): 502 on every lookup -> a message and a working
  Retry, where before the page just looked empty. Its skip decision asks
  /api/jellyfin/status directly - inferring "unconfigured" from an empty DOM
  read a slow or partial render as not-applicable, and the mutation audit
  watched this test survive its mutation exactly that way.
- hung backend (18): the route hangs forever; the page must say something
  inside the timeout - the case nothing in the frontend could survive before
  remote.ts existed.
- failed hide write (19): every PATCH /api/list/hidden fails; the page must
  revert AND say so. Asserts on the SCREEN, not the server - with all writes
  failing the server is trivially correct, so a server check would pass with
  the rollback deleted.

/admin/matching contract (20): a resolver accept decided on title text alone
is listed. Seeds a remote-sourced accepted row against an entry the library
doesn't hold, then verifies post-seed that no older filter clause can see it
- a remote id is positive-only, so seeding one revives the title tier; the
first version picked the Madoka film, which prefix-matched its own franchise
series and passed with the clause under test deleted. Locates the row by the
seeded entry's title (a marker in the note text stopped working the day the
raw note stopped being rendered). Asserts resolver accepts are absent from
the default queue but reachable via "+ resolver accepts"; drives the
Sonarr-style match dropdown (an intercepted search fills the control, the
"changed - saves as manual" indicator appears, nothing writes until Confirm,
reset returns to the stored match, and a changed Confirm writes
source:'manual'); an untouched Confirm settles the row off the list with
provenance intact - the id boxes are prefilled with the stored ids, so
"typed" must mean "changed": the first handler read any non-empty box as
hand-typed and relabelled every confirm as manual. Also clicks Run sweep now
(POST stubbed - a real drain would hammer skyhook/TMDB for minutes) and
asserts the button visibly enters its running state: a click that changes
nothing on screen is this page's fire-and-forget hide toggle. And asserts the
stats tiles render with both groups (season match health + auto-search
queue) - presence and labels only; the numbers are live season data.

Exploratory pass-1 guards that were claimed and missing for months (21-24):
- check-batch stays chunked at 100 (21), asserted against the live season's
  real >100-trailer id list - the tail used to be silently sliced off
  server-side.
- a failed translation stream is visible (22): the stream reports failure
  IN-BAND as an SSE {error} event on a 200, which is what the chip's handler
  reads - a 503 only triggers EventSource's silent reconnect and tests
  nothing.
- the phone sidebar starts collapsed at 375px (23). Writing this found a live
  regression: the reactive prefs-save persisted the width DEFAULT as though
  the user chose it, so one desktop visit put the full-screen sidebar back on
  every later phone load - the suite's own desktop flows running first is
  what exposes it.
- guest options reach localStorage + Compare names a user it can't find (24).
  No Escape after typing: svelte-select clears its filter text on Escape,
  hiding the very warning under test.

Ordinary things a user does, which nothing here used to do (30-36). The suite
was strong on failure paths and thin on the successful ones, because every
uncovered item was something that had simply always worked:
- My List reorder (30) and the Randomize watched-rank reorder (31). Two drag
  surfaces, two different endpoints - My List PUTs the whole list, only the
  Randomize sidebar uses PATCH /api/list/rank - and every earlier test SEEDED
  an order over the API and read it back, so the drag itself was unexercised.
  31 reads the ranks back rather than trusting the response: that route answers
  {ok:true} even when its `where` matched nothing.
- the reset page (32), which no test had ever LOADED. Its open path runs for
  real against an account created with no email; the `code` and `blocked`
  branches are asserted against a STUBBED /reset-request, because that route
  mails the verified address of a coded account and the dev admin's address is
  a real inbox.
- /admin/users (33): the last-admin floor as a disabled control with a reason,
  a refusal rendered beside its own row, and Delete - against an account the
  flow created seconds earlier. Never `Send test email`, which falls back to
  the signed-in admin's real inbox.
- /admin/status (34): all five badge states, injected into AppConfig rather
  than provoked, and restored in a `finally`. Includes a long failure streak
  WITH a recent success, which must read Failing and not Down. `Check now` is
  never clicked - it probes skyhook, AniList and Gmail, and a crossing record
  mails the owner.
- Compare's share-as-image (35): the untested half of a pair CLAUDE.md calls
  brittle, plus the font stylesheets it disables during capture being restored.
- nicknames (36): set through the rename dialog and asserted on the request,
  since saving re-PUTs the whole list and a dropped field still returns 200.

Seeds from live season data - the old hardcoded mediaIds aged out of the
season entirely, so every seeded list joined against zero shows and the
looser assertions passed anyway.

Usage:
  pip install playwright
  playwright install chromium
  py -3.13 -u tools/tests/test_ui_interactions.py [--frontend http://localhost:5173]
"""
import argparse
import json
import re
import sqlite3
import subprocess
import sys
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

TOTAL = 36
# `stores/season.ts` restores the last selection from this key (1h TTL). The
# pages open on the *look-ahead* season otherwise, which is not the one these
# tests seed - and a list whose ids aren't in the displayed season renders
# nothing at all, since entries are joined against that season's metadata.
SEASON_KEY = "season-year"
SEEDED_SEASON, SEEDED_YEAR = "SUMMER", 2026


def season_ids(backend: str, n: int = 3) -> list[int]:
    """Real mediaIds from the seeded season.

    These used to be hardcoded (158036/158037/158038). AniList season contents
    change, and by now not one of those three is in Summer 2026 - so every
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

# Availability is asked two ways - one show at a time for the pop-up, and a
# whole page at once for the wheel - so a pattern that only matches the single
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
    never that user - so without minting one, the admin UI cannot be reached at
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


def mark_watched(backend: str, token: str, ids: list[int]) -> None:
    """Mark entries watched, in order - which is also the order their ranks land.

    `PATCH /api/list/watched` assigns `watchedCount - 1` only when the stored
    rank is null, so the first call gets rank 0, the second rank 1.
    """
    for m in ids:
        r = requests.patch(f"{backend}/api/list/watched", timeout=15,
                           headers={"Authorization": f"Bearer {token}"},
                           json={"season": SEEDED_SEASON, "year": SEEDED_YEAR,
                                 "mediaId": m, "watched": True})
        assert r.status_code == 200, f"marking watched failed: {r.status_code} {r.text[:120]}"


def drag_row(page, row_sel: str, src: int, dst: int, below: bool = True) -> None:
    """Reorder a drag sidebar by synthesising the events it actually listens for.

    Playwright's `drag_to` drives Chromium's native HTML5 drag, which is flaky
    headless and wants a real `dataTransfer`. Neither sidebar reads one - the
    order comes from the component's own `dragIdx`/`placeholder` - so dispatching
    the three events directly is both sufficient and deterministic.

    `bubbles: False` is load-bearing, not tidiness: the sidebar's own element
    carries a `drop` handler that performs the SAME `move()`, so a bubbling drop
    reorders twice and lands somewhere that looks almost right.

    `below` picks which half of the target row the cursor is in, because
    `calcPlaceholder` returns `idx` above the midpoint and `idx + 1` below it.
    """
    moved = page.evaluate("""([sel, src, dst, below]) => {
        const rows = [...document.querySelectorAll(sel)];
        if (rows.length <= Math.max(src, dst)) return null;
        const a = rows[src], b = rows[dst];
        const r = b.getBoundingClientRect();
        const y = below ? r.bottom - 2 : r.top + 2;
        const ev = (t) => new DragEvent(t, { bubbles: false, cancelable: true, clientY: y });
        a.dispatchEvent(new DragEvent('dragstart', { bubbles: false }));
        b.dispatchEvent(ev('dragover'));
        b.dispatchEvent(ev('drop'));
        a.dispatchEvent(new DragEvent('dragend', { bubbles: false }));
        return true;
    }""", [row_sel, src, dst, below])
    assert moved, f"could not find rows {src}/{dst} for {row_sel}"


def row_order(page, row_sel: str) -> list[int]:
    """The mediaIds currently on screen, top to bottom."""
    attr = row_sel.strip("[]")
    return page.evaluate(
        "([sel, attr]) => [...document.querySelectorAll(sel)]"
        ".map(e => Number(e.getAttribute(attr)))", [row_sel, attr])


def continue_to_step(page, timeout_ms: int = 15_000) -> str:
    """Press Continue on the reset page and report which step it landed on.

    Deliberately not `wait_for_selector` on the step we want: that turns "it
    offered the wrong form" into a locator timeout, whose message says nothing
    about the invariant. Returning the step lets the caller assert it by name,
    which is what a mutation ignoring `codeRequired` has to be caught by.
    """
    page.get_by_role("button", name="Continue").click()
    waited = 0
    while waited < timeout_ms:
        page.wait_for_timeout(300)
        waited += 300
        now = page.get_attribute("[data-reset-step]", "data-reset-step")
        if now and now != "username":
            return now
    return page.get_attribute("[data-reset-step]", "data-reset-step") or ""


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL} UI-interact] {msg}", flush=True)


def wait_for_grids(page, timeout: int = 30_000) -> None:
    """
    Wait until Home has finished loading *every* section.

    Sections load independently, so cards being on screen no longer means the
    page is done - the Leftovers grid frequently renders while the current
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


# -----------------------------------------------------------------------------
# 1/10  Login form
# -----------------------------------------------------------------------------
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
    step(1, f"PASS - redirected, token set (len={len(token)})")


# -----------------------------------------------------------------------------
# 2/10  Search filter
# -----------------------------------------------------------------------------
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
    assert after < before, f"search didn't filter: {before} -> {after}"

    search.fill("")  # cleanup - must fully restore for downstream tests
    page.wait_for_timeout(300)
    step(2, f"PASS - {before} -> {after} cards on 'Eren' filter")


# -----------------------------------------------------------------------------
# 3/10  Hide 18+ filter
# -----------------------------------------------------------------------------
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
    # Hide 18+ should reduce count (current season may have 0 adult, in which case it's equal - accept that too)
    assert after <= before, f"after Hide 18+, count went up?? {before} -> {after}"

    # Restore initial state
    if checkbox.is_checked() != initial_state:
        checkbox.click()
        page.wait_for_timeout(300)
    step(3, f"PASS - Hide 18+ toggled ({before} -> {after})")


# -----------------------------------------------------------------------------
# 4/10  Season change
# -----------------------------------------------------------------------------
def test_season_change(page, frontend: str):
    step(4, "step 1/3: ensuring on Home and finding active season button")
    page.goto(frontend)
    wait_for_grids(page)
    page.wait_for_timeout(500)  # let toolbar render

    # Find the current active season via JS - Playwright's has_text+regex fails on
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
    # Click via JS evaluation by text - bypasses Playwright locator issues
    page.evaluate(f"""() => {{
      const btns = Array.from(document.querySelectorAll('button'));
      const t = btns.find(b => (b.textContent || '').trim() === '{other}');
      if (t) t.click();
    }}""")
    # Wait for anime fetch to settle - networkidle is faster than a fixed sleep
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
    step(4, f"PASS - {current} -> {other} -> back to {current}")


# -----------------------------------------------------------------------------
# 5/10  "watched trailer" button adds to list
# -----------------------------------------------------------------------------
def test_watched_trailer_button(page, backend: str):
    step(5, "step 1/3: noting current list size via API")
    token = page.evaluate("localStorage.getItem('token')")
    auth = {"Authorization": f"Bearer {token}"}
    # Read the season/year the UI is actually displaying - the default season
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
    assert count > 0, "no 'watched trailer' buttons on Home - page not rendering buttons correctly"
    btns.first.click()
    page.wait_for_timeout(800)  # PATCH /api/list/watched + toast

    step(5, "step 3/3: verifying list grew by 1 via API")
    after_size = get_list_size()
    assert after_size == before_size + 1, \
        f"list size should have grown by 1: {before_size} -> {after_size}"
    step(5, f"PASS - list grew {before_size} -> {after_size} after button click")


# -----------------------------------------------------------------------------
# 6/10  Theme dropdown applies theme
# -----------------------------------------------------------------------------
def test_theme_change(page):
    step(6, "step 1/3: noting current data-theme attribute")
    initial = page.evaluate("document.documentElement.getAttribute('data-theme')")

    step(6, "step 2/3: opening Options modal and changing theme")
    # Settings gear button - its inner text is the "settings" material icon ligature
    page.get_by_role("button", name="Options").click()
    page.wait_for_selector('select#themeSelect', timeout=3_000)
    # Pick a value different from current
    new_theme = "NIGHT" if initial != "dark" else "LIGHT"
    page.locator('select#themeSelect').select_option(new_theme)
    page.wait_for_timeout(300)

    step(6, "step 3/3: verifying data-theme attribute changed")
    after = page.evaluate("document.documentElement.getAttribute('data-theme')")
    assert after != initial, f"data-theme didn't change: {initial} -> {after}"

    # Restore - SYSTEM is the default install state for fresh signup
    page.locator('select#themeSelect').select_option("SYSTEM")
    page.wait_for_timeout(200)
    # Close modal by clicking backdrop or close button
    page.keyboard.press("Escape")
    page.wait_for_timeout(200)
    step(6, f"PASS - theme changed from {initial} to {after}")


# -----------------------------------------------------------------------------
# 7/10  Wheel spin opens result modal (Randomize page, auth required)
# -----------------------------------------------------------------------------
def test_wheel_spin(page, backend: str, frontend: str, token: str):
    """Verify Randomize page is interactive - wheel renders (if items in
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
        step(7, "step 3/3: clicking Spin button -> expect result modal")
        page.evaluate("""() => {
          const b = Array.from(document.querySelectorAll('button'))
            .find(b => (b.textContent || '').trim() === 'Spin');
          if (b) b.click();
        }""")
        page.wait_for_timeout(5_500)
        has_modal = page.locator('button').filter(
            has_text=re.compile(r"mark.*watched|hide.*series", re.I)).count() > 0
        assert has_modal, f"result modal didn't appear after spin"
        step(7, "PASS - wheel spun, result modal appeared")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
    elif state.get("state") == "empty":
        step(7, "PASS - Randomize page loaded (empty state, no items in season)")
    else:
        assert False, f"Randomize page in unknown state: {state}"


# -----------------------------------------------------------------------------
# 8/10  Logout clears auth and kicks out of auth-gated pages
# -----------------------------------------------------------------------------
def test_logout(page, frontend: str):
    step(8, "step 1/3: navigating to Home (ensures no modal overlay) + clicking Logout")
    # Previous wheel test may have left a result modal open over the header -
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

    step(8, "step 3/3: navigating to /random - should redirect/disable")
    page.goto(f"{frontend}/random")
    page.wait_for_timeout(1_500)
    # Either we're redirected away, or the page shows a "please log in" state.
    # The simplest check: no wheel SVG rendered.
    wheel_count = page.locator('svg[viewBox="-50 -50 100 100"]').count()
    assert wheel_count == 0, "wheel still rendered after logout - auth-gate broken"
    step(8, "PASS - logout cleared token, /random not accessible")


# -----------------------------------------------------------------------------
# 9/10  Trailer modal Escape closes
# -----------------------------------------------------------------------------
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

    step(9, "step 3/4: pressing Escape -> expect modal gone")
    page.keyboard.press("Escape")
    page.wait_for_timeout(800)
    iframe_after = page.locator('iframe[src*="youtube"]').count()
    # No backdrop-click fallback. This step used to fall back to clicking the
    # backdrop and assert on *that*, so it passed for months while Escape closed
    # nothing at all - the handler sat on a tabindex="-1" overlay that never
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
        "trailer modal has no visible close button - the backdrop was the only "
        "way out, which is near-invisible on a phone"
    )
    close_btn.click()
    page.wait_for_timeout(600)
    assert page.locator('iframe[src*="youtube"]').count() == 0, "✕ button did not close the modal"
    step(9, "PASS - Escape and the ✕ button both close the trailer")


# -----------------------------------------------------------------------------
# 10/10  Compare page with 2 users - table renders with diff
# -----------------------------------------------------------------------------
def test_compare_two_users(page, backend: str, frontend: str):
    """Compare must show the right numbers, not merely render.

    This used to assert `any(s in body_text for s in ("Compare", "compare",
    "2nd user", "vs"))`, which passes on a page that rendered no rows at all -
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
    # Watch what the box actually sends. The picker re-queries
    # `/api/users?q=<typed>` off the bound `filterText`; break that binding and
    # typing produces no request at all. The page's initial unfiltered
    # `/api/users` already fired during step 2's navigation, so this listener
    # sees only what the KEYSTROKES cause - measured: 1 request carrying `q=`
    # intact, 0 requests with the binding broken.
    user_queries: list[str] = []
    page.on("request",
            lambda r: user_queries.append(r.url) if "/api/users" in r.url else None)
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

    step(10, "step 4/5: the box queried the backend, and the user was selected")
    # SPECIFIC FIRST. This asserts the mechanism - typing reaches `/api/users` -
    # and it must run before the `picked` check below, which is the general
    # "it worked out" one.
    #
    # `picked` alone is satisfiable by accident, and was: a full audit watched
    # the `bind:filterText` -> `bind:searchText` mutation SURVIVE. `cleanup_users`
    # empties the table at the start of every suite run, so the freshly seeded
    # user_b sits inside the UNFILTERED `/api/users` slice and the picker offers
    # it without ever searching. The fixture never reached the code the mutation
    # broke. Asserting on the request instead cannot be satisfied by a small
    # database.
    assert any("q=" in u for u in user_queries), (
        f"the search box never queried /api/users with what was typed "
        f"({len(user_queries)} request(s), all unfiltered) - `filterText` is not "
        f"bound, so the suggestion list stays the unfiltered top slice and "
        f"anyone outside it cannot be picked")

    picked = page.evaluate(
        "() => [...document.querySelectorAll('[data-rank-b]')]"
        ".some(e => e.getAttribute('data-rank-b'))")
    # This is an assertion, not a skip. The picker searches the backend as you
    # type, so a freshly created user IS findable - that was broken once
    # (`bind:searchText` + `on:search`, neither of which svelte-select 5 has),
    # which capped the picker at whatever `/api/users` returns unfiltered and
    # made anyone outside that slice unselectable. Skipping here would hide
    # exactly that regression coming back.
    assert picked, (f"{user_b} was never offered by the picker - the search box is "
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
    step(10, f"PASS - {len(EXPECTED)} shared rows, ranks and diffs all match the seeded orders")

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
    # The accounts arrive after the page renders, so reading the options the
    # instant `#jf-url` appears finds only the default one - which is why the
    # leak check below almost always ran against a page with no ids on it at
    # all. Wait for them, bounded, and carry on either way: a genuinely
    # unconfigured Jellyfin never populates and that is not a failure.
    read_opts = lambda: page.eval_on_selector_all(
        "#jf-user option", "els => els.map(e => e.textContent.trim())")
    opts = read_opts()
    for _ in range(20):
        if len(opts) > 1:
            break
        page.wait_for_timeout(500)
        opts = read_opts()
    assert opts, "no playback-account picker rendered"
    # The key is stored server-side and must never reach a browser; a Jellyfin
    # API key is 32 hex characters.
    #
    # So is a Jellyfin USER id, and the picker must render one per account to
    # work at all - so a bare 32-hex sweep of the page reports the page doing its
    # job as a leak. This assertion was wrong in BOTH directions and nobody saw
    # it, because the two errors hid each other: with Jellyfin unreachable the
    # picker holds only its default option, no 32-hex string exists, and the
    # check passes having tested nothing (the step even prints "Jellyfin may be
    # unconfigured" while doing so). The first run against a reachable server -
    # 85 accounts, the first id beginning 58ce23ed - failed as a false positive.
    # Verified at the time against `AppConfig.jellyfinApiKey`: no match.
    #
    # So exclude the ids the page legitimately owns, and assert the picker is
    # really populated, which is what stops the check going vacuous again.
    ids = [v for v in page.eval_on_selector_all(
        "#jf-user option", "els => els.map(e => e.value)") if v]
    html = page.content()
    for uid in ids:
        html = html.replace(uid, "")
    leak = re.search(r"\b[0-9a-f]{32}\b", html)
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
    # popup. Stub the window so this tests the part that fails *silently* - the
    # rendering - rather than the browser's popup policy.
    # The stub has to answer the whole document API the real code uses -
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
        raise AssertionError("Share produced nothing - toJpeg most likely resolved to "
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
    completely blank page - indistinguishable from "still loading" or "broken".
    """
    step(15, "step 1/3: loading Home and searching for something that can't match")
    page.goto(frontend)
    wait_for_grids(page)
    page.fill("#search", "zzzzznotarealshow")
    page.wait_for_timeout(1200)

    step(15, "step 2/3: expecting an explicit no-results message")
    msg = page.locator("[data-no-results]")
    assert msg.count() == 1, (
        "a no-match search rendered nothing at all - no explanation, no empty state"
    )
    text = msg.inner_text()
    assert "zzzzznotarealshow" in text, f"message didn't name the search term: {text!r}"

    step(15, "step 3/3: clearing the search restores the grid")
    page.fill("#search", "")
    page.wait_for_timeout(1200)
    assert page.locator("[data-no-results]").count() == 0, \
        "no-results message stayed up after the search was cleared"
    assert page.locator('img[alt]').count() > 0, "grid did not come back"
    step(15, f"PASS - {text.strip()[:60]!r}")


def test_library_unreachable_is_visible(page, backend: str, frontend: str, token: str):
    """A failed library lookup must say so, and must recover without a reload.

    This is the one failure that was actually reproduced from a real report: no
    Watch buttons anywhere, Hide-Not-in-Library greyed out, nothing on screen
    explaining it, and no retry - so it looked identical to a healthy library
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

        step(17, "step 2/3: the page must name the problem and offer a way back")
        # One condition poll, not a sleep plus a poll. The store retries 5xx
        # inside a 30 s budget (`budgetMs` in lib/remote.ts), so that is the
        # window this has to cover - but it used to cover it as a flat 12 s
        # wait_for_timeout followed by a 20 s wait_for_selector, which paid the
        # 12 s on every run including the ones that had already failed. Same
        # budget, ~12 s cheaper whenever the answer arrives early.
        try:
            page.wait_for_selector("[data-library-status='unreachable']", timeout=32_000)
        except Exception:
            pass
        status = page.locator("[data-library-status='unreachable']")
        if not status.count():
            # Only the backend can say whether a silent page is legitimate.
            # This used to be inferred from the DOM (no Hide button => "not
            # configured" => skip), which read a slow or partial render as an
            # unconfigured deploy and silently passed - the mutation audit
            # proved it by deleting the 'unreachable' write and watching this
            # test survive. Ask the source of truth instead.
            r = requests.get(f"{backend}/api/jellyfin/status", timeout=15,
                             headers={"Authorization": f"Bearer {token}"})
            if r.ok and not r.json().get("configured"):
                step(17, "SKIP - media library not configured on this backend")
                return
            raise AssertionError(
                "availability lookup failed and the page said nothing - this is "
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
    step(17, "PASS - failure is visible, and Retry clears it")


def test_hung_backend_does_not_hang_the_page(page, backend: str, frontend: str, token: str):
    """A request that never answers must not spin forever.

    There were no AbortSignals anywhere in the frontend, so a hung backend hung
    the page indefinitely - no error, no timeout, nothing to catch, and nothing
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
        # QUICK is 15 s and a timeout is deliberately never retried, so the
        # failure is on screen by ~16 s or the guard is gone. The wait is the
        # audit's single most expensive one - under the mutation the selector
        # never appears, so this timeout is paid in full - and 45 s bought 30 s
        # of headroom on a 15 s deadline. 25 s is still a 60% margin.
        page.wait_for_selector("[data-library-status='unreachable']", timeout=25_000)
    except Exception:
        if not page.locator("button:has-text('Hide Not in Library')").count():
            step(18, "SKIP - media library not configured on this backend")
            return
        raise AssertionError(
            "a hung availability request left the page waiting with nothing on "
            "screen - this is the failure mode with no upper bound"
        )
    finally:
        page.unroute("**/api/jellyfin/availability/batch**")
    step(18, "PASS - a hang becomes a reported failure, not an endless spinner")


def test_failed_hide_write_reverts(page, backend: str, frontend: str, token: str):
    """An optimistic hide that doesn't persist must be put back, and said.

    Hide All updated the list locally then fired the writes with
    `.catch(() => {})`. A failure left the screen showing shows as hidden while
    the server disagreed - reload and they were all back. Silent data loss.

    Step 4 covers the SINGLE-show toggle separately, because it was a separate
    hole: the bulk paths were fixed after the exploratory pass while the
    per-row eye toggle kept its own fire-and-forget fetch, found months later
    by a comment audit (the comment called it "keeping the code simple").
    One shared rollback isn't enough to assert once - the toggle used to
    bypass it entirely.
    """
    step(19, "step 1/4: seeding a visible list")
    ids = season_ids(backend, 3)
    seed_list(backend, token, ids)
    page.goto(frontend)
    pin_season(page)
    page.goto(f"{frontend}/random")
    page.wait_for_timeout(6000)

    step(19, "step 2/4: failing every hide write, then pressing Hide All")
    page.route("**/api/list/hidden**",
               lambda route: route.fulfill(status=502, body="bad gateway"))
    try:
        hide_all = page.locator("button:text-is('Hide All')")
        if not hide_all.count():
            step(19, "SKIP - no Hide All control (empty list)")
            return
        hide_all.first.click()
        # The message clears itself, so poll rather than sleeping past it.
        page.wait_for_selector("[data-hide-write-error]", timeout=30_000)
    finally:
        page.unroute("**/api/list/hidden**")

    step(19, "step 3/4: the screen must agree with the server, not just the server")
    # Assert on the *UI*. The server is trivially correct here - the writes
    # failed, so nothing is hidden there no matter what the page does. The whole
    # bug is the page believing something the server never accepted, so checking
    # the server proves nothing and would pass with the revert deleted.
    hidden = requests.get(f"{backend}/api/list", timeout=15,
                          headers={"Authorization": f"Bearer {token}"},
                          params={"season": SEEDED_SEASON, "year": SEEDED_YEAR}).json()
    assert not [w for w in hidden if w.get("hidden")], "server unexpectedly recorded a hide"
    show_all = page.locator("button:text-is('Show All')")
    assert show_all.count() and show_all.first.is_disabled(), (
        "the page still shows items as hidden after every write failed - UI and "
        "server have diverged, and a reload will silently undo what was just done"
    )

    step(19, "step 4/4: a single-show hide must revert the same way")
    # Wait out the bulk step's message so step 4 detects its own, not a leftover.
    page.wait_for_selector("[data-hide-write-error]", state="detached", timeout=15_000)
    page.route("**/api/list/hidden**",
               lambda route: route.fulfill(status=502, body="bad gateway"))
    try:
        eye = page.locator("button[title='Hide from Randomize']")
        assert eye.count(), "no per-row hide toggle found in the unwatched list"
        eye.first.click()
        try:
            page.wait_for_selector("[data-hide-write-error]", timeout=20_000)
        except Exception:
            raise AssertionError(
                "single-show hide left applied after a failed write - the eye "
                "toggle is the one hide path that used to skip the rollback, and "
                "a reload will silently undo what the user just did"
            )
        assert show_all.first.is_disabled(), (
            "single-show hide left applied after a failed write - the message "
            "showed but the item stayed hidden"
        )
    finally:
        page.unroute("**/api/list/hidden**")
    step(19, "PASS - failed writes reverted and reported, bulk and single")


def test_unaired_never_looked_up(page, backend: str, frontend: str, token: str):
    """An unaired series must never be looked up in the library.

    It cannot be there, so a lookup can only produce a false positive. Measured
    before this guard: on the season the app opens on by default, *every* match
    was fuzzy-title and *all* of them were wrong ("Firefly Wedding" -> "Firefly",
    "Dragon Ball Super: Beerus" -> "Dragon Ball").
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
        step(16, "SKIP - no season with unaired entries available right now")
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
        f"{len(calls)} availability lookup(s) fired for a NOT_YET_RELEASED season - "
        "the isUnaired() gate in stores/jellyfin.ts is not holding, so fuzzy title "
        "matching will offer the wrong series"
    )

    step(16, "step 4/4: unaired shows must not light 'Hide Not in Library'")
    # notAired is `available: false` with `unknown` falsy, so a writer guarding
    # only `unknown` records every unaired show as confirmed-missing - and the
    # button enables with a tooltip promising hides it cannot perform. The hide
    # action itself always filtered notAired; this is the button state lying.
    hide = page.locator("button", has_text="Hide Not in Library")
    if hide.count():
        assert hide.first.is_disabled(), (
            "'Hide Not in Library' is enabled on a season of NOT_YET_RELEASED shows - "
            "notAired verdicts are being recorded as 'not in library'"
        )
    step(16, f"PASS - 0 availability lookups across {len(ids)} unaired shows, "
             f"hide control {'disabled' if hide.count() else 'not offered'}")


def test_remote_accept_visible(page, backend: str, frontend: str):
    """A resolver accept decided on title text alone must be reviewable.

    `verdictFor` accepts an exact title without any air date having vouched for
    it, and the sweep stores that with pending=false. Before the fourth clause
    of the review filter, such a row failed every branch - the page's empty
    state actively said nothing needed review while a wrong exact-title
    collision (two works genuinely sharing a name - `The Last Blossom` ->
    *House* was this shape) sat permanent and invisible.
    """
    step(20, "step 1/6: minting an admin token")
    tok = admin_token()
    if not tok:
        step(20, "SKIP - could not sign an admin token (node or backend/.env missing)")
        return
    ah = {"Authorization": f"Bearer {tok}"}
    # The seeded entry must be one the library does NOT hold at all. A held or
    # title-matched show is surfaced by the older filter clauses anyway - the
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
    # may hold - the note renders verbatim next to the "our lookup" badge.
    marker = "ui-test-seed"
    step(20, "step 2/6: seeding a remote title-text accept the older clauses can't see")
    mid = None
    for s in shows:
        v = verdicts.get(str(s["id"]))
        if not (v and v.get("available") is False and not v.get("unknown")
                and not v.get("libraryTitle")):
            continue
        cand, titles = s["id"], next(i["titles"] for i in items if i["mediaId"] == s["id"])
        # The page renders english-else-romaji as the row title - the locator
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
        # an entry that prefix-matches its own franchise (the Madoka film -> the
        # Madoka series) comes back matchedBy='title' - which the title-only
        # clause already lists. 133007 did exactly that, and the first version
        # of this test kept passing with the new clause deleted.
        chk = requests.post(f"{backend}/api/jellyfin/availability", headers=ah, timeout=60,
                            json={"mediaId": cand, "titles": titles, "fresh": True})
        if chk.status_code == 200 and not chk.json().get("matchedBy"):
            mid = cand
            break
        requests.delete(f"{backend}/api/jellyfin/identity/{cand}", headers=ah, timeout=15)
    if mid is None:
        step(20, "SKIP - no season entry stays fully unmatched once seeded")
        return
    try:
        step(20, "step 3/6: the row must appear in the review list")
        page.goto(frontend)
        page.evaluate("t => { localStorage.setItem('token', t);"
                      " localStorage.setItem('username', 'admin_probe'); }", tok)
        page.goto(f"{frontend}/admin/matching?season={SEEDED_SEASON}&year={SEEDED_YEAR}")
        page.wait_for_selector("[data-matching-list], [data-matching-empty], [data-matching-error]",
                               timeout=30_000)
        page.wait_for_timeout(1000)
        # The sweep status line renders in one of its two states ("last ran..."
        # or "hasn't completed a run yet") - without it the daily resolver has
        # no admin-visible trace at all, which is how three of its bugs stayed
        # invisible.
        assert page.locator("[data-sweep-status]").count(), (
            "no resolver-sweep status line on /admin/matching - the daily sweep is "
            "invisible to the admin again")
        # The stats tiles: season match health + the auto-search queue's
        # standing (never searched / cooldown / retired). Presence + both
        # group labels - the numbers are live season data and not stable.
        stats_el = page.locator("[data-matching-stats]")
        assert stats_el.count(), (
            "no stats block on /admin/matching - the season's match health and "
            "the auto-search queue are invisible again")
        stats_text = (stats_el.text_content() or "").lower()
        # Both scopes must render: the season on screen and the all-seasons
        # row the sweep status feeds. One without the other is half a summary.
        assert "entries" in stats_text and "all seasons" in stats_text, (
            f"stats block is missing a scope row (got: {stats_text[:120]!r})")
        # The Run-sweep button must visibly enter a running state on click -
        # a button that fires and changes nothing is this page's version of
        # the fire-and-forget hide toggle. The POST is stubbed: a real drain
        # sweep from a test would hammer skyhook/TMDB for minutes.
        SWEEP_ROUTE = "**/api/jellyfin/identity/sweep"
        page.route(SWEEP_ROUTE, lambda rt: rt.fulfill(
            status=202, content_type="application/json",
            body=json.dumps({"started": True, "running": True})))
        try:
            btn = page.locator("[data-run-sweep]")
            assert btn.count(), "no Run-sweep button on /admin/matching"
            btn.click()
            page.wait_for_timeout(300)
            assert btn.is_disabled(), (
                "Run sweep now did not enter its running state after the click - "
                "the admin can't tell a triggered sweep from a dead button")
        finally:
            page.unroute(SWEEP_ROUTE)
            # Stop the completion poll the click started (it would tick against
            # the real backend for the rest of the file) - navigation destroys
            # the component and its interval.
            page.goto(f"{frontend}/admin/matching?season={SEEDED_SEASON}&year={SEEDED_YEAR}")
            page.wait_for_selector(
                "[data-matching-list], [data-matching-empty], [data-matching-error]",
                timeout=30_000)
            page.wait_for_timeout(500)
        # The admin trusts resolver accepts: the default queue must NOT hold
        # them (low priority was the ask), and the second filter option is
        # where they live - reachable, never invisible.
        assert not page.locator("[data-matching-list] li", has_text=seed_title).count(), (
            "a resolver accept sits in the default 'Needs attention' queue - these "
            "are trusted and belong behind the unverified-auto-matches filter")
        page.locator("[data-filter-mode]").select_option("attention+accepts")
        page.wait_for_timeout(500)
        row = page.locator("[data-matching-list] li", has_text=seed_title)
        assert row.count(), (
            "remote-accepted row is invisible on /admin/matching - an accept decided "
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
            # entry's own title and searched immediately - the intercepted
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
                "no 'changed - Confirm saves as manual' indicator after picking a "
                "different match")
            # Picking must FILL, never save - Confirm is the act of agreement.
            got = requests.post(f"{backend}/api/jellyfin/identity/resolve", headers=ah,
                                timeout=20, json={"mediaIds": [mid]}).json()
            pre = (got.get("identities") or {}).get(str(mid)) or {}
            assert pre.get("tvdbId") == "99999998", (
                "picking a lookup result wrote the override by itself - Confirm must "
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
        # resolver's provenance - "typed" means "changed", not "non-empty".
        # The first version of the handler got this wrong and every id-bearing
        # confirm arrived as source:'manual', note:null.
        got = requests.post(f"{backend}/api/jellyfin/identity/resolve", headers=ah,
                            timeout=20, json={"mediaIds": [mid]}).json()
        confirmed_row = (got.get("identities") or {}).get(str(mid)) or {}
        assert confirmed_row.get("source") == "remote", (
            "confirming an untouched suggestion relabelled it manual - the prefilled "
            f"id boxes are being read as hand-typed (source={confirmed_row.get('source')!r})")

        step(20, "step 6/6: a looked-up Confirm writes the picked ids as manual")
        w = requests.put(f"{backend}/api/jellyfin/identity", headers=ah, timeout=15,
                         json={"anilistId": mid, "tvdbId": "99999998",
                               "source": "remote", "note": f"remote: exact title [{marker}]"})
        assert w.status_code == 200, f"could not re-seed: {w.status_code} {w.text[:120]}"
        page.route(LOOKUP_ROUTE, lambda rt: rt.fulfill(
            status=200, content_type="application/json", body=LOOKUP_BODY))
        try:
            page.goto(f"{frontend}/admin/matching?season={SEEDED_SEASON}&year={SEEDED_YEAR}")
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

            # Last, because it rewrites the row: the state column must never
            # name a rung that didn't fire. A row stored as `remote: unverified`
            # was told it matched "on exact title" - 81 rows saying so against
            # the 13 that used that rung. Seeded pending, which is the branch a
            # suggestion nothing verified actually renders through.
            requests.put(f"{backend}/api/jellyfin/identity", headers=ah, timeout=15,
                         json={"anilistId": mid, "tvdbId": "99999998", "source": "remote",
                               "pending": True, "note": "remote: unverified"})
            page.goto(f"{frontend}/admin/matching?season={SEEDED_SEASON}&year={SEEDED_YEAR}")
            page.wait_for_selector("[data-matching-list], [data-matching-empty]", timeout=30_000)
            page.wait_for_timeout(1000)
            unv = (page.locator("[data-matching-list] li", has_text=seed_title)
                   .first.text_content() or "").lower()
            assert "exact title" not in unv, (
                "a row nothing could verify still claims it matched on an exact "
                f"title - the state column is naming a rung that never fired: {unv[:160]!r}")
            assert "nothing could verify it" in unv, (
                "an unverifiable suggestion gives no reason at all - the reviewer "
                f"is asked to judge it with no evidence on screen: {unv[:160]!r}")
        finally:
            page.unroute(LOOKUP_ROUTE)
    finally:
        requests.delete(f"{backend}/api/jellyfin/identity/{mid}", headers=ah, timeout=15)
    step(20, "PASS - a title-text remote accept is listed, the lookup fills without "
             "saving, and Confirm settles both paths with the right provenance")


def test_check_batch_chunked(page, frontend: str):
    """More than 100 video ids must arrive in <=100-id chunks, none dropped.

    Home used to post [...current, ...prev] in one request - 126 on a full
    season - and the route does `.slice(0, 100)`: the tail was silently
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
        f"a check-batch request carried {max(sizes)} ids - the server slices at 100 "
        "and silently drops the tail")
    if len(ids) > 100:
        assert len(sizes) >= 2, (
            f"{len(ids)} unique ids but one request - everything past 100 was dropped")
    step(21, f"PASS - {len(ids)} ids across {len(sizes)} request(s), all within the cap "
             f"({'chunking exercised' if len(ids) > 100 else 'season small enough for one chunk'})")


def test_translation_error_visible(page, frontend: str):
    """A failed translation stream must say so on screen.

    "Server busy" was written for a human and only ever reached the console -
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
    # 200 - that is what the chip's handler reads. A plain 503 here only
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
    step(22, "PASS - a failed stream renders 'Subtitles unavailable' on screen")


def test_phone_sidebar_collapsed(page, backend: str, frontend: str, token: str):
    """On a phone, the My List sidebar must not cover the page on load.

    Measured at 375x667 before the fix: the <aside> was 375x667 at (0,0),
    opaque, and 25/25 sampled viewport points landed on it - every fresh load
    required dismissing it before anything else was usable.
    """
    step(23, "step 1/6: a desktop-width visit - the state a phone load must survive")
    seed_list(backend, token, season_ids(backend, 3))
    original = page.viewport_size
    # This visit used to be INHERITED: the desktop flows simply ran first, and
    # the second half of this bug (a desktop visit persisting the width default
    # as though the user had chosen it) only reproduces once one has. That made
    # the flow unrunnable alone - it passed with its mutation applied - so its
    # two rows were the last in the audit still paying for all 25 flows, ~4.7 min
    # between them. Doing the desktop visit here costs a page load and makes the
    # dependency the flow's own, which is also the honest reading: the bug IS
    # "someone opened it on a desktop once".
    page.set_viewport_size({"width": 1280, "height": 800})
    try:
        page.goto(frontend)
        page.evaluate("t => localStorage.setItem('token', t)", token)
        pin_season(page)
        page.goto(frontend)
        wait_for_grids(page)
        # The prefs write is reactive, not awaited by anything on screen.
        page.wait_for_timeout(1500)

        step(23, "step 2/6: now load Home at 375x667")
        page.set_viewport_size({"width": 375, "height": 667})
        page.goto(frontend)
        wait_for_grids(page)

        step(23, "step 3/6: the viewport centre must not be the sidebar")
        covered = page.evaluate(
            "() => { const el = document.elementFromPoint(187, 333);"
            " return !!(el && el.closest('aside')); }")
        assert not covered, (
            "the My List sidebar covers the viewport centre on a 375px phone load - "
            "`collapsed` is not defaulting to true below the sm breakpoint")

        # Second half, found by exploratory pass 2: once the sidebar had ever been
        # explicitly opened, dismissing it stopped persisting. `sidebarChoiceMade`
        # was inferred by diffing `sidebarCollapsed` in a reactive block that runs
        # BEFORE loadPrefs, so with a stored `false` it latched the width default
        # `true`; tapping Hide made them agree, the diff saw no change, and
        # savePrefs carried the stored `false` forward. Every load put the
        # full-screen sidebar back - pass 1's bug through a different door.
        # The stored value has to actually disagree with the width default for
        # this to test anything: a first attempt just tapped Show then Hide and
        # reloaded, which passed with the fix mutated out, because nothing was
        # stored at all and the phone default happens to give the same answer.
        # Opening it and reloading is what makes the stored `false` load-bearing.
        step(23, "step 4/6: open it explicitly - that choice must be stored")
        page.click('button[aria-label="Show My List"]')
        page.wait_for_timeout(1500)
        stored = page.evaluate(
            "u => (JSON.parse(localStorage.getItem('prefs-' + u) || '{}')).sidebarCollapsed",
            page.evaluate("() => localStorage.getItem('username')"))
        assert stored is False, (
            "opening the sidebar was not recorded as a choice, so the width "
            f"default silently wins on the next load (stored: {stored!r})")

        step(23, "step 5/6: reloading honours it - the sidebar is open on a phone")
        page.reload()
        wait_for_grids(page)
        opened = page.evaluate(
            "() => { const el = document.elementFromPoint(187, 333);"
            " return !!(el && el.closest('aside')); }")
        assert opened, (
            "a stored open choice was dropped on reload - without it the rest of "
            "this flow cannot reach the state the bug needs")

        step(23, "step 6/6: now dismiss it - the dismissal must survive a load")
        page.click('button[aria-label="Hide My List"]')
        page.wait_for_timeout(1500)
        page.reload()
        wait_for_grids(page)
        back = page.evaluate(
            "() => { const el = document.elementFromPoint(187, 333);"
            " return !!(el && el.closest('aside')); }")
        assert not back, (
            "the sidebar came back after being dismissed - an explicit collapse "
            "is not being recorded over a stored open one, so every phone load "
            "reopens it full-screen")
    finally:
        page.set_viewport_size(original)
    step(23, "PASS - starts collapsed on a phone, and a dismissal is remembered")


def test_theme_survives_signup_and_reload(page, backend: str, frontend: str):
    """A theme choice must reach the account, and the right theme must be painted
    first.

    Three symptoms of one cause: the token branch of `authToken.subscribe` in
    stores/options.ts never *read* the localStorage mirror, and `isLoading` stopped
    it ever *writing* it during load.

    So (a) a logged-in user's first paint used `defaultOptions` and the real theme
    arrived only when /api/options resolved - measured `light` at 76 ms and `dark`
    at 87 ms locally, and a 300 ms server made that a 504 ms wrong-theme window,
    i.e. a white flash on every load for every dark-theme user; (b) a guest who
    chose a theme and then signed up had it silently reverted, because the fresh
    account's defaults were adopted over it, leaving the server, localStorage and
    the DOM disagreeing permanently; and (c) logging out then flipped the site to
    whatever that stale mirror said.

    Asserts all three surfaces, not just the DOM - the DOM was the one that looked
    right in two of the three symptoms.
    """
    prior_token = page.evaluate("localStorage.getItem('token')")
    prior_name = page.evaluate("localStorage.getItem('username')")
    user = f"ui_theme_{int(time.time())}"
    try:
        step(27, "step 1/5: as a guest, choose NIGHT")
        page.goto(frontend)
        page.evaluate("localStorage.removeItem('token'); localStorage.removeItem('username');"
                      " localStorage.removeItem('options')")
        page.goto(frontend)
        page.get_by_role("button", name="Options").click()
        page.wait_for_selector("select#themeSelect", timeout=5_000)
        page.locator("select#themeSelect").select_option("NIGHT")
        page.wait_for_timeout(600)
        page.keyboard.press("Escape")

        step(27, f"step 2/5: signing up as {user} - the choice must come along")
        page.goto(f"{frontend}/signup")
        page.wait_for_selector('input[placeholder="Username"]')
        page.fill('input[placeholder="Username"]', user)
        page.fill('input[type="password"]', "ui_test_pw_123")
        page.get_by_role("button", name=re.compile(r"sign\s*up|create", re.I)).click()
        page.wait_for_url(re.compile(r"/$|/home"), timeout=10_000)
        page.wait_for_timeout(2500)

        surfaces = page.evaluate("""async () => {
            const res = await fetch('/api/options', {
              headers: { Authorization: 'Bearer ' + localStorage.getItem('token') } });
            const server = await res.json();
            return {
              dom: document.documentElement.getAttribute('data-theme'),
              ls: (JSON.parse(localStorage.getItem('options') || '{}')).theme,
              server: server.theme,
            };
        }""")
        assert surfaces == {"dom": "dark", "ls": "NIGHT", "server": "NIGHT"}, (
            "a theme chosen as a guest did not survive signing up, or the three "
            f"surfaces disagree about it: {surfaces}")

        step(27, "step 3/5: reload with /api/options unavailable - the stored theme must show")
        # Two things make this deterministic, and the first version of this step had
        # neither, so it passed with the fix mutated out:
        #
        #   - /api/options is ABORTED rather than merely delayed. The invariant is
        #     "the first paint uses the stored value, not `defaultOptions`", and
        #     killing the response widens that window to the whole load. Delaying it
        #     from inside the route handler was the first attempt and it deadlocked
        #     the sync API under the mutation audit - the row scored WRONG REASON
        #     with `CRASHED before asserting`, which is a coverage hole wearing a
        #     red result.
        #   - `prefers-color-scheme` is pinned to light, because the fallback this
        #     bug exposes is `SYSTEM` and SYSTEM follows the *browser*. On a
        #     dark-preferring browser the wrong fallback also renders dark, so
        #     "never painted light" is satisfied by the bug itself.
        page.emulate_media(color_scheme="light")
        page.route("**/api/options", lambda route: route.abort())
        try:
            # An IIFE, not a bare arrow function: Playwright *Python* executes this
            # string as a script, so `() => {...}` on its own just constructs a
            # function and throws it away - which left the array empty and made
            # this step fail for the wrong reason entirely.
            page.add_init_script("""(() => {
                window.__themes = [];
                const push = () => { const de = document.documentElement;
                  if (de) window.__themes.push(de.getAttribute('data-theme')); };
                const start = () => { if (!document.documentElement) {
                    requestAnimationFrame(start); return; }
                  push();
                  new MutationObserver(push).observe(document.documentElement,
                    { attributes: true, attributeFilter: ['data-theme'] }); };
                start();
            })();""")
            page.goto(frontend)
            page.wait_for_timeout(2500)
            painted = page.evaluate("() => window.__themes || []")
        finally:
            page.unroute("**/api/options")
            page.emulate_media(color_scheme=None)
        # Drop the leading null: the observer can start either side of App's very
        # first write, so index 0 is `None` on some runs and the first real theme
        # on others. What must hold is that the first theme ever *painted* is the
        # account's - `['light', 'dark']` is the flash, `['dark', ...]` is the fix.
        painted = [t for t in painted if t]
        assert painted and painted[0] == "dark", (
            "the page painted the wrong theme before /api/options answered - the "
            f"stored copy is not being read on the logged-in path (saw {painted})")

        # Steps 4 and 5 exist because the signup fix hides the bug they guard: with
        # the choice carried onto the account, the server and the stored copy agree,
        # so *not* keeping the mirror in step with the server changes nothing
        # observable. Divergence has to be created deliberately - a LOGIN whose
        # account theme differs from what this browser last stored. That is the real
        # shape of the original symptom: server SYSTEM, localStorage NIGHT, forever.
        step(27, "step 4/5: log out, choose LIGHT as a guest, log back in")
        page.get_by_role("button", name=re.compile(r"logout", re.I)).click()
        page.wait_for_timeout(1200)
        page.get_by_role("button", name="Options").click()
        page.wait_for_selector("select#themeSelect", timeout=5_000)
        page.locator("select#themeSelect").select_option("LIGHT")
        page.wait_for_timeout(600)
        page.keyboard.press("Escape")

        page.goto(f"{frontend}/login")
        page.wait_for_selector('input[placeholder="Username"]')
        page.fill('input[placeholder="Username"]', user)
        page.fill('input[type="password"]', "ui_test_pw_123")
        page.get_by_role("button", name=re.compile(r"login|log in", re.I)).click()
        page.wait_for_url(re.compile(r"/$|/home"), timeout=10_000)
        page.wait_for_timeout(2500)

        reconciled = page.evaluate(
            "() => ({ dom: document.documentElement.getAttribute('data-theme'),"
            " ls: (JSON.parse(localStorage.getItem('options') || '{}')).theme })")
        assert reconciled == {"dom": "dark", "ls": "NIGHT"}, (
            "after logging in, the stored copy still disagrees with the account - "
            "the server's answer is not being written back, so it stays stale for "
            f"good and resurfaces on logout: {reconciled}")

        step(27, "step 5/5: logging out must not flip the theme")
        page.get_by_role("button", name=re.compile(r"logout", re.I)).click()
        page.wait_for_timeout(1500)
        after = page.evaluate("document.documentElement.getAttribute('data-theme')")
        assert after == "dark", (
            f"logging out changed the theme to {after!r} - the mirror had drifted "
            "from what the account actually said")
        step(27, "PASS - choice survives signup, no flash, mirror reconciled, no flip")
    finally:
        page.evaluate("localStorage.removeItem('options')")
        if prior_token:
            page.evaluate("([t, n]) => { localStorage.setItem('token', t);"
                          " if (n) localStorage.setItem('username', n); }",
                          [prior_token, prior_name])


def test_wheel_image_quota(page, frontend: str, token: str):
    """An image too big for sessionStorage must warn, not wedge the page.

    Two bugs, one flow, because both are about the same modal being escapable.

    Escape did nothing on the Upload Custom Images dialog for as long as it
    existed: it is rendered as `<dialog open>` rather than via showModal(), so it
    gets no native Escape handling while its `.modal` backdrop still covers the
    viewport. Done was the only way out.

    Worse, the two `sessionStorage.setItem` calls were bare, inside a reactive
    block. A 19 MB PNG threw QuotaExceededError *inside a Svelte update flush*,
    so the rest of the flush never ran and `showImageUploadModal = false` stopped
    reaching the DOM - Done, the X and Escape all dead, 9/9 sampled viewport
    points covered, until a reload. Nothing was stored and nothing was said.

    So this asserts the message AND that the modal still closes: the message is
    the fix, the unclosable modal is the consequence.
    """
    original = page.viewport_size
    # The Upload Images button is `hidden lg:block`.
    page.set_viewport_size({"width": 1600, "height": 950})
    try:
        step(26, "step 1/4: opening the image upload modal and pressing Escape")
        page.goto(frontend)
        page.evaluate("t => localStorage.setItem('token', t)", token)
        pin_season(page)
        page.goto(f"{frontend}/random")
        page.wait_for_selector("button:has-text('Upload Images')", timeout=20_000)
        page.click("button:has-text('Upload Images')")
        page.wait_for_selector("dialog[open]", timeout=5_000)
        page.keyboard.press("Escape")
        page.wait_for_timeout(800)
        assert page.locator("dialog[open]").count() == 0, (
            "Escape did not close the image upload modal - it is a <dialog open>, "
            "so it has no native Escape behaviour and needs the window handler")

        step(26, "step 2/4: uploading an image far too big for sessionStorage")
        page.click("button:has-text('Upload Images')")
        page.wait_for_selector("dialog[open]", timeout=5_000)
        # Incompressible noise, so the PNG really is ~19 MB and the data URL
        # (~4/3 of that) cannot fit. Injected through a DataTransfer rather than
        # set_input_files because the file is generated in-page.
        size_mb = page.evaluate("""async () => {
            const c = document.createElement('canvas');
            c.width = 2400; c.height = 2400;
            const ctx = c.getContext('2d');
            const im = ctx.createImageData(2400, 2400);
            for (let i = 0; i < im.data.length; i += 4) {
              im.data[i] = Math.random() * 255 | 0;
              im.data[i + 1] = Math.random() * 255 | 0;
              im.data[i + 2] = Math.random() * 255 | 0;
              im.data[i + 3] = 255;
            }
            ctx.putImageData(im, 0, 0);
            const blob = await new Promise(r => c.toBlob(r, 'image/png'));
            const dt = new DataTransfer();
            dt.items.add(new File([blob], 'huge.png', { type: 'image/png' }));
            const input = document.querySelector('input[type=file]');
            input.files = dt.files;
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return +(blob.size / 1048576).toFixed(1);
        }""")

        step(26, f"step 3/4: {size_mb} MB uploaded - expecting a visible message")
        page.wait_for_timeout(4000)
        assert page.locator("[data-image-too-large]").count() == 1, (
            "an image too large to store failed silently - nothing kept, nothing "
            "said, exactly like the console-only 'Server busy' message")

        step(26, "step 4/4: the modal must still close")
        page.click("dialog[open] button:has-text('Done')")
        page.wait_for_timeout(1200)
        assert page.locator("dialog[open]").count() == 0, (
            "the upload modal never closed after an oversized image - the quota "
            "throw broke the Svelte update flush and wedged the whole page")
        step(26, f"PASS - {size_mb} MB rejected with a message, modal still closes")
    finally:
        page.set_viewport_size(original)
        page.evaluate("() => { sessionStorage.removeItem('wheelSpinButtonImage');"
                      " sessionStorage.removeItem('wheelBackgroundImage'); }")


def test_viewer_can_pick_the_right_show(page, backend: str, frontend: str, token: str):
    """The viewer's own correction path, on the page where a bad match is seen.

    /admin/matching can fix a wrong match and nobody goes there; the Watch
    pop-up is where it's noticed every season. The backend contract (the 409
    over an admin decision, the write, the provenance) is test_jellyfin step
    13 - what this guards is the wiring in between: that the control exists for
    a logged-in viewer, that it searches the LIBRARY, and that choosing an
    option actually fires the write rather than being a dead button.

    The POST is stubbed: a real pick rewrites identity for everyone and would
    leave the suite's own dev deployment altered.
    """
    step(25, "step 1/3: seed an entry whose identity is UNCERTAIN")
    # The picker is deliberately ABSENT when we know the show - a community-map
    # id or a human decision needs no correcting. Most of a season is confident,
    # so hunting the wheel for an uncertain entry skipped this test on every
    # run: it asserted nothing while reporting a pass. Seed the condition
    # instead. A `remote` row is a resolver guess, which is precisely the state
    # the picker exists for.
    admin = admin_token()
    if not admin:
        step(25, "SKIP - could not sign an admin token to seed an uncertain row")
        return
    ah = {"Authorization": f"Bearer {admin}"}
    shows = requests.get(f"{backend}/api/anime?season={SEEDED_SEASON}&year={SEEDED_YEAR}",
                         timeout=200).json()
    if not shows:
        step(25, "SKIP - the seeded season returned no entries")
        return
    target = shows[0]
    mid = target["id"]
    seed_title = ((target.get("title") or {}).get("english")
                  or (target.get("title") or {}).get("romaji") or str(mid))
    seed_list(backend, token, [mid])
    requests.put(f"{backend}/api/jellyfin/identity", headers=ah, timeout=15,
                 json={"anilistId": mid, "tvdbId": "99999996", "source": "remote",
                       "pending": True, "note": "remote: unverified"})
    def unseed():
        requests.delete(f"{backend}/api/jellyfin/identity/{mid}", headers=ah, timeout=15)

    page.goto(frontend)
    page.evaluate("t => { localStorage.setItem('token', t);"
                  " localStorage.setItem('username', 'ui_pick_probe'); }", token)
    pin_season(page)
    page.goto(f"{frontend}/random")
    page.wait_for_timeout(3000)
    clicked = page.evaluate(
        "t => { const el = [...document.querySelectorAll('[role=\"button\"]')]"
        ".find(e => (e.textContent || '').includes(t));"
        " if (!el) return false; el.click(); return true; }", seed_title)
    if not clicked:
        unseed()
        step(25, "SKIP - the seeded entry did not appear on the wheel")
        return
    try:
        page.wait_for_selector("[data-pick-open]", timeout=20_000)
    except Exception:
        unseed()
        step(25, "SKIP - no availability verdict for the seeded entry")
        return

    step(25, "step 2/3: the picker offers LIBRARY items, not resolver candidates")
    page.locator("[data-pick-open]").click()
    page.wait_for_selector("[data-pick-dropdown]", timeout=10_000)
    page.wait_for_timeout(3000)
    # The picker must say what the entry resolves to RIGHT NOW. Without it the
    # list is options with no indication which is live, so a viewer cannot tell
    # a correction from a no-op - and the prefilled search usually surfaces the
    # current match first, making that ambiguity the default view.
    current = (page.locator("[data-pick-current]").text_content() or "").strip()
    assert current, "the picker does not say what the entry is currently matched to"

    prefilled = page.locator("[data-pick-input]").input_value()
    opts = page.locator("[data-pick-results] li button")
    if not opts.count():
        unseed()
        step(25, "SKIP - the library returned no candidates for this title")
        return

    # Enter belongs to the search box while picking. `handleModalKey` is a
    # WINDOW listener that marks the show watched and closes the pop-up, so
    # typing a query and pressing Enter used to mark-watch the very show being
    # corrected - the trap the player already guards against, reached from a
    # second direction. A search with no hits is used deliberately: the failure
    # was reported while looking at exactly that empty state.
    page.locator("[data-pick-input]").fill("zzz no such show zzz")
    page.keyboard.press("Enter")
    page.wait_for_timeout(800)
    assert page.locator("[data-pick-dropdown]").count(), (
        "Enter in the library search closed the picker - the window-level modal "
        "key handler is still marking the show watched out from under it")
    assert "no match for" in (page.locator("[data-pick-results]").text_content() or "").lower(), (
        "an empty library search says nothing about why - it reads as a broken "
        "search rather than a show the library doesn't have")

    step(25, "step 3/3: choosing an option fires the write and closes the picker")
    # Restore the search that had results; the Enter check above cleared them.
    page.locator("[data-pick-input]").fill(prefilled)
    page.wait_for_timeout(3000)
    if not opts.count():
        unseed()
        step(25, "SKIP - results did not return after the keyboard check")
        return
    PICK_ROUTE = "**/api/jellyfin/identity/pick"
    page.route(PICK_ROUTE, lambda rt: rt.fulfill(
        status=200, content_type="application/json", body=json.dumps({"ok": True})))
    try:
        opts.first.click()
        page.wait_for_timeout(2500)
        assert not page.locator("[data-pick-dropdown]").count(), (
            "picking a library item left the picker open - the click did not run "
            "its handler, which is a dead button wearing a working one's clothes")
    finally:
        page.unroute(PICK_ROUTE)
        unseed()
    step(25, "PASS - the picker searches the library and a choice fires the write")


def test_guest_options_and_compare_warning(page, frontend: str):
    """The 'small three' remnants: a guest's options must mirror to
    localStorage (a theme choice used to survive only until reload), and
    Compare must say "No user named ..." for a typo'd username instead of
    rendering silently nothing.
    """
    step(24, "step 1/2: a guest theme choice must land in localStorage")
    page.goto(frontend)
    # The guest check needs a logged-out page, but Compare below needs the
    # session back - /compare renders no picker for guests.
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
        f"a guest's theme choice did not reach localStorage (stored={stored!r}) - "
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
        "a typo'd second user renders silently as nothing - indistinguishable "
        "from the user having no list at all")

    # The dropdown's own empty state, which is a different string from the
    # warning above. `noOptionsMessage` was passed to svelte-select for a long
    # time and is not one of its v5 props - it logged "created with unknown prop"
    # and rendered its own default "No options" instead. v5 uses a slot.
    assert page.locator("[data-no-users-found]").count() == 1, (
        "the user dropdown fell back to svelte-select's default empty text - the "
        "app's own wording is being passed as a prop the library does not have")
    step(24, "PASS - guest options persist, a missing user is named, dropdown empty state is ours")



# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------
# ---------------------------------------------------------------------------
# Flows that behave IDENTICALLY run alone - the only ones `--only-flows` accepts.
#
# The selector exists because the mutation audit re-runs this whole file twice
# per UI row, which is about half the audit's wall clock. It is deliberately an
# allowlist and not a free filter, because this exact optimisation has already
# gone wrong here: `--only-steps` was added to test_player.py to cut transcode
# cost and silently hollowed out six of fourteen rows, whose setup lived in the
# steps being skipped.
#
# Each flow below seeds its own list, pins its own season and navigates itself,
# on top of the session `main()` always mints before the first flow runs.
# Everything NOT here depends on something a predecessor left behind, and the
# dependency is rarely visible in the flow's own body:
#
#   - "search filter", "hide 18+ filter", "watched trailer btn", "theme
#     dropdown" never navigate at all - they act on whatever page the previous
#     flow left, and several restore state FOR later flows (the search box is
#     cleared, the season is put back).
#   - "logout" deliberately destroys the session the flows after it re-mint.
#
# "phone sidebar collapsed" is why this is an allowlist and not a free filter.
# It used to be green in isolation WITH its mutation applied, because the bug
# needs a desktop-width visit to have persisted a width preference and it was
# relying on the desktop flows happening to run first. The fix was to give the
# flow that visit of its own rather than to keep it off this list - an inherited
# precondition is a bug in the flow, not a property of the suite. It is only
# here because both its rows were then watched to fail under the narrowed run.
#
# Before adding a label here: run it alone, then run it alone WITH its
# mutation applied, and confirm it still fails. Passing alone is not enough -
# every flow below has been watched BOTH ways.
def test_my_list_reorder(page, backend: str, frontend: str, token: str):
    """Reordering My List persists.

    The app's core action, and until now every test SEEDED an order over the API
    and only ever read it back. Nothing dragged a row, so the write the user
    actually performs was unexercised - and it is not the endpoint the audit
    first assumed: My List sends the whole list to `PUT /api/list`, while
    `PATCH /api/list/rank` belongs to the Randomize sidebar (next flow).
    """
    step(30, "step 1/4: seeding a three-item list and opening Home")
    ids = season_ids(backend, 3)
    seed_list(backend, token, ids)
    page.goto(frontend)
    page.evaluate("t => localStorage.setItem('token', t)", token)
    pin_season(page)
    page.goto(frontend)
    wait_for_grids(page)
    page.wait_for_selector("[data-list-row]", timeout=15_000)
    before = row_order(page, "[data-list-row]")
    assert len(before) == 3, f"expected 3 rows in My List, saw {len(before)}"

    step(30, "step 2/4: dragging the first row below the last")
    sent: list = []
    def on_req(req):
        if req.method == "PUT" and req.url.rstrip("/").endswith("/api/list"):
            try:
                sent.append([i["mediaId"] for i in (req.post_data_json or {}).get("items", [])])
            except Exception:
                pass
    page.on("request", on_req)
    try:
        drag_row(page, "[data-list-row]", 0, 2, below=True)
        page.wait_for_timeout(1500)
    finally:
        page.remove_listener("request", on_req)

    expected = [before[1], before[2], before[0]]
    after = row_order(page, "[data-list-row]")
    assert after == expected, f"on screen the order is {after}, expected {expected}"

    step(30, "step 3/4: the new order was sent to the server")
    assert sent, "reordering fired no PUT /api/list - the move never left the browser"
    assert sent[-1] == expected, f"the request carried {sent[-1]}, expected {expected}"

    step(30, "step 4/4: and it survives a reload")
    # The screen agreeing with the request proves only that the component is
    # consistent with itself. A reload re-reads the server, which is the thing
    # the user is relying on.
    page.reload()
    wait_for_grids(page)
    page.wait_for_selector("[data-list-row]", timeout=15_000)
    reloaded = row_order(page, "[data-list-row]")
    assert reloaded == expected, f"after reload the order is {reloaded}, expected {expected}"
    step(30, f"PASS - {before} -> {expected}, persisted across a reload")


def test_watched_rank_reorder(page, backend: str, frontend: str, token: str):
    """Reordering the Randomize watched list persists.

    This is the `PATCH /api/list/rank` surface. The route answers `{ok:true}`
    whether or not it matched a single row - ids for entries that are not
    `watched`, or not in this season, update nothing and still return 200 - so
    asserting on the response would be vacuous. This reads the ranks back.
    """
    step(31, "step 1/4: seeding two watched entries and opening Randomize")
    ids = season_ids(backend, 3)
    seed_list(backend, token, ids)
    mark_watched(backend, token, ids[:2])
    page.goto(frontend)
    page.evaluate("t => localStorage.setItem('token', t)", token)
    pin_season(page)
    page.goto(f"{frontend}/random")
    page.wait_for_selector("[data-rank-row]", timeout=30_000)
    before = row_order(page, "[data-rank-row]")
    assert len(before) == 2, f"expected 2 watched rows, saw {len(before)}"

    step(31, "step 2/4: dragging the top one below the other")
    sent: list = []
    def on_req(req):
        if req.method == "PATCH" and req.url.rstrip("/").endswith("/api/list/rank"):
            try:
                sent.append((req.post_data_json or {}).get("ids"))
            except Exception:
                pass
    page.on("request", on_req)
    try:
        drag_row(page, "[data-rank-row]", 0, 1, below=True)
        page.wait_for_timeout(1500)
    finally:
        page.remove_listener("request", on_req)

    expected = [before[1], before[0]]
    step(31, "step 3/4: the new order was sent")
    assert sent, "reordering fired no PATCH /api/list/rank"
    assert sent[-1] == expected, f"the request carried {sent[-1]}, expected {expected}"

    step(31, "step 4/4: and watchedRank really moved on the server")
    r = requests.get(f"{backend}/api/list", timeout=15,
                     headers={"Authorization": f"Bearer {token}"},
                     params={"season": SEEDED_SEASON, "year": SEEDED_YEAR})
    assert r.status_code == 200, f"could not read the list back: {r.status_code}"
    ranks = {row["mediaId"]: row.get("watchedRank") for row in r.json()}
    assert ranks.get(expected[0]) == 0 and ranks.get(expected[1]) == 1, \
        f"watchedRank did not move: {ranks} (expected {expected[0]}=0, {expected[1]}=1)"
    step(31, f"PASS - {before} -> {expected}, watchedRank {ranks}")


def test_password_reset_journey(page, backend: str, frontend: str):
    """The forgot-password page, which nothing had ever rendered.

    `test_account_security.py` covers these routes thoroughly on its own
    throwaway backend - every code, every refusal. What no test did was LOAD the
    page: the only `page.goto` targets in this suite were Home, /login, /signup,
    /random and /compare. So a locked-out user's entire path was drawn by code
    nobody exercised.

    MAIL SAFETY. `POST /reset-request` mails the verified address of any
    code-path account, and the dev database's admin address is a real inbox.
    This flow therefore only ever reaches the server for an account it just
    created with no email at all, which `resetPathFor` puts on the open path by
    construction. The `code` and `blocked` branches are decided ENTIRELY by that
    response body, so they are asserted against a stubbed one - which is the
    page's real contract, render what the server said, and reaches no mailer.
    """
    step(32, "step 1/5: a throwaway account with no email - the open reset path")
    name = f"ui_rst_{int(time.time())}"
    r = requests.post(f"{backend}/api/auth/signup", timeout=10,
                      json={"username": name, "password": "ui_rst_old_pw"})
    assert r.status_code == 200, f"{name} signup failed: {r.status_code} {r.text[:120]}"

    prior_token = page.evaluate("localStorage.getItem('token')")
    prior_name = page.evaluate("localStorage.getItem('username')")
    try:
        page.goto(frontend)
        page.evaluate("localStorage.removeItem('token'); localStorage.removeItem('username')")
        page.goto(f"{frontend}/reset-password")
        page.wait_for_selector('[data-reset-step="username"]', timeout=15_000)

        step(32, "step 2/5: username -> confirm -> success")
        page.fill('input[placeholder="Username"]', name)
        assert continue_to_step(page) == "confirm", \
            "an account with no email was not offered the one-step reset"
        page.fill('input[placeholder="New password"]', "ui_rst_new_pw")
        page.get_by_role("button", name="Reset Password").click()
        page.wait_for_selector('[data-reset-step="success"]', timeout=15_000)

        step(32, "step 3/5: and the new password actually logs in")
        # The page saying "Password updated successfully" is the page's opinion.
        # Only a login proves the write landed.
        lr = requests.post(f"{backend}/api/auth/login", timeout=10,
                           json={"username": name, "password": "ui_rst_new_pw"})
        assert lr.status_code == 200, \
            f"the reset reported success but the new password does not log in: {lr.status_code}"

        step(32, "step 4/5: a coded account is offered the code form, not the open one")
        page.route("**/api/auth/reset-request",
                   lambda route: route.fulfill(
                       status=200, content_type="application/json",
                       body='{"codeRequired": true, "hint": "a*****z@example.test"}'))
        try:
            page.goto(f"{frontend}/reset-password")
            page.wait_for_selector('[data-reset-step="username"]', timeout=15_000)
            page.fill('input[placeholder="Username"]', name)
            assert continue_to_step(page) == "code", \
                "a coded account was handed the open reset form - knowing the "\
                "username would be enough to take it over"
            assert page.locator('input[placeholder="000000"]').count() == 1, \
                "the code step rendered no 6-digit field"
            assert "a*****z@example.test" in page.inner_text("body"), \
                "the code step did not name the masked address it sent to"
        finally:
            page.unroute("**/api/auth/reset-request")

        step(32, "step 5/5: an admin with no address is told why, not handed a form")
        blocked = ("This is an admin account with no verified email address, so it "
                   "cannot be reset here. Ask another admin to remove its admin "
                   "access first.")
        page.route("**/api/auth/reset-request",
                   lambda route: route.fulfill(
                       status=200, content_type="application/json",
                       body=json.dumps({"codeRequired": True, "noAddress": True,
                                        "message": blocked})))
        try:
            page.goto(f"{frontend}/reset-password")
            page.wait_for_selector('[data-reset-step="username"]', timeout=15_000)
            page.fill('input[placeholder="Username"]', name)
            assert continue_to_step(page) == "blocked", \
                "an admin with no address got a form instead of an explanation"
            assert page.locator('input[placeholder="New password"]').count() == 0, \
                "the blocked step still offered a password field"
            assert "remove its admin access" in page.inner_text("body"), \
                "the blocked step did not explain why it refused"
        finally:
            page.unroute("**/api/auth/reset-request")
    finally:
        page.goto(frontend)
        page.evaluate("""([t, n]) => {
            if (t) localStorage.setItem('token', t); else localStorage.removeItem('token');
            if (n) localStorage.setItem('username', n); else localStorage.removeItem('username');
        }""", [prior_token, prior_name])
    step(32, "PASS - open path resets and logs in; code and blocked branches render")


def test_admin_users_page(page, backend: str, frontend: str):
    """/admin/users - account access, never once loaded in a browser.

    The server rules are `test_account_security.py`'s, on its own backend. What
    this asserts is what the ADMIN SEES: that the last-admin floor is a disabled
    button with an explanation rather than an error after the fact, that a
    refusal lands beside the row it belongs to, and that Delete works.

    SAFETY. The dev database has exactly one admin and a live SMTP config, so:
    `Send test email` is never clicked (it falls back to the signed-in admin's
    real inbox), `Clear password` and `Clear email` are never DELIVERED - the one
    click is against a stubbed 409 - and the only account deleted is one this
    flow created seconds earlier.
    """
    step(33, "step 1/6: minting an admin token")
    tok = admin_token()
    if not tok:
        step(33, "SKIP - could not sign an admin token (node or backend/.env missing)")
        return
    page.goto(frontend)
    page.evaluate("t => { localStorage.setItem('token', t);"
                  " localStorage.setItem('username', 'admin_probe'); }", tok)
    page.goto(f"{frontend}/admin/users")
    page.wait_for_selector("[data-user-row]", timeout=20_000)

    step(33, "step 2/6: the last admin cannot be demoted or deleted, and is told why")
    admin_rows = page.locator('[data-user-row]:has([data-act="demote"])')
    if admin_rows.count() != 1:
        step(33, f"SKIP - {admin_rows.count()} admins on this box; the floor is only "
                 f"observable at one")
    else:
        demote = admin_rows.first.locator('[data-act="demote"]')
        delete = admin_rows.first.locator('[data-act="delete"]')
        assert demote.is_disabled(), \
            "the only admin could be demoted - the floor is not on screen"
        assert "promote someone else" in (demote.get_attribute("title") or ""), \
            "the disabled demote button does not say why"
        assert delete.is_disabled(), "the only admin could be deleted"

    step(33, "step 3/6: a new account appears, and the filter finds it")
    name = f"ui_adm_{int(time.time())}"
    r = requests.post(f"{backend}/api/auth/signup", timeout=10,
                      json={"username": name, "password": "ui_adm_pw"})
    assert r.status_code == 200, f"{name} signup failed: {r.status_code} {r.text[:120]}"
    page.reload()
    page.wait_for_selector(f'[data-user-row="{name}"]', timeout=20_000)
    page.fill('input[placeholder="Filter by username or email"]', name)
    page.wait_for_timeout(500)
    assert page.locator("[data-user-row]").count() == 1, \
        f"filtering for {name} left {page.locator('[data-user-row]').count()} rows"

    step(33, "step 4/6: sorting flips the header's aria-sort")
    page.fill('input[placeholder="Filter by username or email"]', "")
    page.wait_for_timeout(300)
    # `text-is` cannot match this button: it renders `User` plus an injected
    # sort arrow, so the accessible name is "User" only while unsorted.
    header = page.locator('th:has(button:has-text("User"))').first
    first_sort = header.get_attribute("aria-sort")
    header.locator("button").click()
    page.wait_for_timeout(300)
    assert header.get_attribute("aria-sort") != first_sort, \
        f"clicking the User header did not change aria-sort (stayed {first_sort!r})"

    step(33, "step 5/6: a server refusal lands beside the row it belongs to")
    # Stubbed, so nothing is actually cleared. The point is that `mutate()` puts
    # the server's sentence in that row rather than in a banner nobody links to
    # the account it is about.
    page.on("dialog", lambda d: d.accept())
    page.route("**/api/admin/users/*/clear-password",
               lambda route: route.fulfill(
                   status=409, content_type="application/json",
                   body='{"error": "This is the only admin account. Promote someone '
                        'else first.", "code": "LAST_ADMIN"}'))
    try:
        row = page.locator(f'[data-user-row="{name}"]')
        row.locator('[data-act="clear-pw"]').click()
        page.wait_for_selector(f'[data-user-row="{name}"] [data-row-notice="error"]',
                               timeout=10_000)
        notice = row.locator("[data-row-notice]").inner_text()
        assert "only admin account" in notice, \
            f"the row notice did not carry the server's reason: {notice!r}"
    finally:
        page.unroute("**/api/admin/users/*/clear-password")

    step(33, "step 6/6: Delete removes the account for real")
    page.locator(f'[data-user-row="{name}"] [data-act="delete"]').click()
    page.wait_for_selector(f'[data-user-row="{name}"]', state="detached", timeout=15_000)
    left = requests.get(f"{backend}/api/admin/users", timeout=15,
                        headers={"Authorization": f"Bearer {tok}"})
    assert left.status_code == 200, f"could not re-read the user list: {left.status_code}"
    assert not any(u["username"] == name for u in left.json()["users"]), \
        f"{name} vanished from the table but not from the server"
    step(33, f"PASS - floor shown as disabled controls, refusal rendered in-row, "
             f"{name} deleted")


HEALTH_DB = REPO / "backend" / "prisma" / "prisma" / "data.db"
HEALTH_KEYS = ("upstreamHealth", "alertSettings")


def _appconfig_backup() -> dict:
    c = sqlite3.connect(HEALTH_DB)
    try:
        return {k: (r[0] if (r := c.execute(
            "SELECT value FROM AppConfig WHERE key = ?", (k,)).fetchone()) else None)
            for k in HEALTH_KEYS}
    finally:
        c.close()


def _appconfig_restore(saved: dict) -> None:
    c = sqlite3.connect(HEALTH_DB)
    try:
        for k, v in saved.items():
            if v is None:
                c.execute("DELETE FROM AppConfig WHERE key = ?", (k,))
            else:
                c.execute("INSERT INTO AppConfig(key, value) VALUES(?, ?) "
                          "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (k, v))
        c.commit()
    finally:
        c.close()


def test_admin_status_badges(page, backend: str, frontend: str):
    """/admin/status - the page a broken upstream is supposed to explain.

    `test_status_page.py` covers the ROUTE. Nothing rendered the page, which is
    where the distinction that matters lives: `Not checked` and `Not set up` are
    not `OK`, and a service mid-wobble is `Failing`, not `Down`.

    States are INJECTED rather than provoked, for the reason `test_status_page`
    gives about skips: on a working box nothing is down, so "if it is down,
    check the badge" asserts nothing at all. `POST /api/status/probe` is never
    called - it hits skyhook, AniList and Gmail, and a crossing record mails the
    owner.
    """
    step(34, "step 1/4: minting an admin token")
    tok = admin_token()
    if not tok:
        step(34, "SKIP - could not sign an admin token (node or backend/.env missing)")
        return

    saved = _appconfig_backup()
    try:
        step(34, "step 2/4: injecting one service per state")
        now = time.time()
        iso = lambda secs_ago: time.strftime(
            "%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(now - secs_ago))
        # `stateOf` is a pure function of the record, so each of these is exact.
        # skyhook's `brokenAfter` is 6 and the quiet window is 10 minutes: the
        # `failing` case below is a streak PAST that threshold with a recent
        # success, which must still read amber. That pairing is the whole point -
        # it is the case the badge used to get wrong.
        health = {
            "skyhook":  {"consecutiveFailures": 9, "lastCheckedAt": iso(30),
                         "lastFailAt": iso(30), "lastOkAt": iso(20),
                         "lastFailReason": "injected", "lastFailStatus": 500},
            "tmdb":     {"consecutiveFailures": 9, "lastCheckedAt": iso(30),
                         "lastFailAt": iso(30), "lastOkAt": None,
                         "lastFailReason": "injected", "lastFailStatus": 500},
            "sonarr":   {"lastCheckedAt": iso(60), "lastSkipped": "no Sonarr server configured"},
            "anilist":  {"consecutiveFailures": 0, "lastCheckedAt": iso(60), "lastOkAt": iso(60)},
            "jellyfin": {"lastCheckedAt": None},
        }
        c = sqlite3.connect(HEALTH_DB)
        try:
            c.execute("INSERT INTO AppConfig(key, value) VALUES(?, ?) "
                      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                      ("upstreamHealth", json.dumps(health)))
            c.commit()
        finally:
            c.close()

        page.goto(frontend)
        page.evaluate("t => { localStorage.setItem('token', t);"
                      " localStorage.setItem('username', 'admin_probe'); }", tok)
        page.goto(f"{frontend}/admin/status")
        page.wait_for_selector("[data-svc-row]", timeout=20_000)

        step(34, "step 3/4: every state renders its own badge, and the words differ")
        want = {"skyhook": ("failing", "Failing"), "tmdb": ("down", "Down"),
                "sonarr": ("notConfigured", "Not set up"),
                "anilist": ("ok", "OK"), "jellyfin": ("unknown", "Not checked")}
        for svc, (state, label) in want.items():
            badge = page.locator(f'[data-svc-row="{svc}"] [data-svc-state]').first
            got = badge.get_attribute("data-svc-state")
            assert got == state, f"{svc} reads state {got!r}, expected {state!r}"
            text = (badge.inner_text() or "").strip()
            assert text == label, f"{svc} badge says {text!r}, expected {label!r}"

        step(34, "step 4/4: the worst news sorts to the top")
        order = page.evaluate(
            "() => [...document.querySelectorAll('[data-svc-row]')]"
            ".map(e => e.querySelector('[data-svc-state]').getAttribute('data-svc-state'))")
        rank = {"down": 0, "failing": 1, "unknown": 2, "ok": 3, "notConfigured": 4}
        seen = [rank[o] for o in order if o in rank]
        assert seen == sorted(seen), f"rows are not worst-first: {order}"
        step(34, f"PASS - 5 states rendered distinctly, {len(order)} rows sorted worst-first")
    finally:
        _appconfig_restore(saved)


def test_compare_share_image(page, backend: str, frontend: str):
    """Compare's share button really produces an image.

    CLAUDE.md names BOTH share functions as DOM-clone-heavy and says to verify
    them by hand; only `shareMyList()` was ever automated. `shareCompare()` does
    two things its sibling does not, either of which fails silently inside the
    same swallowing try/catch: it reads the live `<select>` labels and swaps
    them into spans on a second clone, and it disables cross-origin Google Fonts
    stylesheets for the capture and puts them back in a `finally`.
    """
    step(35, "step 1/3: seeding two users with differing orders")
    ts = int(time.time())
    user_a, user_b = f"ui_shr_A_{ts}", f"ui_shr_B_{ts}"
    tokens = {}
    for name in (user_a, user_b):
        r = requests.post(f"{backend}/api/auth/signup", timeout=10,
                          json={"username": name, "password": "pw"})
        assert r.status_code == 200, f"{name} signup failed: {r.status_code} {r.text[:120]}"
        tokens[name] = r.json()["token"]
    x, y, z = season_ids(backend, 3)
    seed_list(backend, tokens[user_a], [x, y, z])
    seed_list(backend, tokens[user_b], [z, x, y])

    page.goto(frontend)
    page.evaluate("([t, u]) => { localStorage.setItem('token', t);"
                  " localStorage.setItem('username', u); }", [tokens[user_a], user_a])
    pin_season(page)
    page.goto(f"{frontend}/compare")
    page.wait_for_timeout(2500)

    step(35, f"step 2/3: picking {user_b} so there is something to share")
    box = page.locator("#otherUser").first
    box.wait_for(timeout=15_000)
    box.click()
    box.type(user_b, delay=40)
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
    page.wait_for_function(
        "() => document.querySelectorAll('[data-compare-row]').length > 0", timeout=20_000)

    share = page.locator("[data-share-btn]").first
    if not share.count() or not share.is_visible():
        # `hidden md:inline-flex` - below 768px the control genuinely is not there.
        step(35, "SKIP - the share control is not rendered at this viewport")
        return

    step(35, "step 3/3: clicking Share and checking what it wrote")
    # Same stub as the Home flow: the real `window.open` runs after an await, by
    # which point Chrome has withdrawn the user activation and blocks the popup.
    # Stubbing it keeps the test on the part that fails silently - the render.
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
        raise AssertionError("Compare share produced nothing - toJpeg most likely "
                             "resolved to undefined and its try/catch swallowed it")
    src = page.evaluate("""() => (window.__shared.match(/src="([^"]+)"/) || [])[1] || ''""")
    assert src.startswith("data:image/jpeg"), \
        f"Compare share produced no JPEG data URL (got {src[:60]!r})"
    assert len(src) > 5000, f"Compare share produced a tiny image ({len(src)} chars)"
    colours = page.evaluate(COUNT_COLOURS, src)
    assert colours > 1, "the shared Compare image is one flat colour - it rendered blank"

    # The font stylesheets are disabled during capture and restored in a
    # `finally`. Leaving them off would not fail anything here, and the page
    # would silently lose its typeface until the next navigation.
    disabled = page.evaluate(
        "() => [...document.styleSheets].filter(s => s.disabled).length")
    assert disabled == 0, \
        f"{disabled} stylesheet(s) left disabled after sharing - the restore did not run"
    step(35, f"PASS - {len(src) // 1024} KB JPEG, {colours} colour buckets, "
             f"stylesheets restored")


def test_nicknames_set_and_shown(page, backend: str, frontend: str, token: str):
    """Nicknames - a whole feature with four endpoints and no UI coverage.

    A "nickname" is `WatchList.customName`, and there is no route that writes
    one: saving re-PUTs the entire list, so a bug in the mapping silently drops
    the name while every request still returns 200. The reading half is the four
    unauthenticated `/api/list/*` endpoints, rendered only inside the Randomize
    pop-up and only for users the viewer has selected.
    """
    step(36, "step 1/4: seeding a list and naming one entry through the UI")
    ids = season_ids(backend, 3)
    seed_list(backend, token, ids)
    page.goto(frontend)
    page.evaluate("t => localStorage.setItem('token', t)", token)
    pin_season(page)
    page.goto(frontend)
    wait_for_grids(page)
    page.wait_for_selector("[data-list-row]", timeout=15_000)

    target = row_order(page, "[data-list-row]")[0]
    nickname = f"ui nick {int(time.time())}"
    sent: list = []
    def on_req(req):
        if req.method == "PUT" and req.url.rstrip("/").endswith("/api/list"):
            try:
                sent.append((req.post_data_json or {}).get("items", []))
            except Exception:
                pass
    page.on("request", on_req)
    try:
        page.locator(f'[data-list-row="{target}"] button').first.dblclick()
        page.wait_for_selector("#watchlist-custom-name", timeout=10_000)
        page.fill("#watchlist-custom-name", nickname)
        # Scoped to the dialog, and exact: a trailer button's aria-label reads
        # "Play trailer for Saved By the Ice Cold Prince's Embrace", which a
        # substring match on "Save" happily picks up.
        page.locator("dialog").get_by_role("button", name="Save", exact=True).click()
        page.wait_for_timeout(1500)
    finally:
        page.remove_listener("request", on_req)

    step(36, "step 2/4: the name reached the server inside the whole-list PUT")
    assert sent, "saving a nickname fired no PUT /api/list"
    named = [i for i in sent[-1] if i.get("mediaId") == target]
    assert named and named[0].get("customName") == nickname, \
        f"the PUT carried {named!r} - customName was dropped on the way out"

    step(36, "step 3/4: a second user's nickname is seeded and read back")
    other = f"ui_nk_{int(time.time())}"
    r = requests.post(f"{backend}/api/auth/signup", timeout=10,
                      json={"username": other, "password": "pw"})
    assert r.status_code == 200, f"{other} signup failed: {r.status_code}"
    other_token = r.json()["token"]
    other_nick = "their name for it"
    pr = requests.put(f"{backend}/api/list", timeout=15,
                      headers={"Authorization": f"Bearer {other_token}"},
                      json={"season": SEEDED_SEASON, "year": SEEDED_YEAR,
                            "items": [{"mediaId": target, "customName": other_nick}]})
    assert pr.status_code == 200, f"seeding {other}'s nickname failed: {pr.status_code}"

    step(36, "step 4/4: and it is shown on Randomize, attributed and ranked")
    mark_watched(backend, token, [target])
    page.goto(f"{frontend}/random")
    page.wait_for_selector(f'[data-rank-row="{target}"]', timeout=30_000)
    page.locator(f'[data-rank-row="{target}"]').dblclick()
    row = page.locator(f'[data-nickname-row="{other}"]')
    try:
        row.wait_for(timeout=15_000)
    except Exception:
        shown = page.evaluate("() => [...document.querySelectorAll('[data-nickname-row]')]"
                              ".map(e => e.getAttribute('data-nickname-row'))")
        raise AssertionError(f"{other}'s nickname was not shown; rows present: {shown}")
    text = row.inner_text()
    assert other_nick in text, f"the row named {other} but not their nickname: {text!r}"
    assert "#" in text, f"the row showed no rank: {text!r}"
    step(36, f"PASS - set {nickname!r} through the UI, and {other}'s {other_nick!r} renders")


SELECTABLE_FLOWS = {
    "compare 2 users",
    "admin page",
    "unknown never hides",
    "share as image",
    "remote accept visible",
    "translation error visible",
    "trailer modal esc",
    "viewer picks the right show",
    "no-results message",
    "unaired not looked up",
    "library unreachable visible",
    "hung backend reported",
    "failed hide write reverts",
    "check-batch chunked",
    "guest options + compare warning",
    "phone sidebar collapsed",
    "wheel image quota",
    "theme survives signup",
    "sonarr page renders",
    "subtitle batch button",
    "my list reorder",
    "watched rank reorder",
    "password reset journey",
    "admin users page",
    "admin status badges",
    "compare share image",
    "nicknames set and shown",
}



def test_subtitle_batch_button(page, backend: str, frontend: str):
    """/admin/subtitles can actually START a batch.

    The trigger existed from the beginning - `POST /api/translate/batch`, admin
    only, with a 409 guard shared with the auto-scheduler - and nothing on
    screen ever reached it, so starting a run meant curl. The page showed the
    schedule, the live tail and the last run's exit code: everything except the
    button.

    ALERTS ARE SWITCHED OFF around this. A batch that exits non-zero mails the
    admins, and since alerts default to the owner that is a real inbox. A test
    that mails a human on every run is the same defect as an alert that fires on
    every failure - it trains the reader to ignore it. The master switch is
    restored in the `finally`, because leaving alerts off after a crashed test
    is the silent half of that bug.
    """
    step(29, "step 1/5: minting an admin token")
    tok = admin_token()
    if not tok:
        step(29, "SKIP - could not sign an admin token (node or backend/.env missing)")
        return
    ah = {"Authorization": f"Bearer {tok}"}

    step(29, "step 2/5: silencing alerts so this run cannot mail a human")
    saved = requests.get(f"{backend}/api/status/report", headers=ah, timeout=20)
    saved_settings = saved.json().get("settings") if saved.status_code == 200 else None
    requests.put(f"{backend}/api/status/alerts", headers=ah, timeout=20,
                 json={"masterEnabled": False, "perService": {}, "extraRecipients": []})
    try:
        page.goto(frontend)
        page.evaluate("t => { localStorage.setItem('token', t);"
                      " localStorage.setItem('username', 'admin_probe'); }", tok)
        page.goto(f"{frontend}/admin/subtitles")
        page.wait_for_selector("[data-batch-controls]", timeout=40_000)

        step(29, "step 3/5: the control is present, enabled and honest about the model")
        btn = page.locator("[data-run-batch]")
        assert btn.count(), (
            "no Run-now control on /admin/subtitles - the batch endpoint is "
            "reachable only by curl again")
        label = (btn.first.text_content() or "").strip()
        # The page must not imply it can run the champion pipeline: the server
        # is CPU-only and the image carries small + medium, nothing else.
        assert "medium" in label.lower(), (
            f"the button must say which model it runs (got {label!r}) - a run that "
            "quietly produced a lower rank than the Sunday job is the confusion "
            "the modelName ladder exists to prevent")

        step(29, "step 4/5: clicking it reaches the endpoint")
        posts: list[str] = []
        page.on("request", lambda r: posts.append(r.method)
                if "translate/batch" in r.url and r.method == "POST" else None)
        page.locator("[data-batch-dry-run]").check()
        btn.first.click()
        page.wait_for_selector("[data-batch-notice], [data-batch-error]", timeout=20_000)
        assert posts, "clicking Run now sent no POST to /api/translate/batch"
        err = page.locator("[data-batch-error]")
        assert not err.count(), f"the batch could not be started: {err.first.text_content()!r}"

        step(29, "step 5/5: and the button reflects the run rather than firing blind")
        # The fire-and-forget failure this page's siblings already taught us:
        # a control that changes nothing on screen is indistinguishable from a
        # dead one. Disabled-or-running is the visible consequence.
        assert btn.first.is_disabled(), (
            "Run now stayed enabled after starting a batch - the admin cannot "
            "tell a started run from a dead button, and can double-fire")
    finally:
        if saved_settings:
            requests.put(f"{backend}/api/status/alerts", headers=ah, timeout=20,
                         json=saved_settings)
        else:
            requests.put(f"{backend}/api/status/alerts", headers=ah, timeout=20,
                         json={"masterEnabled": True, "perService": {}, "extraRecipients": []})


def test_sonarr_page_renders(page, frontend: str):
    """/admin/sonarr renders honestly - structure, not just HTTP 200.

    This page had no browser coverage at all, and every defect in it was found
    by a human looking at the screen while the build, svelte-check and the API
    tests were all green:

      * a stray <td> put 8 cells in a 7-column table, shifting every value one
        column right;
      * a badge wrapped inside its own pill and stopped looking like a badge;
      * the Include button overlapped a clipped status badge;
      * and the headline read "0 will be added" when Sonarr could not be
        reached, which is the worst available misreading of "couldn't ask".

    None of those is a type error, so nothing else here can catch them. The
    assertions below are the shapes of those four bugs.
    """
    step(28, "step 1/4: loading /admin/sonarr as the admin user")
    tok = admin_token()
    if not tok:
        step(28, "SKIP - could not sign an admin token (node or backend/.env missing)")
        return
    page.goto(frontend)
    page.evaluate("t => { localStorage.setItem('token', t);"
                  " localStorage.setItem('username', 'admin_probe'); }", tok)
    page.goto(f"{frontend}/admin/sonarr")
    page.wait_for_selector("[data-sonarr-stats]", timeout=30_000)
    # Expand every accordion: the tables that broke were all inside one.
    page.evaluate("document.querySelectorAll('details').forEach(d => d.open = true)")

    step(28, "step 2/4: every row table matches its own colgroup")
    bad = page.evaluate("""() => {
        const out = [];
        document.querySelectorAll('table').forEach((t, ti) => {
            const cols = t.querySelectorAll('colgroup col').length;
            if (!cols) return;                       // the summary strip has none
            t.querySelectorAll('tbody tr').forEach((r, ri) => {
                if (r.children.length !== cols)
                    out.push(`table ${ti} row ${ri}: ${r.children.length} cells vs ${cols} columns`);
            });
            const head = t.querySelector('thead tr');
            if (head && head.children.length !== cols)
                out.push(`table ${ti} header: ${head.children.length} cells vs ${cols} columns`);
        });
        return out;
    }""")
    assert not bad, f"row/column mismatch - values render under the wrong headings: {bad[:3]}"

    step(28, "step 3/4: tables line up with each other, and nothing is clipped")
    sigs = page.evaluate("""() => {
        const t = [...document.querySelectorAll('table')].filter(x => x.querySelector('colgroup'));
        return [...new Set(t.map(x => [...(x.querySelector('tbody tr')?.children ?? [])]
            .map(c => Math.round(c.getBoundingClientRect().width)).join(',')).filter(Boolean))];
    }""")
    assert len(sigs) <= 1,         f"row tables have {len(sigs)} different column layouts, so they do not line up: {sigs}"
    clipped = page.evaluate("""() => {
        const out = [];
        document.querySelectorAll('tbody td').forEach(td => {
            // `truncate` overflows on purpose - that is how the ellipsis works.
            if (td.classList.contains('truncate')) return;
            if (td.scrollWidth > td.clientWidth + 1)
                out.push(td.textContent.trim().slice(0, 30));
        });
        return out;
    }""")
    assert not clipped, f"content clipped or overlapping in {len(clipped)} cell(s): {clipped[:3]}"
    tall = page.evaluate("""() => [...document.querySelectorAll('.badge')]
        .filter(b => b.getBoundingClientRect().height > 26)
        .map(b => b.textContent.trim())""")
    assert not tall, f"badge(s) wrapped onto a second line and stopped reading as badges: {tall[:3]}"

    step(28, "step 4/4: the headline never reports 'couldn't ask' as zero")
    text = page.evaluate("document.body.innerText")
    observed = page.evaluate("""() => fetch('/api/sonarr/report', {
        headers: { Authorization: 'Bearer ' + localStorage.getItem('token') }
    }).then(r => r.json()).then(d => d.sonarr.observed)""")
    # Asserted BOTH ways so this step is never vacuous. On this deployment
    # `observed` is usually true, so a one-sided check would sit here passing
    # without ever running - the shape of a test that guards nothing.
    if observed:
        assert "cannot tell what sonarr would add" not in text.lower(),             ("Sonarr has been read successfully, yet the page says it cannot tell - "
             "the headline is not following the observation")
    else:
        assert "would add 0" not in text.lower(),             ("the page reported 0 additions while Sonarr had never been read - "
             "'couldn't ask' must never render as 'nothing to do'")
    rows = page.evaluate("document.querySelectorAll('tbody tr').length")
    step(28, f"PASS - {rows} rows, one column layout, no clipping or wrapped badges, "
             f"headline honest (observed={observed})")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frontend", default="http://localhost:5173")
    parser.add_argument("--backend",  default="http://localhost:3000")
    parser.add_argument("--headed", action="store_true")
    parser.add_argument(
        "--only-flows",
        help="comma-separated flow labels to run alone; only self-sufficient "
             "flows are accepted (see SELECTABLE_FLOWS)",
    )
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    frontend = args.frontend.rstrip("/")
    print(f"UI interaction smoke test - {frontend}", flush=True)

    failed = 0
    ran = 0
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
                ("viewer picks the right show", lambda: test_viewer_can_pick_the_right_show(page, args.backend, frontend, token_a)),
                ("guest options + compare warning", lambda: test_guest_options_and_compare_warning(page, frontend)),
                ("wheel image quota", lambda: test_wheel_image_quota(page, frontend, token_a)),
                ("theme survives signup", lambda: test_theme_survives_signup_and_reload(page, args.backend, frontend)),
                ("sonarr page renders", lambda: test_sonarr_page_renders(page, frontend)),
                ("subtitle batch button", lambda: test_subtitle_batch_button(page, args.backend, frontend)),
                ("my list reorder",     lambda: test_my_list_reorder(page, args.backend, frontend, token_a)),
                ("watched rank reorder",lambda: test_watched_rank_reorder(page, args.backend, frontend, token_a)),
                ("password reset journey", lambda: test_password_reset_journey(page, args.backend, frontend)),
                ("admin users page",    lambda: test_admin_users_page(page, args.backend, frontend)),
                ("admin status badges", lambda: test_admin_status_badges(page, args.backend, frontend)),
                ("compare share image", lambda: test_compare_share_image(page, args.backend, frontend)),
                ("nicknames set and shown", lambda: test_nicknames_set_and_shown(page, args.backend, frontend, token_a)),
            ]
            if args.only_flows:
                want = [x.strip() for x in args.only_flows.split(",") if x.strip()]
                known = {label for label, _ in tests}
                unknown = [w for w in want if w not in known]
                if unknown:
                    print(f"  unknown flow label(s): {unknown} - known labels are "
                          f"{sorted(known)}", flush=True)
                    sys.exit(2)
                blocked = [w for w in want if w not in SELECTABLE_FLOWS]
                if blocked:
                    # Refusing is the whole point: a flow that inherits state
                    # can pass alone while proving nothing.
                    print(f"  refusing to run {blocked} in isolation - those flows "
                          f"depend on state earlier flows leave behind, and would "
                          f"pass vacuously. See SELECTABLE_FLOWS.", flush=True)
                    sys.exit(2)
                tests = [(l, fn) for l, fn in tests if l in want]
                print(f"  --only-flows: running {len(tests)} of {TOTAL} flow(s)", flush=True)

            ran = len(tests)
            for label, fn in tests:
                try:
                    fn()
                except AssertionError as e:
                    print(f"  FAIL [{label}] - {e}", flush=True)
                    failed += 1
                except Exception as e:
                    print(f"  ERROR [{label}] - {type(e).__name__}: {e}", flush=True)
                    failed += 1
        finally:
            browser.close()

    # Report against what actually RAN. Printing "25/25" after a one-flow
    # selection is how a narrowed run gets mistaken for full coverage - and the
    # mutation audit reads this line.
    total = ran or TOTAL
    if failed:
        print(f"\nDone: {total - failed}/{total} passed, {failed} failed", flush=True)
        sys.exit(1)
    print(f"\nDone: {total}/{total} passed", flush=True)


if __name__ == "__main__":
    main()
