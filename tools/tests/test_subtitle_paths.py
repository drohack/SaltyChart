"""
Regression test: subtitle UI paths.

Verifies the 3 frontend subtitle behaviors end-to-end with Playwright:
  B) YouTube English CC video -> iframe has cc_load_policy=0 + cc_lang_pref=en,
     no Whisper overlay rendered.
  C) Whisper-only video -> overlay div renders with non-empty text.
  D) CC toggle -> overlay hides, PATCH /dismiss persists, reopen stays hidden,
     re-toggle restores.

Usage:
  pip install playwright requests
  playwright install chromium
  py -3.13 -u tools/tests/test_subtitle_paths.py

Requires:
  - Backend at http://localhost:3000 with SubtitleCache populated
  - Frontend at http://localhost:5173 (Vite strictPort=true)
  - Logged-in test user (creates a fresh signup; uses a unique username each run)

Exits 0 on all-pass, 1 on any failure.
"""
import argparse
import re
import sys
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

# Test videos - must exist in SubtitleCache with the right state
VIDEO_EN_CC      = "-W2vs2etG9o"   # has YouTube English CC (Path A/B). NOTE:
# must be a trailer in the CURRENT season or its Home button won't render and
# the test times out - refresh when it ages out (pick one that check-batch
# reports as an English-CC positive for the current season).
VIDEO_WHISPER    = "ByOF3FLlAws"   # hasEnglishSubs=0, has cached segments


def reset_dismiss(backend: str, video_id: str) -> None:
    """Reset subtitlesDisabled=false so test starts from a known state."""
    requests.patch(f"{backend}/api/translate/dismiss?videoId={video_id}",
                   json={"disabled": False}, timeout=5)


def signup_test_user(page, frontend: str) -> str:
    username = f"sub_test_{int(time.time())}"
    page.goto(f"{frontend}/signup")
    page.wait_for_selector('input[placeholder="Username"]')
    page.fill('input[placeholder="Username"]', username)
    page.fill('input[type="password"]', "testpass123")
    page.get_by_role("button", name=re.compile(r"sign\s*up|create", re.I)).click()
    page.wait_for_url(re.compile(r"/$|/home"), timeout=10_000)
    return username


def click_trailer(page, video_id: str):
    page.locator(f'button:has(img[src*="{video_id}"])').first.click()


def find_overlay(page):
    """The Whisper cue (`.sc-subtitle` - the class exists for this test and the
    fullscreen stylesheet), if rendered with text. It used to be selected by
    layout classes (`absolute left-1/2`) and silently matched nothing once the
    cue became a centred child of a full-width row: Path C could not see the
    overlay and Path B's "no overlay" check passed vacuously."""
    el = page.locator('.sc-subtitle:has-text("")').first
    return el if el.count() > 0 and (el.text_content() or "").strip() else None


def wait_for_overlay_text(page, max_wait_ms: int = 10_000, poll_ms: int = 500) -> str:
    """Poll for the Whisper cue to render non-empty text. Returns the text
    (empty string if it never appeared within the timeout). Used in place of a
    blind wait_for_timeout - exits as soon as the cue appears (~2-3s typically)
    instead of always sleeping the full max.

    Polls rather than waiting once because the cue is EMPTY in the gaps between
    segments: it appears, disappears and reappears throughout playback, so a
    single look can land in a gap on a perfectly working player.

    Selects on `.sc-subtitle`. It used to walk `div.absolute` for a class
    containing `left-1/2`, which stopped matching anything when the cue became a
    centred child of a full-width row - Paths C and D then failed on a clean
    build, and Path B's "no overlay" assertion passed vacuously.
    """
    waited = 0
    while waited < max_wait_ms:
        text = page.evaluate("""() => {
          const el = document.querySelector('.sc-subtitle');
          const t = el ? (el.textContent || '').trim() : '';
          return t.length > 0 ? t : '';
        }""")
        if text:
            return text
        page.wait_for_timeout(poll_ms)
        waited += poll_ms
    return ""


