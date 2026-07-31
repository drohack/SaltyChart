"""
Where does the time go between pressing Watch and seeing video?

One-off measurements kept disagreeing with each other — 1.7s, 2.4s, 11.4s for
the same code path — so this measures every stage repeatedly and reports the
spread rather than a single number. Variance turned out to be the story, and a
median alone hides it.

Two halves, because they fail differently:

  server   every HTTP stage the player depends on, timed through the SaltyChart
           proxy AND directly against Jellyfin, so the proxy's own cost is
           separated from the media server's.
  client   the browser timeline from the Watch click to a decoding video, so
           the app's own work is placed against the stream wait.

The stream shape is not invented here: it comes from the `transcodingUrl`
that `/api/jellyfin/playback` returns, and the manifests are followed the way a
player follows them. An earlier version hand-built `?videoCodec=h264&…`, which
by the end was measuring a stream the app no longer requests.

⚠ This starts REAL playback sessions, and Jellyfin's ffmpeg writes segments
until the whole file is done regardless of the playhead — its cleanup timers do
not keep up for remux jobs (jellyfin#16608). Each run therefore leaves most of a
~1.4 GB episode in the transcode cache; killing the encoder does not delete what
it already wrote. Nine runs filled the cache on a real server and made Jellyfin
return empty (HTTP 200, 0-byte) segments, which looks exactly like an app bug.
Keep `-n` small, and check free space on the transcode volume afterwards.

Usage:
  py -3.13 -u tools/bench_player.py [-n 5] [--no-browser] [--title "Mebius Dust"]
  py -3.13 -u tools/bench_player.py --output tools/benchmark_results.txt
"""
import argparse
import atexit
import json
import re
import sqlite3
import statistics
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parent.parent
SUITE = "player_startup"
USERNAME, PASSWORD = "jf_test_fixture", "jf_pw_123"


def log(msg: str) -> None:
    print(msg, flush=True)


class Timer:
    """Wall-clock around a request, recording bytes so MB/s is derivable."""

    def __init__(self):
        self.samples: dict[str, list[tuple[float, int]]] = {}

    def record(self, stage: str, seconds: float, size: int = 0) -> None:
        self.samples.setdefault(stage, []).append((seconds, size))

    def timed(self, stage: str, fn):
        t0 = time.perf_counter()
        out = fn()
        dt = time.perf_counter() - t0
        size = len(out.content) if hasattr(out, "content") else 0
        self.record(stage, dt, size)
        return out, dt

    def stats(self, stage: str) -> dict | None:
        vals = self.samples.get(stage)
        if not vals:
            return None
        times = [v[0] for v in vals]
        sizes = [v[1] for v in vals]
        return {
            "n": len(times), "min": min(times), "med": statistics.median(times),
            "max": max(times), "spread": max(times) / max(min(times), 1e-6),
            "mb": (sum(sizes) / len(sizes)) / 1048576,
        }


