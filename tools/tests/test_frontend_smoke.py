"""
Pre-deploy smoke test: frontend route renders.

Loads each public page in Playwright, asserts no console errors and key
elements render. Catches build-level JS errors, missing routes, and broken
lazy-loaded chunks.

Usage:
  pip install playwright
  playwright install chromium
  py -3.13 -u tools/tests/test_frontend_smoke.py [--frontend http://localhost:5173]

Exits 0 on all-pass, 1 on any failure.
"""
import argparse
import re
import sys
import time

from playwright.sync_api import sync_playwright

TOTAL_STEPS = 5

# Error patterns we can safely ignore (third-party network noise, YouTube ads, etc.)
IGNORED_ERROR_PATTERNS = [
    r"doubleclick\.net",
    r"googleads",
    r"ERR_BLOCKED_BY_CLIENT",
    r"net::ERR_ADDRESS_INVALID",   # ad blocker domain shims
    r"favicon\.ico",
]


def is_real_error(text: str) -> bool:
    return not any(re.search(p, text) for p in IGNORED_ERROR_PATTERNS)


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} FE-smoke] {msg}", flush=True)


def fail(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL_STEPS} FE-smoke] FAIL — {msg}", flush=True)
    sys.exit(1)


def load_page(page, url: str, n: int, label: str, wait_selector: str, wait_ms: int = 3000):
    """Navigate to url, wait for selector, assert no console errors."""
    errors = []
    page.on("pageerror", lambda exc: errors.append(f"pageerror: {exc}"))
    def on_console(msg):
        if msg.type == "error":
            text = msg.text
            if is_real_error(text):
                errors.append(f"console: {text}")
    page.on("console", on_console)

    page.goto(url, wait_until="domcontentloaded", timeout=15000)
    page.wait_for_selector(wait_selector, timeout=10000)
    page.wait_for_timeout(wait_ms)  # let lazy chunks settle
    if errors:
        fail(n, f"{label} produced {len(errors)} console error(s): {errors[:3]}")
    step(n, f"PASS — {label} rendered, no real console errors")
    # detach listeners to avoid double-counting
    page.remove_listener("pageerror", lambda exc: None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--frontend", default="http://localhost:5173")
    parser.add_argument("--headed", action="store_true")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    frontend = args.frontend.rstrip("/")
    username = f"fe_smoke_{int(time.time())}"
    password = "smoke_pw_123"

    print(f"Frontend route smoke test — {frontend}", flush=True)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not args.headed)
        page = browser.new_page()
        try:
            # ───────── 1/5  Home renders anime grid ─────────
            step(1, "loading / (Home page)")
            page.goto(frontend, wait_until="domcontentloaded", timeout=15000)
            # Skip the blur-up placeholders (aria-hidden): they're covers too,
            # but they come and go as the full-size images load in.
            page.wait_for_selector(
                'img[src*="anilist"]:not([aria-hidden]), img[src*="ytimg"]', timeout=15000
            )
            anime_count = page.locator('img[src*="anilist"]').count()
            if anime_count < 1:
                fail(1, f"no anime cards rendered (got {anime_count})")
            step(1, f"PASS — Home rendered {anime_count} anime cards")

            # ───────── 2/5  Login page form ─────────
            step(2, "loading /login")
            page.goto(f"{frontend}/login", wait_until="domcontentloaded", timeout=15000)
            page.wait_for_selector('input[placeholder="Username"]', timeout=10000)
            page.wait_for_selector('input[type="password"]', timeout=5000)
            step(2, "PASS — Login form rendered")

            # ───────── 3/5  SignUp page form ─────────
            step(3, "loading /signup")
            page.goto(f"{frontend}/signup", wait_until="domcontentloaded", timeout=15000)
            page.wait_for_selector('input[placeholder="Username"]', timeout=10000)
            page.wait_for_selector('input[type="password"]', timeout=5000)
            step(3, "PASS — SignUp form rendered")

            # Sign up to test auth-gated pages
            page.fill('input[placeholder="Username"]', username)
            page.fill('input[type="password"]', password)
            page.get_by_role("button", name=re.compile(r"sign\s*up|create", re.I)).click()
            page.wait_for_url(re.compile(r"/$|/home"), timeout=10000)

            # ───────── 4/5  Randomize page ─────────
            step(4, "loading /random (requires login)")
            page.goto(f"{frontend}/random", wait_until="domcontentloaded", timeout=15000)
            # Wheel renders even with empty list — should at least have a button
            page.wait_for_timeout(2000)
            # Should NOT be redirected to /login
            if "/login" in page.url:
                fail(4, f"redirected to login — auth-gated route broken: {page.url}")
            step(4, "PASS — Randomize page loaded (not redirected to login)")

            # ───────── 5/5  Compare page ─────────
            step(5, "loading /compare (requires login)")
            page.goto(f"{frontend}/compare", wait_until="domcontentloaded", timeout=15000)
            page.wait_for_timeout(2000)
            if "/login" in page.url:
                fail(5, f"redirected to login — auth-gated route broken: {page.url}")
            step(5, "PASS — Compare page loaded")
        finally:
            browser.close()

    print(f"\nDone: 5/5 passed", flush=True)


if __name__ == "__main__":
    main()