def test_b_youtube_cc(page):
    p = "[1/3 PathB-CC]"
    print(f"{p} step 1/5: opening trailer with YouTube English CC", flush=True)
    click_trailer(page, VIDEO_EN_CC)
    page.wait_for_selector('iframe[src*="youtube"]', timeout=10_000)
    iframe_src = page.locator('iframe[src*="youtube"]').first.get_attribute("src") or ""
    print(f"{p} step 2/5: checking iframe config", flush=True)
    assert "cc_load_policy=0" in iframe_src, f"missing cc_load_policy=0: {iframe_src}"
    assert "cc_lang_pref=en" in iframe_src, f"missing cc_lang_pref=en: {iframe_src}"
    print(f"{p} step 3/5: verifying no Whisper overlay rendered", flush=True)
    time.sleep(3)
    overlay_count = page.locator('.sc-subtitle').filter(
        has_text=re.compile(r".+")).count()
    assert overlay_count == 0, f"unexpected Whisper overlay rendered: {overlay_count}"
    # Fullscreen is player chrome, not a subtitle control, and this is the path
    # that lost it: the button was wrapped in the `!hasEnglishSubs` gate while
    # the iframe carries no `allowfullscreen`, so YouTube-CC trailers had no
    # fullscreen at all. Nothing else opens a Path A trailer, so it is pinned here.
    print(f"{p} step 4/5: fullscreen button must be there while YouTube CC is active", flush=True)
    fs = page.locator('button[title="Fullscreen"]')
    assert fs.count() == 1 and fs.first.is_visible(), \
        f"fullscreen button missing with YouTube CC active (count={fs.count()})"
    fs.first.click()
    page.wait_for_timeout(600)
    fs_el = page.evaluate("document.fullscreenElement ? document.fullscreenElement.className : ''")
    assert "sc-player" in fs_el, f"fullscreen element is not the player wrapper: {fs_el!r}"
    # In a real browser Escape is the browser's own leave-fullscreen gesture and
    # never reaches the page; a synthetic Escape here DOES reach our handler,
    # which must leave the modal alone while fullscreen (the guard frontend/
    # CLAUDE.md describes). Fullscreen is then left the way the page offers -
    # the same button - and the modal must still be there afterwards.
    print(f"{p} step 5/5: Escape in fullscreen keeps the modal; the button leaves fullscreen", flush=True)
    page.keyboard.press("Escape")
    page.wait_for_timeout(400)
    assert page.locator('iframe[src*="youtube"]').count() == 1, "Escape while fullscreen closed the modal"
    page.locator('button[title="Exit fullscreen"]').first.click()
    page.wait_for_timeout(600)
    assert not page.evaluate("!!document.fullscreenElement"), "still fullscreen after the exit button"
    assert page.locator('iframe[src*="youtube"]').count() == 1, "leaving fullscreen closed the modal"
    print(f"{p} PASS - iframe configured, no overlay, fullscreen works", flush=True)
    page.locator('.fixed.inset-0.bg-black\\/80').click(position={"x": 5, "y": 5})
    page.wait_for_timeout(1500)


def test_c_whisper_overlay(page):
    p = "[2/3 PathC-Whisper]"
    print(f"{p} step 1/4: opening trailer (no English CC) - Whisper translation expected", flush=True)
    click_trailer(page, VIDEO_WHISPER)
    page.wait_for_selector('iframe[src*="youtube"]', timeout=10_000)
    print(f"{p} step 2/4: polling for overlay text (up to 10s)", flush=True)
    overlay_text = wait_for_overlay_text(page, max_wait_ms=10_000)
    assert overlay_text, "no overlay text rendered within 10s"

    # Path B enters fullscreen too, but on a YouTube-CC trailer - which by
    # definition has no cue of OURS to lose, so it cannot see this. This is the
    # trailer whose subtitles we render, and fullscreen is where they went
    # missing repeatedly: only the fullscreen element receives pointer input, so
    # if the IFRAME wins the takeover the cue is never painted and our controls
    # sit above it visible and dead.
    print(f"{p} step 3/4: fullscreen must keep OUR cue on screen", flush=True)
    page.locator('button[title="Fullscreen"]').first.click()
    page.wait_for_timeout(800)
    fs_el = page.evaluate("document.fullscreenElement ? document.fullscreenElement.className : ''")
    assert "sc-player" in fs_el, f"wrapper did not take fullscreen on the Whisper path: {fs_el!r}"
    assert wait_for_overlay_text(page, max_wait_ms=8_000),         "our subtitle cue was not rendered at all in fullscreen"
    # `find_overlay` asks whether the cue is in the DOM, and `text_content()`
    # answers yes for a `display:none` node - a mutation that hid the whole cue
    # layer under `:fullscreen` SURVIVED a presence-only check here. Shown and
    # present are different questions, so ask the second one explicitly.
    cue = page.locator('.sc-subtitle').filter(has_text=re.compile(r".+")).first
    assert cue.is_visible(), "our subtitle cue disappeared in fullscreen"

    # Visibility is NOT the question. The buttons were on screen and dead once,
    # and both a screenshot and `elementFromPoint` called that a pass - only a
    # click that changes something can tell the two apart. So assert the effect.
    print(f"{p} step 4/4: and our CC toggle must still work there, not just show", flush=True)
    page.locator('button[title="Hide subtitles"]').first.click()
    page.wait_for_timeout(1200)
    # Assert on the state the button owns, not on the cue being absent right now:
    # cues have natural gaps between segments, so a single sample can find no
    # text while the toggle did nothing at all. An inert-handler mutation
    # SURVIVED that check for exactly this reason, then failed 30s later on an
    # unrelated locator - red, and proving nothing about the toggle.
    assert page.locator('button[title="Show subtitles"]').count() == 1,         "CC toggle did nothing in fullscreen - painted but not clickable"
    assert find_overlay(page) is None, "cue still rendering after the toggle in fullscreen"
    page.locator('button[title="Show subtitles"]').first.click()
    assert wait_for_overlay_text(page, max_wait_ms=8_000),         "cue did not come back after re-enabling in fullscreen"

    # Leave exactly the state Path D expects: modal open, subtitles on, windowed.
    page.locator('button[title="Exit fullscreen"]').first.click()
    page.wait_for_timeout(600)
    assert not page.evaluate("!!document.fullscreenElement"), "still fullscreen after the exit button"
    assert page.locator('iframe[src*="youtube"]').count() == 1, "leaving fullscreen closed the modal"
    print(f"{p} PASS - overlay rendered, survived fullscreen, toggle live there: "
          f"\"{overlay_text[:50]}\"", flush=True)