def season_year() -> tuple[str, int]:
    """The season the app is showing. Anime seasons, not month names."""
    from datetime import date
    today = date.today()
    return ("WINTER", "SPRING", "SUMMER", "FALL")[(today.month - 1) // 3], today.year


def jellyfin_config() -> tuple[str, str]:
    db = REPO / "backend" / "prisma" / "prisma" / "data.db"
    c = sqlite3.connect(db)
    cfg = dict(c.execute(
        "SELECT key,value FROM AppConfig WHERE key IN ('jellyfinUrl','jellyfinApiKey')").fetchall())
    return cfg["jellyfinUrl"].rstrip("/"), cfg["jellyfinApiKey"]


def login(backend: str) -> str:
    requests.post(f"{backend}/api/auth/signup",
                  json={"username": USERNAME, "password": PASSWORD}, timeout=10)
    r = requests.post(f"{backend}/api/auth/login",
                      json={"username": USERNAME, "password": PASSWORD}, timeout=10)
    r.raise_for_status()
    return r.json()["token"]


def pick_episode(backend: str, auth: dict, want: str | None) -> dict | None:
    from datetime import date
    today = date.today()
    season = ("WINTER", "SPRING", "SUMMER", "FALL")[(today.month - 1) // 3]
    shows = requests.get(f"{backend}/api/anime?season={season}&year={today.year}&format=TV",
                         timeout=180).json()
    log(f"-- scanning {season} {today.year} ({len(shows)} entries) for a playable episode --")
    for i, show in enumerate(shows, 1):
        titles = [t for t in (show.get("title") or {}).values() if t][:10]
        if not titles:
            continue
        if want and not any(want.lower() in t.lower() for t in titles):
            continue
        av = requests.post(f"{backend}/api/jellyfin/availability", headers=auth,
                           json={"mediaId": show["id"], "titles": titles}, timeout=90).json()
        if av.get("available") and av.get("itemId"):
            log(f"[{i}/{len(shows)}] using {titles[0][:40]!r}")
            return {"title": titles[0], "itemId": av["itemId"],
                    "mediaSourceId": av["mediaSourceId"], "mediaId": show["id"]}
    return None


def stop_session(backend: str, auth: dict, play_session_id: str) -> None:
    """
    Kill this run's ffmpeg before timing the next one.

    Jellyfin's transcoder races ahead writing the whole file regardless of the
    playhead, so leaving five of them running turns a startup benchmark into a
    measurement of the load the benchmark itself created — which is exactly what
    the first version of this script did.

    Torn down by playSessionId through the app's own endpoint, the way the
    player does it. Killing by deviceId would take out every SaltyChart encode
    on the server, including a real viewer's — the app and this bench now share
    one device id.
    """
    if not play_session_id:
        return
    try:
        requests.post(f"{backend}/api/jellyfin/playback/stop", headers=auth,
                      json={"playSessionId": play_session_id}, timeout=30)
    except Exception:
        pass


def follow(playlist_path: str, text: str) -> str | None:
    """
    The next thing a player fetches: the first non-comment URI in an HLS
    playlist, resolved against the playlist's own location.

    The resolution is the point. Jellyfin writes these as bare relative URIs
    ("main.m3u8?…", "hls1/main/0.ts?…"), so joining them to the proxy root
    instead of to the playlist's directory produces a 404 that looks like an
    empty playlist.
    """
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return urllib.parse.urljoin(playlist_path, line)
    return None


def bench_server(backend: str, token: str, auth: dict, ep: dict, n: int) -> Timer:
    t = Timer()
    url, key = jellyfin_config()
    jf_headers = {"Authorization": f'MediaBrowser Token="{key}"'}
    iid, msid = ep["itemId"], ep["mediaSourceId"]

    for i in range(1, n + 1):
        log(f"[run {i}/{n}] step 1/4: metadata")
        # Every /playback call opens a fresh session, which is what a viewer
        # pressing Watch gets. The response also names the stream to play, so
        # nothing below is hand-assembled.
        pb_res, _ = t.timed("proxy /playback (metadata)", lambda: requests.get(
            f"{backend}/api/jellyfin/playback/{iid}?mediaSourceId={urllib.parse.quote(msid)}",
            headers=auth, timeout=60))
        pb = pb_res.json()
        psid = pb.get("playSessionId", "")
        # Registered the moment the session exists, not only at the end of the
        # loop. This script starts real encodes, and an exception between here
        # and the teardown below would leave ffmpeg writing out the rest of a
        # ~1.4 GB episode — which is how the transcode cache filled once before.
        atexit.register(stop_session, backend, auth, psid)
        turl = pb.get("transcodingUrl") or ""
        if not turl:
            log("  no transcodingUrl — Jellyfin refused the profile; skipping this run")
            continue

        log(f"[run {i}/{n}] step 2/4: HLS through the SaltyChart proxy")
        prox = f"{backend}/api/jellyfin/stream"
        sep = "&" if "?" in turl else "?"
        tok_q = lambda u: f"{prox}{u}{'&' if '?' in u else '?'}token={token}"
        master_res, _ = t.timed("proxy master.m3u8",
                                lambda: requests.get(tok_q(turl), timeout=120))
        main_uri = follow(turl, master_res.text)
        if not main_uri:
            log("  master playlist named no rendition; skipping this run")
            stop_session(backend, auth, psid)
            continue
        main_res, _ = t.timed("proxy main.m3u8",
                              lambda: requests.get(tok_q(main_uri), timeout=120))
        seg0 = follow(main_uri, main_res.text)
        if seg0:
            t.timed("proxy segment 0  <-- the wait",
                    lambda: requests.get(tok_q(seg0), timeout=180))
            seg1 = seg0.replace("/0.ts", "/1.ts", 1)
            if seg1 != seg0:
                t.timed("proxy segment 1 (steady state)",
                        lambda: requests.get(tok_q(seg1), timeout=180))
        else:
            log("  rendition playlist named no segment; the wait was not measured")

        log(f"[run {i}/{n}] step 3/4: the same stream straight from Jellyfin")
        # Same URL, no proxy — so the proxy's own cost is separable. A second
        # session, torn down alongside the first.
        pb2 = requests.get(f"{backend}/api/jellyfin/playback/{iid}"
                           f"?mediaSourceId={urllib.parse.quote(msid)}",
                           headers=auth, timeout=60).json()
        psid2, turl2 = pb2.get("playSessionId", ""), pb2.get("transcodingUrl") or ""
        if turl2:
            atexit.register(stop_session, backend, auth, psid2)
            dmaster, _ = t.timed("direct master.m3u8", lambda: requests.get(
                f"{url}{turl2}", headers=jf_headers, timeout=120))
            dmain_uri = follow(turl2, dmaster.text)
            if dmain_uri:
                dmain = requests.get(f"{url}{dmain_uri}", headers=jf_headers, timeout=120)
                dseg = follow(dmain_uri, dmain.text)
                if dseg:
                    t.timed("direct segment 0", lambda: requests.get(
                        f"{url}{dseg}", headers=jf_headers, timeout=180))

        log(f"[run {i}/{n}] step 4/4: tearing this run's encodings down")
        stop_session(backend, auth, psid)
        stop_session(backend, auth, psid2)
        if i < n:
            log(f"[run {i}/{n}] stopped this run's encodings, settling 8s")
            time.sleep(8)
    return t


def bench_client(frontend: str, backend: str, token: str, ep: dict, n: int) -> list[dict]:
    """Browser timeline: Watch click -> decoding video.

    Subtitles are burned into the picture server-side, so there is no renderer,
    wasm or font fetch left to place against the stream wait — what remains is
    the player chunk and the stream itself.
    """
    from playwright.sync_api import sync_playwright

    season, year = season_year()
    r = requests.put(f"{backend}/api/list", timeout=30,
                     headers={"Authorization": f"Bearer {token}"},
                     json={"season": season, "year": year, "items": [ep["mediaId"]]})
    if r.status_code != 200:
        log(f"  could not seed the list ({r.status_code} {r.text[:80]}) — client bench will skip")
    runs = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.goto(frontend)
        page.evaluate("([t,u])=>{localStorage.setItem('token',t);localStorage.setItem('username',u)}",
                      [token, USERNAME])
        for i in range(1, n + 1):
            log(f"[client {i}/{n}] opening the player and timing each stage")
            page.goto(f"{frontend}/random")
            page.wait_for_timeout(3000)
            # The page defaults to the look-ahead season, which is not the one
            # the list was seeded for — without this the show is never on screen.
            btn = page.locator(f"button:text-is('{season.capitalize()}')")
            if btn.count():
                btn.first.click()
                page.wait_for_timeout(3000)
            marks = page.evaluate("""async (title) => {
                const li = [...document.querySelectorAll('li')]
                  .find(e => e.textContent.includes(title) && !e.closest('svg'));
                if (!li) return { err: 'not in list' };
                li.click();
                let btn = null;
                for (let i = 0; i < 60 && !btn; i++) {
                  btn = [...document.querySelectorAll('button')]
                    .find(x => /Watch here/i.test(x.textContent));
                  if (!btn) await new Promise(r => setTimeout(r, 300));
                }
                if (!btn) return { err: 'no watch button' };
                await new Promise(r => setTimeout(r, 3000)); // let the pop-up pre-warm finish
                const t0 = performance.now();
                btn.click();
                const m = { };
                for (let i = 0; i < 1200; i++) {
                  const v = document.querySelector('video');
                  if (v && !m.videoEl) m.videoEl = performance.now() - t0;
                  if (v && !m.metadata && v.readyState >= 1) m.metadata = performance.now() - t0;
                  if (v && !m.canPlay && v.readyState >= 3) m.canPlay = performance.now() - t0;
                  if (v && v.currentTime > 0.2 && v.readyState >= 3) {
                    m.playing = performance.now() - t0; break;
                  }
                  await new Promise(r => setTimeout(r, 25));
                }
                const res = performance.getEntriesByType('resource')
                  .filter(e => /jellyfin\\/stream/.test(e.name))
                  .map(e => ({ n: e.name.replace(/.*\\/stream\\/Videos\\/[^/]+\\//,'').replace(/\\?.*/,''),
                               ms: Math.round(e.duration) }));
                m.firstSegmentMs = res.find(r => /0\\.ts/.test(r.n))?.ms ?? null;
                m.manifestMs = res.find(r => /m3u8/.test(r.n))?.ms ?? null;
                window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
                return m;
            }""", ep["title"][:24])
            if marks.get("err"):
                log(f"[client {i}/{n}] SKIP — {marks['err']}")
                continue
            runs.append(marks)
            log(f"[client {i}/{n}] playing at {round(marks.get('playing') or 0)}ms "
                f"(segment0 {marks.get('firstSegmentMs')}ms)")
            page.wait_for_timeout(2500)
        browser.close()
    return runs


def render(t: Timer, client: list[dict], ep: dict) -> str:
    out: list[str] = []
    add = out.append
    add(f"episode: {ep['title']}  (itemId {ep['itemId'][:12]}…)")
    add("")
    add("SERVER STAGES              n     min      med      max   spread    size")
    add("-" * 74)
    for stage in t.samples:
        s = t.stats(stage)
        add(f"{stage:<26} {s['n']:>2}  {s['min']:>6.2f}s  {s['med']:>6.2f}s  "
            f"{s['max']:>6.2f}s  {s['spread']:>5.1f}x  {s['mb']:>6.1f}MB")
    if client:
        add("")
        add("CLIENT TIMELINE (ms from the Watch click)")
        add("-" * 74)
        for k, label in [("videoEl", "player element created"),
                         ("metadata", "video metadata"),
                         ("canPlay", "enough data to play"),
                         ("playing", "actually decoding")]:
            vals = [r[k] for r in client if r.get(k) is not None]
            if vals:
                add(f"  {label:<26} min {min(vals):>7.0f}  med {statistics.median(vals):>7.0f}  "
                    f"max {max(vals):>7.0f}")
        seg = [r["firstSegmentMs"] for r in client if r.get("firstSegmentMs")]
        if seg:
            add(f"  {'first segment (browser)':<26} min {min(seg):>7.0f}  "
                f"med {statistics.median(seg):>7.0f}  max {max(seg):>7.0f}")
    return "\n".join(out)


def write_suite(path: Path, body: str) -> None:
    """
    Delegate to the existing writer in benchmark_whisper_settings.py.

    The consolidated results file is header-delimited with no end markers, and
    that module already knows how to parse and rewrite it. Re-implementing the
    format here would silently produce a second, incompatible convention in the
    same file.
    """
    sys.path.insert(0, str(REPO / "tools"))
    from benchmark_whisper_settings import write_result_section

    write_result_section(str(path), SUITE, body)


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--backend", default="http://localhost:3000")
    p.add_argument("--frontend", default="http://localhost:5173")
    p.add_argument("-n", "--iterations", type=int, default=5)
    p.add_argument("--title", help="substring of the series to benchmark")
    p.add_argument("--no-browser", action="store_true")
    p.add_argument("--output", default=str(REPO / "tools" / "benchmark_results.txt"))
    args = p.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    backend = args.backend.rstrip("/")
    token = login(backend)
    auth = {"Authorization": f"Bearer {token}"}
    ep = pick_episode(backend, auth, args.title)
    if not ep:
        log("Done: no playable episode found")
        return 1

    log(f"-- server stages, {args.iterations} cold runs --")
    t = bench_server(backend, token, auth, ep, args.iterations)

    client: list[dict] = []
    if not args.no_browser:
        log(f"-- client timeline, {args.iterations} runs --")
        try:
            client = bench_client(args.frontend, backend, token, ep, args.iterations)
        except Exception as e:
            log(f"client bench skipped: {e}")

    body = render(t, client, ep)
    print("\n" + body, flush=True)
    write_suite(Path(args.output), body)
    # The headline number is the only stage that ever really varies. If it was
    # never measured, say so rather than dying on a missing key — a benchmark
    # that crashes at the finish line loses the run it just spent minutes on.
    seg = t.stats("proxy segment 0  <-- the wait")
    if seg:
        log(f"\nDone: segment 0 median {seg['med']:.1f}s ({seg['min']:.1f}-{seg['max']:.1f}s, "
            f"{seg['spread']:.1f}x spread) — written to {args.output}")
    else:
        log(f"\nDone: segment 0 was never measured — written to {args.output}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except requests.RequestException as e:
        log(f"Done: backend unreachable — {e}")
        sys.exit(1)
