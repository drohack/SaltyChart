"""
Pre-deploy smoke test: the Jellyfin player itself.

The rest of the suite never opens the player, which is exactly how two
regressions reached a browser with a green build and 10/10 passing:

  * a deleted `let preparing` left a bare `preparing = false`, which Vite
    happily compiles as a global assignment — every playback threw before
    `player.src()`;
  * `loadLibass()` unwrapped each import's `.default`, and so did the call
    site, so jassub got `workerUrl: undefined`. Its worker never started, an
    8 s timeout fired, and every ASS release silently fell back to WebVTT —
    losing the exact fidelity the integration exists for. Nothing failed
    loudly; it just quietly stopped doing its job.

So this drives the real thing: pop-up → Watch → playing, and asserts the
parts that can regress silently.

Skips itself when Jellyfin is unconfigured, or when nothing in the current
season is actually in the library.

Usage:
  py -3.13 -u tools/tests/test_player.py [--backend ...] [--frontend ...]
"""
import argparse
import sys
from datetime import date

import requests
from playwright.sync_api import sync_playwright

TOTAL = 9
USERNAME = "player_test_fixture"
PASSWORD = "player_pw_123"


def step(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL} player] {msg}", flush=True)


def fail(n: int, msg: str) -> None:
    print(f"[{n}/{TOTAL} player] FAIL — {msg}", flush=True)
    print(f"\nPlayer: FAILED at step {n}", flush=True)
    sys.exit(1)


def skip_all(n: int, why: str) -> None:
    step(n, f"SKIP — {why}")
    print(f"Player: skipped — {why}", flush=True)
    sys.exit(0)