def test_d_cc_toggle(page, backend: str):
    p = "[3/3 PathD-Toggle]"
    print(f"{p} step 1/5: clicking CC toggle to hide overlay", flush=True)
    page.locator('button[title="Hide subtitles"]').click()
    page.wait_for_timeout(1500)
    overlay_count = page.locator('.sc-subtitle').filter(
        has_text=re.compile(r".+")).count()
    assert overlay_count == 0, "overlay still visible after toggle off"

    print(f"{p} step 2/5: verifying PATCH /dismiss persisted to DB", flush=True)
    r = requests.get(f"{backend}/api/translate/check?videoId={VIDEO_WHISPER}", timeout=5)
    assert r.json().get("subtitlesDisabled") is True, "subtitlesDisabled not persisted"

    print(f"{p} step 3/5: closing modal", flush=True)
    page.locator('.fixed.inset-0.bg-black\\/80').click(position={"x": 5, "y": 5})
    page.wait_for_timeout(1500)
    print(f"{p} step 4/5: reopening - overlay should still be hidden", flush=True)
    click_trailer(page, VIDEO_WHISPER)
    page.wait_for_selector('iframe[src*="youtube"]', timeout=10_000)
    # Give the iframe time to load but use a shorter window since we expect
    # NO overlay to appear (dismiss honored). 4s is enough to be confident
    # the overlay isn't going to render - if dismiss was broken, the overlay
    # would have shown by 4s the same way Path C shows it by ~3s.
    page.wait_for_timeout(4_000)
    overlay_count = page.locator('.sc-subtitle').filter(
        has_text=re.compile(r".+")).count()
    assert overlay_count == 0, "overlay reappeared on reopen - dismiss not honored"

    print(f"{p} step 5/5: re-toggling on - overlay should return", flush=True)
    page.locator('button[title="Show subtitles"]').click()
    overlay_text = wait_for_overlay_text(page, max_wait_ms=8_000)
    assert overlay_text, "overlay didn't return after re-toggle"
    print(f"{p} PASS - full toggle round-trip works", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend",  default="http://localhost:3000")
    parser.add_argument("--frontend", default="http://localhost:5173")
    parser.add_argument("--headed",   action="store_true")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    print(f"Subtitle UI regression test", flush=True)
    print(f"  backend={args.backend} frontend={args.frontend}", flush=True)

    # Reset state for the Whisper test video
    reset_dismiss(args.backend, VIDEO_WHISPER)

    failed = 0
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        page    = browser.new_page()
        try:
            user = signup_test_user(page, args.frontend)
            print(f"  signed up as {user}\n", flush=True)
            for test_fn, label in [
                (lambda pg: test_b_youtube_cc(pg), "B"),
                (lambda pg: test_c_whisper_overlay(pg), "C"),
                (lambda pg: test_d_cc_toggle(pg, args.backend), "D"),
            ]:
                try:
                    test_fn(page)
                except AssertionError as e:
                    print(f"       FAIL [{label}] - {e}", flush=True)
                    failed += 1
                except Exception as e:
                    print(f"       ERROR [{label}] - {type(e).__name__}: {e}", flush=True)
                    failed += 1
        finally:
            browser.close()
            # Cleanup: re-enable subs on test video
            reset_dismiss(args.backend, VIDEO_WHISPER)

    # Final line - what the status bar shows after script exit
    if failed:
        print(f"\nDone: {3 - failed}/3 passed, {failed} failed", flush=True)
        sys.exit(1)
    print(f"\nDone: 3/3 passed", flush=True)


if __name__ == "__main__":
    main()
