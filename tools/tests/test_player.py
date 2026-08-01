"""
Pre-deploy smoke test: the Jellyfin player itself.

The rest of the suite never opens the player, which is exactly how two
regressions reached a browser with a green build and 10/10 passing:

  * a deleted `let preparing` left a bare `preparing = false`, which Vite
    happily compiles as a global assignment — every playback threw before
    `player.src()`;
  * the client-side subtitle renderer got `workerUrl: undefined` from a
    double-unwrapped `.default`, so every ASS release silently fell back to
    WebVTT — losing the exact fidelity the integration existed for. Nothing
    failed loudly; it just quietly stopped doing its job.

That renderer is gone: Jellyfin burns subtitles into the video now, which
means they are pixels and can finally be *seen* by a test rather than
inferred from a canvas nothing could read. Step 8 compares the same frames
with subtitles on and off; step 9 covers the stream restart that a quality
or track change costs.

So this drives the real thing: pop-up → Watch → playing, and asserts the
parts that can regress silently.

Skips itself when Jellyfin is unconfigured, or when nothing in the current
season is actually in the library.

Usage:
  py -3.13 -u tools/tests/test_player.py [--backend ...] [--frontend ...]
"""
import argparse
import atexit
import sys
import time
from datetime import date

import requests
from playwright.sync_api import sync_playwright

TOTAL = 10
# Rendered geometry of the played section, as a fraction of the seek bar.
# Never `style.width`: that is the inline value video.js writes, which a CSS
# `!important` rule overrides without erasing — reading it reports the bar as
# empty when it is visibly full.
BAR_FRACTION = """() => {
    const holder = document.querySelector('.vjs-progress-holder');
    const play = document.querySelector('.vjs-play-progress');
    const w = holder ? holder.getBoundingClientRect().width : 0;
    return (w && play) ? play.getBoundingClientRect().width / w : 0;
}"""
USERNAME = "player_test_fixture"
PASSWORD = "player_pw_123"


ONLY: set[int] | None = None


def want(n: int) -> bool:
    """Should this optional assertion step run?"""
    return ONLY is None or n in ONLY


# Sessions started during the run, stopped on the way out.
#
# `fail()` exits via SystemExit, so a failing run never reached the stop call at
# the end of a step — and the browser being torn down does not give the player's
# onDestroy a chance to send one either. Every mutation-audit row is a
# deliberately failing run, so each one used to leave an ffmpeg encoding the
# rest of the episode. atexit covers the normal path and SystemExit alike.
_started_sessions: set[str] = set()


def _stop_started_sessions() -> None:
    for sid in list(_started_sessions):
        try:
            requests.post(f"{_BACKEND[0]}/api/jellyfin/playback/stop",
                          headers=_AUTH[0], json={"playSessionId": sid}, timeout=10)
        except Exception:
            pass
    _started_sessions.clear()


_BACKEND = [""]
_AUTH = [{}]
atexit.register(_stop_started_sessions)


