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
           libass/wasm/font work is placed against the stream wait.

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


def fonts_the_script_names(ass: str, attachments: list[dict]) -> list[dict]:
    """Mirror of fontsFor() in frontend/src/lib/jellyfinPrewarm.ts."""
    norm = lambda s: re.sub(r"[^a-z0-9]", "", s.strip().lstrip("@").lower())
    embedded = [a for a in attachments
                if re.search(r"font|otf|ttf", f"{a.get('mimeType')} {a.get('fileName')}", re.I)]
    names = set(re.findall(r"^Style:\s*[^,]+,\s*([^,]+),", ass, re.M))
    names |= set(re.findall(r"\\fn([^\\}]+)", ass))
    wanted = [w for w in (norm(x) for x in names) if w]
    if not wanted:
        return embedded
    stem = lambda a: norm(re.sub(r"\.[^.]+$", "", a["fileName"]))
    out: list[dict] = []
    for w in wanted:
        hits = [a for a in embedded if stem(a) == w] \
            or [a for a in embedded if stem(a).startswith(w) or w.startswith(stem(a))] \
            or [a for a in embedded if w in stem(a) or stem(a) in w]
        out += [a for a in hits if a not in out]
    return out or embedded


def stop_encodings(url: str, headers: dict, device: str) -> None:
    """
    Kill this run's ffmpeg before timing the next one.

    Jellyfin's transcoder races ahead writing the whole file regardless of the
    playhead, so leaving five of them running turns a startup benchmark into a
    measurement of the load the benchmark itself created — which is exactly what
    the first version of this script did.
    """
    try:
        req = urllib.request.Request(
            f"{url}/Videos/ActiveEncodings?deviceId={urllib.parse.quote(device)}",
            headers=headers, method="DELETE")
        urllib.request.urlopen(req, timeout=20).read()
    except Exception:
        pass


def bench_server(backend: str, token: str, auth: dict, ep: dict, n: int) -> Timer:
    t = Timer()
    url, key = jellyfin_config()
    jf_headers = {"Authorization": f'MediaBrowser Token="{key}"'}
    iid, msid = ep["itemId"], ep["mediaSourceId"]
    q = (f"mediaSourceId={urllib.parse.quote(msid)}&videoCodec=h264&audioCodec=aac"
         f"&container=ts&maxStreamingBitrate=120000000")

    for i in range(1, n + 1):
        # A new deviceId each run forces a cold session, which is what a viewer
        # pressing Watch actually gets.
        dev = f"bench{int(time.time()*1000)}"
        log(f"[run {i}/{n}] step 1/5: metadata")
        t.timed("proxy /playback (metadata+subs+fonts list)", lambda: requests.get(
            f"{backend}/api/jellyfin/playback/{iid}?mediaSourceId={urllib.parse.quote(msid)}",
            headers=auth, timeout=60))
        pb = requests.get(f"{backend}/api/jellyfin/playback/{iid}"
                          f"?mediaSourceId={urllib.parse.quote(msid)}",
                          headers=auth, timeout=60).json()

        log(f"[run {i}/{n}] step 2/5: subtitle track")
        subs = pb.get("subtitles", [])
        ass = next((s for s in subs if "ass" in (s.get("codec") or "").lower()), None)
        chosen = ass or (subs[0] if subs else None)
        ass_body = ""
        if chosen:
            fmt = "ass" if ass else "vtt"
            r, _ = t.timed(f"proxy /subtitles ({fmt})", lambda: requests.get(
                f"{backend}/api/jellyfin/subtitles", timeout=120,
                params={"itemId": iid, "mediaSourceId": msid, "index": chosen["index"],
                        "format": fmt, "token": token}))
            ass_body = r.content.decode("utf-8", "replace")

        log(f"[run {i}/{n}] step 3/5: fonts the script needs")
        # The fonts the app would actually send — not the first N attachments,
        # which would include the 23 MB Arial Unicode MS that fontsFor excludes
        # and so would measure a payload the player never requests.
        fonts = fonts_the_script_names(ass_body if ass else "", pb.get("attachments", []))
        f0 = time.perf_counter()
        fbytes = 0
        for a in fonts:
            r = requests.get(f"{backend}/api/jellyfin/attachments", timeout=90,
                             params={"itemId": iid, "mediaSourceId": msid,
                                     "index": a["index"], "token": token})
            fbytes += len(r.content)
        if fonts:
            t.record(f"proxy /attachments (x{len(fonts)})", time.perf_counter() - f0, fbytes)

        log(f"[run {i}/{n}] step 4/5: HLS through the SaltyChart proxy")
        base = f"{backend}/api/jellyfin/stream/Videos/{iid}"
        t.timed("proxy master.m3u8", lambda: requests.get(
            f"{base}/master.m3u8?{q}&deviceId={dev}&token={token}", timeout=120))
        t.timed("proxy main.m3u8", lambda: requests.get(
            f"{base}/main.m3u8?{q}&deviceId={dev}&token={token}", timeout=120))
        t.timed("proxy segment 0  <-- the wait", lambda: requests.get(
            f"{base}/hls1/main/0.ts?{q}&deviceId={dev}&token={token}"
            f"&runtimeTicks=0&actualSegmentLengthTicks=30000000", timeout=180))
        t.timed("proxy segment 1 (steady state)", lambda: requests.get(
            f"{base}/hls1/main/1.ts?{q}&deviceId={dev}&token={token}"
            f"&runtimeTicks=30000000&actualSegmentLengthTicks=30000000", timeout=180))

        log(f"[run {i}/{n}] step 5/5: same HLS directly from Jellyfin (isolates proxy cost)")
        dev2 = dev + "d"
        jbase = f"{url}/Videos/{iid}"
        t.timed("direct master.m3u8", lambda: requests.get(
            f"{jbase}/master.m3u8?{q}&deviceId={dev2}", headers=jf_headers, timeout=120))
        t.timed("direct segment 0", lambda: requests.get(
            f"{jbase}/hls1/main/0.ts?{q}&deviceId={dev2}"
            f"&runtimeTicks=0&actualSegmentLengthTicks=30000000",
            headers=jf_headers, timeout=180))

        # Tear both sessions down and let the disk settle, so the next run
        # measures a quiet server rather than this one's leftovers.
        stop_encodings(url, jf_headers, dev)
        stop_encodings(url, jf_headers, dev2)
        if i < n:
            log(f"[run {i}/{n}] stopped this run's encodings, settling 8s")
            time.sleep(8)
    return t


def bench_client(frontend: str, backend: str, token: str, ep: dict, n: int) -> list[dict]:
    """Browser timeline: Watch click -> decoding video, with libass placed against it."""
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
                  if (!m.libassCanvas && document.querySelector('canvas.JASSUB'))
                    m.libassCanvas = performance.now() - t0;
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
                f"(libass {round(marks.get('libassCanvas') or 0)}ms, "
                f"segment0 {marks.get('firstSegmentMs')}ms)")
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
                         ("libassCanvas", "libass canvas up"),
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
    seg = t.stats("proxy segment 0  <-- the wait")
    log(f"\nDone: segment 0 median {seg['med']:.1f}s ({seg['min']:.1f}-{seg['max']:.1f}s, "
        f"{seg['spread']:.1f}x spread) — written to {args.output}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except requests.RequestException as e:
        log(f"Done: backend unreachable — {e}")
        sys.exit(1)
