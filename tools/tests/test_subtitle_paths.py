"""
Regression test: subtitle UI paths.

Verifies the 3 frontend subtitle behaviors end-to-end with Playwright:
  B) YouTube English CC video → iframe has cc_load_policy=0 + cc_lang_pref=en,
     no Whisper overlay rendered.
  C) Whisper-only video → overlay div renders with non-empty text.
  D) CC toggle → overlay hides, PATCH /dismiss persists, reopen stays hidden,
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

# Test videos — must exist in SubtitleCache with the right state
VIDEO_EN_CC      = "-W2vs2etG9o"   # has YouTube English CC (Path A/B). NOTE:
# must be a trailer in the CURRENT season or its Home button won't render and
# the test times out — refresh when it ages out (pick one that check-batch
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
    """Whisper overlay div, if visible with text."""
    el = page.locator('div.absolute.left-1\\/2:has-text("")').first
    return el if el.count() > 0 and (el.text_content() or "").strip() else None


def wait_for_overlay_text(page, max_wait_ms: int = 10_000, poll_ms: int = 500) -> str:
    """Poll for the Whisper overlay to render non-empty text. Returns the text
    (empty string if it never appeared within the timeout). Used in place of a
    blind wait_for_timeout — exits as soon as the overlay appears (~2-3s
    typically) instead of always sleeping the full max."""
    waited = 0
    while waited < max_wait_ms:
        text = page.evaluate("""() => {
          const divs = Array.from(document.querySelectorAll('div.absolute'));
          for (const d of divs) {
            if (d.className.includes('left-1/2')) {
              const t = (d.textContent || '').trim();
              if (t.length > 0) return t;
            }
          }
          return '';
        }""")
        if text:
            return text
        page.wait_for_timeout(poll_ms)
        waited += poll_ms
    return ""


def test_b_youtube_cc(page):
    p = "[1/3 PathB-CC]"
    print(f"{p} step 1/3: opening trailer with YouTube English CC", flush=True)
    click_trailer(page, VIDEO_EN_CC)
    page.wait_for_selector('iframe[src*="youtube"]', timeout=10_000)
    iframe_src = page.locator('iframe[src*="youtube"]').first.get_attribute("src") or ""
    print(f"{p} step 2/3: checking iframe config", flush=True)
    assert "cc_load_policy=0" in iframe_src, f"missing cc_load_policy=0: {iframe_src}"
    assert "cc_lang_pref=en" in iframe_src, f"missing cc_lang_pref=en: {iframe_src}"
    print(f"{p} step 3/3: verifying no Whisper overlay rendered", flush=True)
    time.sleep(3)
    overlay_count = page.locator('div.absolute.left-1\\/2').filter(
        has_text=re.compile(r".+")).count()
    assert overlay_count == 0, f"unexpected Whisper overlay rendered: {overlay_count}"
    print(f"{p} PASS — iframe configured, no overlay", flush=True)
    page.locator('.fixed.inset-0.bg-black\\/80').click(position={"x": 5, "y": 5})
    page.wait_for_timeout(1500)


def test_c_whisper_overlay(page):
    p = "[2/3 PathC-Whisper]"
    print(f"{p} step 1/2: opening trailer (no English CC) — Whisper translation expected", flush=True)
    click_trailer(page, VIDEO_WHISPER)
    page.wait_for_selector('iframe[src*="youtube"]', timeout=10_000)
    print(f"{p} step 2/2: polling for overlay text (up to 10s)", flush=True)
    overlay_text = wait_for_overlay_text(page, max_wait_ms=10_000)
    assert overlay_text, "no overlay text rendered within 10s"
    print(f"{p} PASS — overlay rendered: \"{overlay_text[:60]}\"", flush=True)


def test_d_cc_toggle(page, backend: str):
    p = "[3/3 PathD-Toggle]"
    print(f"{p} step 1/5: clicking CC toggle to hide overlay", flush=True)
    page.locator('button[title="Hide subtitles"]').click()
    page.wait_for_timeout(1500)
    overlay_count = page.locator('div.absolute.left-1\\/2').filter(
        has_text=re.compile(r".+")).count()
    assert overlay_count == 0, "overlay still visible after toggle off"

    print(f"{p} step 2/5: verifying PATCH /dismiss persisted to DB", flush=True)
    r = requests.get(f"{backend}/api/translate/check?videoId={VIDEO_WHISPER}", timeout=5)
    assert r.json().get("subtitlesDisabled") is True, "subtitlesDisabled not persisted"

    print(f"{p} step 3/5: closing modal", flush=True)
    page.locator('.fixed.inset-0.bg-black\\/80').click(position={"x": 5, "y": 5})
    page.wait_for_timeout(1500)
    print(f"{p} step 4/5: reopening — overlay should still be hidden", flush=True)
    click_trailer(page, VIDEO_WHISPER)
    page.wait_for_selector('iframe[src*="youtube"]', timeout=10_000)
    # Give the iframe time to load but use a shorter window since we expect
    # NO overlay to appear (dismiss honored). 4s is enough to be confident
    # the overlay isn't going to render — if dismiss was broken, the overlay
    # would have shown by 4s the same way Path C shows it by ~3s.
    page.wait_for_timeout(4_000)
    overlay_count = page.locator('div.absolute.left-1\\/2').filter(
        has_text=re.compile(r".+")).count()
    assert overlay_count == 0, "overlay reappeared on reopen — dismiss not honored"

    print(f"{p} step 5/5: re-toggling on — overlay should return", flush=True)
    page.locator('button[title="Show subtitles"]').click()
    overlay_text = wait_for_overlay_text(page, max_wait_ms=8_000)
    assert overlay_text, "overlay didn't return after re-toggle"
    print(f"{p} PASS — full toggle round-trip works", flush=True)


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
                    print(f"       FAIL [{label}] — {e}", flush=True)
                    failed += 1
                except Exception as e:
                    print(f"       ERROR [{label}] — {type(e).__name__}: {e}", flush=True)
                    failed += 1
        finally:
            browser.close()
            # Cleanup: re-enable subs on test video
            reset_dismiss(args.backend, VIDEO_WHISPER)

    # Final line — what the status bar shows after script exit
    if failed:
        print(f"\nDone: {3 - failed}/3 passed, {failed} failed", flush=True)
        sys.exit(1)
    print(f"\nDone: 3/3 passed", flush=True)


if __name__ == "__main__":
    main()