def current_season_year() -> tuple[str, int]:
    today = date.today()
    return ("WINTER", "SPRING", "SUMMER", "FALL")[(today.month - 1) // 3], today.year


def auth_token(backend: str) -> str:
    requests.post(f"{backend}/api/auth/signup",
                  json={"username": USERNAME, "password": PASSWORD}, timeout=10)
    r = requests.post(f"{backend}/api/auth/login",
                      json={"username": USERNAME, "password": PASSWORD}, timeout=10)
    if r.status_code != 200:
        fail(1, f"login: {r.status_code} {r.text[:160]}")
    return r.json()["token"]


def find_playable(backend: str, auth: dict, season: str, year: int) -> list[dict]:
    """Entries from the season that Jellyfin actually has, ASS-bearing first."""
    r = requests.get(f"{backend}/api/anime?season={season}&year={year}&format=TV", timeout=180)
    if r.status_code != 200 or not r.json():
        return []
    found = []
    for show in r.json():
        titles = [t for t in (show.get("title") or {}).values() if t][:10]
        if not titles:
            continue
        try:
            body = requests.post(f"{backend}/api/jellyfin/availability", headers=auth,
                                 json={"mediaId": show["id"], "titles": titles},
                                 timeout=90).json()
        except requests.RequestException:
            continue
        if not body.get("available") or not body.get("itemId"):
            continue
        pb = requests.get(f"{backend}/api/jellyfin/playback/{body['itemId']}"
                          f"?mediaSourceId={body['mediaSourceId']}", headers=auth,
                          timeout=60).json()
        subs = pb.get("subtitles", [])
        found.append({
            "mediaId": show["id"],
            "title": titles[0],
            "hasAss": any("ass" in (s.get("codec") or "").lower() for s in subs),
            "subs": len(subs),
        })
        # One ASS release proves the libass path; that's what we're here for.
        if any(f["hasAss"] for f in found) and len(found) >= 2:
            break
        if len(found) >= 8:
            break
    found.sort(key=lambda f: not f["hasAss"])
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--backend", default="http://localhost:3000")
    parser.add_argument("--frontend", default="http://localhost:5173")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    backend, frontend = args.backend.rstrip("/"), args.frontend.rstrip("/")
    season, year = current_season_year()
    print(f"Player smoke test — {frontend} ({season} {year})", flush=True)

    step(1, f"auth as {USERNAME} and check Jellyfin is configured")
    token = auth_token(backend)
    auth = {"Authorization": f"Bearer {token}"}
    status = requests.get(f"{backend}/api/jellyfin/status", headers=auth, timeout=15).json()
    if not status.get("configured"):
        skip_all(1, "Jellyfin not configured (set URL+key on /admin to enable)")
    step(1, "PASS — authenticated, Jellyfin configured")

    step(2, f"finding a {season} {year} series in the library")
    playable = find_playable(backend, auth, season, year)
    if not playable:
        skip_all(2, f"nothing from {season} {year} is in the library")
    target = playable[0]
    kind = "ASS" if target["hasAss"] else "text-only"
    requests.put(f"{backend}/api/list", headers=auth, timeout=30,
                 json={"season": season, "year": year,
                       "items": [p["mediaId"] for p in playable]})
    step(2, f"PASS — using {target['title'][:38]!r} ({kind}, {target['subs']} tracks)")

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        warnings: list[str] = []
        page.on("console", lambda m: warnings.append(m.text)
                if m.type in ("warning", "error") else None)

        page.goto(frontend)
        page.evaluate(
            "([t, u]) => { localStorage.setItem('token', t); localStorage.setItem('username', u); }",
            [token, USERNAME])
        page.goto(f"{frontend}/random")
        page.wait_for_timeout(1500)

        # The wheel may default to a different season than the one we seeded.
        btn = page.locator(f"button:text-is('{season.capitalize()}')")
        if btn.count():
            btn.first.click()
            page.wait_for_timeout(2500)

        step(3, "open the pop-up and confirm the Watch button")
        item = page.locator("li", has_text=target["title"][:24]).first
        try:
            item.wait_for(timeout=20_000)
            item.click()
        except Exception:
            fail(3, f"never found {target['title'][:32]!r} in the unwatched list")
        watch = page.locator("button", has_text="Watch here (via Jellyfin)").first
        try:
            watch.wait_for(timeout=30_000)
        except Exception:
            fail(3, "the Watch button never appeared for a series known to be available")
        step(3, "PASS — '▶ Watch here (via Jellyfin)' shown")

        # ── 4  Pre-warm happened while the pop-up sat open ──
        step(4, "pop-up pre-warmed the player before Watch was pressed")
        page.wait_for_timeout(2500)
        warmed = page.evaluate("""() => {
            const names = performance.getEntriesByType('resource').map(e => e.name);
            const n = re => names.filter(x => re.test(x)).length;
            return { playback: n(/jellyfin\\/playback/), libass: n(/jassub/),
                     subtitles: n(/jellyfin\\/subtitles/),
                     attachments: n(/jellyfin\\/attachments/),
                     // Reported on failure so the assertion says what it saw.
                     seen: names.filter(x => /jellyfin\\/(playback|subtitles|attachments)/.test(x))
                                .map(x => x.replace(/.*\\/api\\/jellyfin\\//, '').replace(/\\?.*/, '')) };
        }""")
        if not warmed["playback"] or not warmed["libass"]:
            fail(4, f"nothing pre-warmed before the click — playback={warmed['playback']} "
                    f"libass={warmed['libass']} subtitles={warmed['subtitles']} "
                    f"seen={warmed['seen']}")
        step(4, f"PASS — pre-warmed playback+{warmed['subtitles']} subtitle"
                f"+{warmed['attachments']} font requests, no stream started")

        # Pre-starting the stream is deliberately NOT done: Jellyfin's ffmpeg
        # writes segments until the file is done regardless of the playhead,
        # so an abandoned pop-up would remux a whole episode to disk.
        if page.evaluate("() => performance.getEntriesByType('resource')"
                         ".filter(e => /jellyfin\\/stream/.test(e.name)).length"):
            fail(4, "the stream was started before Watch was pressed")

        step(5, "press Watch and wait for real playback")
        watch.click()
        try:
            page.wait_for_function(
                "() => { const v = document.querySelector('video');"
                " return v && v.currentTime > 0.2 && v.readyState >= 3 && v.videoWidth > 0; }",
                timeout=60_000)
        except Exception:
            fail(5, "video never advanced (currentTime/readyState/videoWidth)")
        state = page.evaluate("() => { const v = document.querySelector('video');"
                              " return { t: v.currentTime, rs: v.readyState, w: v.videoWidth }; }")
        step(5, f"PASS — playing at {state['t']:.1f}s, {state['w']}px wide")

        step(6, "exactly one subtitle menu, defaulting to a plain English track")
        menus = page.evaluate("""() => {
            const bar = document.querySelector('.vjs-control-bar');
            return { mine: document.querySelectorAll('.vjs-subtitles-button').length,
                     native: document.querySelectorAll('.vjs-subs-caps-button').length,
                     selected: [...(bar?.querySelectorAll('.vjs-subtitles-button .vjs-menu-item') || [])]
                        .filter(i => i.classList.contains('vjs-selected'))
                        .map(i => i.textContent.replace(/^, selected/, '').trim()) };
        }""")
        if menus["mine"] != 1:
            fail(6, f"expected exactly 1 subtitle menu, found {menus['mine']}")
        if menus["native"]:
            fail(6, "video.js's own captions button is still present — two menus disagree")
        chosen = " ".join(menus["selected"]).lower()
        if not chosen:
            fail(6, "no subtitle track selected by default")
        for bad in ("sdh", "dubtitle", "forced", "hearing impaired"):
            if bad in chosen:
                fail(6, f"default track is a {bad} track: {menus['selected']}")
        step(6, f"PASS — one menu, default {menus['selected']}")

        step(7, "] and [ step playback rate by 0.10 without waking the control bar")
        rates = page.evaluate("""async () => {
            const p = document.querySelector('.video-js').player;
            p.userActive(false);
            await new Promise(r => setTimeout(r, 300));
            const before = p.playbackRate();
            const fire = k => window.dispatchEvent(new KeyboardEvent('keydown', {key: k, bubbles: true}));
            const media = () => document.querySelector('video').playbackRate;
            fire(']'); fire(']');
            await new Promise(r => setTimeout(r, 200));
            const up = p.playbackRate(), mediaUp = media(), active = p.userActive();
            fire('[');
            await new Promise(r => setTimeout(r, 200));
            return { before, up, mediaUp, down: p.playbackRate(), mediaDown: media(), active };
        }""")
        if abs(rates["up"] - (rates["before"] + 0.2)) > 0.001:
            fail(7, f"] twice should add 0.20: {rates}")
        if abs(rates["down"] - (rates["up"] - 0.1)) > 0.001:
            fail(7, f"[ should subtract 0.10: {rates}")
        # VHS never touches playbackRate, so the media element must track the
        # player exactly at both ends — that pass-through is the whole feature.
        if abs(rates["mediaUp"] - rates["up"]) > 0.001 or \
           abs(rates["mediaDown"] - rates["down"]) > 0.001:
            fail(7, f"the media element didn't follow the player: {rates}")
        if rates["active"]:
            fail(7, "changing speed woke the control bar")
        step(7, f"PASS — {rates['before']:.2f} → {rates['up']:.2f} → {rates['down']:.2f}, bar stayed hidden")

        step(8, "ASS renders through libass, not the WebVTT fallback")
        if not target["hasAss"]:
            step(8, "SKIP — this release has no ASS track (text-only)")
        else:
            fallback = [w for w in warnings if "libass unavailable" in w]
            if fallback:
                fail(8, f"silently fell back to WebVTT: {fallback[0][:160]}")
            # canvas.width is meaningless here — libass transfers the canvas to
            # its worker, so the main thread keeps a stale attribute. The CSS
            # box is what resize() actually sets.
            box = page.evaluate("""() => {
                const c = document.querySelector('canvas.JASSUB');
                const v = document.querySelector('video');
                if (!c) return null;
                const cr = c.getBoundingClientRect(), vr = v.getBoundingClientRect();
                return { cw: Math.round(cr.width), ch: Math.round(cr.height),
                         vw: Math.round(vr.width), vh: Math.round(vr.height) };
            }""")
            if not box:
                fail(8, "no libass canvas — ASS track did not render")
            if abs(box["cw"] - box["vw"]) > 2 or abs(box["ch"] - box["vh"]) > 2:
                fail(8, f"libass canvas doesn't cover the video: {box}")
            # A correctly sized canvas is NOT proof of rendering: a script that
            # names a font its MKV doesn't attach drew *empty frames* here —
            # worker healthy, canvas sized, `ready` resolved, no error anywhere.
            # What fixed it was libass having a fallback face to substitute, so
            # guard the asset that provides one. Nothing can read the canvas
            # itself: it belongs to the worker.
            font = page.evaluate("""async () => {
                const r = await fetch('/node_modules/jassub/dist/default.woff2');
                const b = await r.arrayBuffer();
                const sig = new TextDecoder().decode(new Uint8Array(b, 0, 4));
                return { ok: r.ok, bytes: b.byteLength, sig };
            }""")
            if not font["ok"] or font["bytes"] < 1000 or font["sig"] != "wOF2":
                fail(8, f"libass has no fallback font — a script naming an "
                        f"unattached font will render nothing: {font}")
            step(8, f"PASS — libass canvas {box['cw']}x{box['ch']} over the video, "
                    f"fallback font {font['bytes'] // 1024}KB")

        step(9, "Escape closes and stops the transcode; the episode reopens")
        stops: list[str] = []
        page.on("request", lambda r: stops.append(r.url)
                if "playback/stop" in r.url else None)
        page.keyboard.press("Escape")
        page.wait_for_timeout(2000)
        if page.locator("video").count():
            fail(9, "the player is still open after Escape")
        if not stops:
            fail(9, "closing did not tell Jellyfin to stop the transcode")

        # Reopening the SAME episode reuses a cached playbackInfo — including
        # the playSessionId we just told Jellyfin to tear down. It works, but
        # only because Jellyfin is lenient about it, so pin the behaviour.
        # Closing the player leaves the show pop-up open behind it, so the
        # Watch button is still there — no need to reselect the series.
        watch2 = page.locator("button", has_text="Watch here (via Jellyfin)").first
        watch2.wait_for(timeout=30_000)
        watch2.click()
        try:
            page.wait_for_function(
                "() => { const v = document.querySelector('video');"
                " return v && v.currentTime > 0.2 && v.readyState >= 3; }",
                timeout=60_000)
        except Exception:
            fail(9, "reopening the same episode did not play (stale playSessionId?)")
        page.keyboard.press("Escape")
        page.wait_for_timeout(1500)
        step(9, "PASS — closed, transcode stopped, and the same episode reopens")

        browser.close()

    print(f"Player: {TOTAL}/{TOTAL} passed — OK", flush=True)


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nPlayer: FAIL — backend unreachable: {e}", flush=True)
        sys.exit(1)