def watch_sessions(page) -> None:
    """Record every playSessionId the page is handed, so it can be stopped."""
    def on_response(resp):
        if "/api/jellyfin/playback/" in resp.url and resp.request.method == "GET":
            try:
                sid = resp.json().get("playSessionId")
            except Exception:
                return
            if sid:
                _started_sessions.add(sid)
    page.on("response", on_response)


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
    # Each assertion step that switches stream costs a real transcode, so the
    # mutation audit runs only the step guarding the invariant it broke rather
    # than the whole file. Setup steps (1,2,3,5) always run — nothing works
    # without them — and the teardown always stops the session.
    parser.add_argument("--only-steps", default="",
                        help="comma-separated assertion steps to run, e.g. 9")
    args = parser.parse_args()
    global ONLY
    ONLY = {int(x) for x in args.only_steps.split(",") if x.strip()} or None
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    backend, frontend = args.backend.rstrip("/"), args.frontend.rstrip("/")
    _BACKEND[0] = backend
    season, year = current_season_year()
    print(f"Player smoke test — {frontend} ({season} {year})", flush=True)

    step(1, f"auth as {USERNAME} and check Jellyfin is configured")
    token = auth_token(backend)
    auth = {"Authorization": f"Bearer {token}"}
    _AUTH[0] = auth
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
        watch_sessions(page)

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
        if want(4):
         step(4, "pop-up pre-warmed the player before Watch was pressed")
         page.wait_for_timeout(2500)
         # With subtitles burned in there is nothing client-side left to warm —
         # no wasm, no fonts, no subtitle body. What the pop-up buys is the
         # PlaybackInfo round trip, and the assertion is now also that the
         # deleted stack has stayed deleted: a stray jassub or /attachments
         # request means the old path crept back in.
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
         if not warmed["playback"]:
             fail(4, f"PlaybackInfo was not pre-warmed before the click — seen={warmed['seen']}")
         if warmed["libass"] or warmed["attachments"]:
             fail(4, f"client-side subtitle rendering is back: jassub={warmed['libass']} "
                     f"attachments={warmed['attachments']} — subtitles are burned in server-side")
         step(4, f"PASS — pre-warmed {warmed['playback']} PlaybackInfo call(s), "
                 f"no libass/fonts, no stream started")

         # Pre-starting the stream is deliberately NOT done: Jellyfin's ffmpeg
         # writes segments until the file is done regardless of the playhead,
         # so an abandoned pop-up would remux a whole episode to disk.
         if page.evaluate("() => performance.getEntriesByType('resource')"
                          ".filter(e => /jellyfin\\/stream/.test(e.name)).length"):
             fail(4, "the stream was started before Watch was pressed")

        # ── 5  Playback actually starts ──
        #
        # NOT gated by want(): this opens the player, and every step after it
        # operates on the player it creates. It used to sit inside the want(4)
        # block, so `--only-steps 9` skipped it and step 9 then dereferenced a
        # `.video-js` that did not exist — the run died on
        # `Cannot read properties of null (reading 'player')` before reaching a
        # single assertion. The mutation audit reads that as "no FAIL line" and
        # reports a coverage hole, so all five player rows were auditing
        # nothing while looking like real failures.
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

        # Segment requests are how we know a *new* stream actually started;
        # `readyState` alone recovers while the old buffer is still playing.
        #
        # Installed here, not inside a want() block. It used to sit at the tail
        # of step 7, so `--only-steps 8` left `segments` undefined and step 8
        # died on UnboundLocalError before asserting anything — the same shape
        # of bug as step 5 being nested under want(4). Anything later steps
        # depend on has to be established on the unconditional path.
        segments: list[str] = []
        page.on("request", lambda r: segments.append(r.url)
                if "/hls1/" in r.url else None)

        if want(6):
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

        if want(7):
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

        if want(8):
         step(8, "subtitles are burned into the picture, and Off removes them")
         # This is the check that could not exist before. libass painted into a
         # canvas it transferred to a worker, so nothing could read the pixels —
         # which is exactly how a renderer that drew *empty frames* passed a
         # "canvas is correctly sized" assertion. Burned-in subtitles are part of
         # the video, so the same frame can simply be compared with them on and
         # off. MSE blobs are same-origin, so the canvas is readable.
         grab = """async (times) => {
             const v = document.querySelector('video');
             const c = document.createElement('canvas');
             const W = 320, H = 180, TOP = Math.floor(H * 0.62);   // subtitle band
             c.width = W; c.height = H;
             const ctx = c.getContext('2d', { willReadFrequently: true });
             const out = [];
             for (const t of times) {
                 v.pause();
                 await new Promise(r => {
                     const h = () => { v.removeEventListener('seeked', h); r(); };
                     v.addEventListener('seeked', h);
                     v.currentTime = t;
                 });
                 // A seek resolves before the new frame is painted; give the
                 // decoder a moment or every sample is the previous picture.
                 await new Promise(r => setTimeout(r, 1200));
                 ctx.drawImage(v, 0, 0, W, H);
                 out.push(Array.from(ctx.getImageData(0, TOP, W, H - TOP).data));
             }
             return out;
         }"""
         # Spread the samples across the episode rather than clustering them
         # early: nothing guarantees dialogue at any particular second, and the
         # first run drew two of five samples from silent stretches.
         duration = page.evaluate("() => document.querySelector('video').duration") or 1400
         span = min(duration * 0.85, 1400)
         SAMPLE_TIMES = [round(60 + i * (span - 60) / 11) for i in range(12)]
         with_subs = page.evaluate(grab, SAMPLE_TIMES)

         # Turn subtitles off through the menu, which restarts the stream.
         page.mouse.move(700, 450)
         page.mouse.move(700, 860)
         page.wait_for_timeout(400)
         page.click(".vjs-subtitles-button")
         page.wait_for_timeout(400)
         items = page.query_selector_all(".vjs-subtitles-button .vjs-menu-item")
         off = next((i for i in items
                     if i.inner_text().strip().lower().startswith("off")), None)
         if off is None:
             fail(8, "the subtitle menu has no Off entry")
         seg_before = len(segments)
         off.click()
         try:
             page.wait_for_function(
                 "() => { const v = document.querySelector('video');"
                 " return v && v.readyState >= 2 && v.videoWidth > 0; }", timeout=60_000)
         except Exception:
             fail(8, "the stream never came back after turning subtitles off")
         # Wait for the *new* stream, not merely a playable element. `readyState`
         # goes back above 2 while the old buffer is still being served, so
         # sampling here compares the subtitled stream against itself and reports
         # "not being burned in" — a false failure that got worse under load and
         # masked every assertion after it.
         deadline = time.time() + 90
         while len(segments) < seg_before + 2 and time.time() < deadline:
             page.wait_for_timeout(500)
         if len(segments) < seg_before + 2:
             fail(8, f"no new stream segments arrived after turning subtitles off "
                     f"({len(segments) - seg_before} in 90s) — the switch never took "
                     f"effect, so comparing frames would compare the stream to itself")
         page.wait_for_timeout(3000)
         without = page.evaluate(grab, SAMPLE_TIMES)

         def band_delta(a: list[int], b: list[int]) -> float:
             """Share of pixels that changed materially between two frames."""
             n = min(len(a), len(b)) // 4
             changed = sum(
                 1 for i in range(n)
                 if abs(a[4 * i] - b[4 * i]) + abs(a[4 * i + 1] - b[4 * i + 1])
                 + abs(a[4 * i + 2] - b[4 * i + 2]) > 90
             )
             return changed / n if n else 0.0

         deltas = [band_delta(x, y) for x, y in zip(with_subs, without)]
         report = ", ".join(f"{t}s:{d * 100:.1f}%" for t, d in zip(SAMPLE_TIMES, deltas))
         # Measured on this library rather than guessed: a band holding a line of
         # dialogue moves 1-4% of its pixels, and a band with no subtitle moves
         # 0.0% — the two encodes agree exactly where nothing was drawn. So the
         # threshold sits well above the noise floor, and the requirement is two
         # independent hits so one bright scene change cannot carry the test.
         HIT = 0.01
         hits = sum(d >= HIT for d in deltas)
         if hits < 2:
             fail(8, f"only {hits} of {len(deltas)} sampled frames changed when "
                     f"subtitles were turned off — they are not being burned in: {report}")
         step(8, f"PASS — subtitle band changed on {hits}/{len(deltas)} sampled "
                 f"frames ({report})")

        if want(9):
         step(9, "the quality menu switches the stream to a smaller picture")
         # The burned-in path costs a stream restart per change, so this is also
         # the regression test for the two bugs that made it a no-op: a restart
         # that re-requested the *old* quality, and a stall watchdog that fired
         # during the deliberate rebuild and restarted on top of it.
         restarts: list[str] = []
         page.on("console", lambda m: restarts.append(m.text)
                 if "restarting stream" in m.text else None)
         # A rebuild abandons a session whose ffmpeg would otherwise keep writing
         # the whole episode to the transcode cache, so the old one must be told
         # to stop. Closing the modal only ever stopped the current session.
         stops_mid: list[str] = []
         page.on("request", lambda r: stops_mid.append(r.url)
                 if "playback/stop" in r.url else None)
         # `player.src()` clears `vjs-has-started`, which is video.js's cue to put
         # its big play button back over a video that is already being restarted
         # for the viewer. Sampled across the whole switch rather than checked
         # once, because it is a transient flash.
         page.evaluate("""() => {
             window.__bigPlayHits = [];
             const tick = () => {
                 const root = document.querySelector('.video-js');
                 const b = root?.querySelector('.vjs-big-play-button');
                 if (b) {
                     const s = getComputedStyle(b);
                     if (s.display !== 'none' && s.visibility !== 'hidden' && +s.opacity > 0.01
                         && window.__bigPlayHits.length < 4) {
                         window.__bigPlayHits.push({ t: Math.round(performance.now()),
                             display: s.display, visibility: s.visibility, opacity: s.opacity,
                             root: root.className, btn: b.className });
                     }
                 }
                 if (!window.__bigPlayStop) requestAnimationFrame(tick);
             };
             tick();
         }""")
         # Pausing here is about the seek bar, not the play button: it holds the
         # playhead still so `bar_before` is a stable reading to compare against.
         #
         # It used to be described as what provoked the AbortError too. It isn't
         # — `play()` runs inside `one('loadedmetadata')` after a `currentTime()`
         # seek, so a pause this far upstream interrupts nothing. The rejection
         # is stubbed in explicitly below; relying on it happening by itself left
         # the play-button assertion passing against a build with no guard at all.
         # Seek well in first, so the played bar is wide enough for a collapse
         # to be measurable. Step 8 used to leave the playhead deep in the
         # episode; now that steps can run in isolation this cannot rely on
         # that, and at ~10s in the bar is under 1% — below the threshold, so
         # the seek-bar assertion would quietly skip itself.
         page.evaluate("() => document.querySelector('.video-js').player.currentTime(600)")
         page.wait_for_timeout(6000)
         page.evaluate("() => document.querySelector('.video-js').player.pause()")
         page.wait_for_timeout(600)
         # Where the played bar sits before the rebuild, measured as rendered
         # geometry — `style.width` is the inline value video.js writes, which a
         # CSS `!important` rule overrides without erasing.
         bar_before = page.evaluate(BAR_FRACTION)
         # Track the lowest the bar goes for the rest of the switch. Sampled per
         # animation frame because the collapse is transient — a 250ms poll
         # missed it entirely when this was first investigated.
         page.evaluate("""() => {
             window.__barMin = 1;
             const tick = () => {
                 const holder = document.querySelector('.vjs-progress-holder');
                 const play = document.querySelector('.vjs-play-progress');
                 const v = document.querySelector('video');
                 const w = holder?.getBoundingClientRect().width || 0;
                 // Only meaningful while the bar is on screen and the viewer is
                 // genuinely mid-episode; a hidden control bar has zero width.
                 if (w > 0 && play && v && v.currentTime > 5) {
                     const f = play.getBoundingClientRect().width / w;
                     if (f < window.__barMin) window.__barMin = f;
                 }
                 if (!window.__barStop) requestAnimationFrame(tick);
             };
             tick();
         }""")
         # Force the exact condition the guard exists for: the next play()
         # rejects with AbortError while playback carries on regardless.
         #
         # That is what an interrupted play *is* — the promise rejects, the video
         # resumes on its own — and the invariant is that it must not put a big
         # play button over a video that is already restarting. Waiting for it to
         # happen by itself does not work: `play()` is called inside
         # `one('loadedmetadata')` after a `currentTime()` seek, so nothing
         # interrupts it and the rejection never comes. The assertion below then
         # passes against a build with the guard removed entirely, which is
         # precisely what the mutation audit reported.
         #
         # The real play() is still called, so the rest of step 9 — decoding
         # frames, the resumed clock, the pinned bar — is unaffected.
         page.evaluate("""() => {
             const proto = HTMLMediaElement.prototype;
             const real = proto.play;
             let fired = false;
             proto.play = function () {
                 const p = real.apply(this, arguments);
                 if (fired) return p;
                 fired = true;
                 p?.catch?.(() => {});  // don't leave an unhandled rejection behind
                 return Promise.reject(
                     new DOMException('The play() request was interrupted', 'AbortError'));
             };
         }""")
         page.mouse.move(700, 450)
         page.mouse.move(700, 860)
         page.wait_for_timeout(400)
         page.click(".vjs-quality-button")
         page.wait_for_timeout(400)
         tiers = page.query_selector_all(".vjs-quality-button .vjs-menu-item")
         labels = [" ".join(t.inner_text().split()) for t in tiers]
         pick = next((t for t, l in zip(tiers, labels) if "480" in l), None)
         if pick is None:
             fail(9, f"no 480p entry in the quality menu: {labels}")
         pick.click()
         try:
             page.wait_for_function(
                 "() => document.querySelector('video')?.videoWidth === 854", timeout=60_000)
         except Exception:
             got = page.evaluate("() => document.querySelector('video')?.videoWidth")
             fail(9, f"selecting 480p left the picture at {got}px — the restart did "
                     f"not carry the new quality")
         # A quality change is one restart. Two means the watchdog joined in, and
         # the second rebuild races the first — which is how the tier silently
         # reverted while the menu showed the new one.
         page.wait_for_timeout(12_000)
         if len(restarts) != 1:
             fail(9, f"expected exactly 1 restart for a quality change, saw "
                     f"{len(restarts)}: {restarts}")
         playing = page.evaluate("""() => { const v = document.querySelector('video');
             window.__bigPlayStop = true;
             return { playing: !v.paused, w: v.videoWidth,
                      frames: v.getVideoPlaybackQuality().totalVideoFrames,
                      bigPlayHits: window.__bigPlayHits }; }""")
         if not playing["playing"] or playing["frames"] < 30:
             fail(9, f"playback did not resume after the quality change: {playing}")
         if playing["bigPlayHits"]:
             fail(9, "video.js's big play button flashed over the video during the "
                     "switch — it must only appear when play() is actually rejected: "
                     + "; ".join(f"display={h['display']} opacity={h['opacity']} "
                                 f"root=[{h['root']}]" for h in playing["bigPlayHits"][:2]))
         if not stops_mid:
             fail(9, "the abandoned session was never stopped — its ffmpeg keeps "
                     "writing the whole episode to Jellyfin's transcode cache")
         # The played section must stay where the viewer is while the stream is
         # rebuilt. `player.src()` resets the tech's clock to 0 and the bar
         # repaints from that before we can seek back, so without pinning it the
         # bar empties for seconds while the time readout stays correct — which
         # reads as "you lost your place" mid-switch.
         bar_min = page.evaluate("() => window.__barMin")
         if bar_before > 0.02 and (bar_min is None or bar_min < bar_before * 0.5):
             fail(9, f"the seek bar collapsed during the rebuild: it was at "
                     f"{bar_before * 100:.1f}% and fell to {(bar_min or 0) * 100:.1f}%, "
                     f"so a viewer mid-episode appears to have lost their place")
         step(9, f"PASS — 480p in one restart, {playing['w']}px and decoding "
                 f"({playing['frames']} frames), old session stopped, no play-button "
                 f"flash, seek bar held at {(bar_min or 0) * 100:.0f}%")

        # Always runs, even when steps are filtered: Escape is what tells
        # Jellyfin to tear the transcode down, and skipping it would leave an
        # ffmpeg writing out the rest of the episode after every targeted run.
        step(10, "Escape closes and stops the transcode; the episode reopens")
        stops: list[str] = []
        page.on("request", lambda r: stops.append(r.url)
                if "playback/stop" in r.url else None)
        page.keyboard.press("Escape")
        page.wait_for_timeout(2000)
        if page.locator("video").count():
            fail(10, "the player is still open after Escape")
        if not stops:
            fail(10, "closing did not tell Jellyfin to stop the transcode")

        # Reopening the SAME episode reuses a cached playbackInfo — including
        # the playSessionId we just told Jellyfin to tear down. It works, but
        # only because Jellyfin is lenient about it, so pin the behaviour.
        # Closing the player leaves the show pop-up open behind it, so the
        # Watch button is still there — no need to reselect the series.
        if not want(10):
            step(10, "PASS — closed and transcode stopped (reopen check not selected)")
            browser.close()
            print(f"Player: steps {sorted(ONLY or [])} passed — OK", flush=True)
            return
        watch2 = page.locator("button", has_text="Watch here (via Jellyfin)").first
        watch2.wait_for(timeout=30_000)
        watch2.click()
        try:
            page.wait_for_function(
                "() => { const v = document.querySelector('video');"
                " return v && v.currentTime > 0.2 && v.readyState >= 3; }",
                timeout=60_000)
        except Exception:
            fail(10, "reopening the same episode did not play (stale playSessionId?)")
        page.keyboard.press("Escape")
        page.wait_for_timeout(1500)
        step(10, "PASS — closed, transcode stopped, and the same episode reopens")

        browser.close()

    print(f"Player: {TOTAL}/{TOTAL} passed — OK", flush=True)


if __name__ == "__main__":
    try:
        main()
    except requests.RequestException as e:
        print(f"\nPlayer: FAIL — backend unreachable: {e}", flush=True)
        sys.exit(1)
