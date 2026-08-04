"""How much CPU does one playback actually cost, and for how long?

Plays ONE episode twice through the shipping proxy — once with an ASS track
burned in (the default when a viewer picks subtitles), once with subtitles off
(remux) — consuming HLS segments sequentially like a real player, and reads the
server's own per-process CPU from the mirrored syslog (memwatch, 5-min ticks).

Two numbers per condition:
  - transcode speed (x realtime): sequential segment consumption rate. This is
    the "whole core" question's other half — Jellyfin's ffmpeg runs UNTHROTTLED
    until the whole file is written (jellyfin#16608), so a fast burst and a
    sustained core are very different bills for the same watch.
  - ffmpeg / Jellyfin CPU from `memwatch: topcpu:` and `dockercpu:` lines that
    tick during the window.

Sequential consumption is load-bearing: requesting a far-ahead segment makes
Jellyfin REPOSITION the transcoder (that is how seeking works), which would
both corrupt the measurement and thrash the box. We fetch 0,1,2,... as they
become available, exactly like a player pulling as fast as it can.

Sessions are stopped by playSessionId, registered the moment they exist — see
the atexit note in run_condition.
"""
import argparse
import atexit
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from pathlib import Path

SYSLOG = Path("F:/Backup/CarlPlex/syslog/syslog.txt")


def log(msg: str) -> None:
    print(msg, flush=True)


def req_json(url: str, method="GET", body=None, token=None, timeout=60):
    r = urllib.request.Request(
        url, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json",
                 **({"Authorization": f"Bearer {token}"} if token else {})})
    with urllib.request.urlopen(r, timeout=timeout) as x:
        return json.loads(x.read())


def fetch(url: str, timeout=90) -> bytes:
    with urllib.request.urlopen(url, timeout=timeout) as x:
        return x.read()


def syslog_size() -> int:
    return SYSLOG.stat().st_size


def memwatch_since(offset: int) -> tuple[list[str], int]:
    """New memwatch lines past `offset`, plus the new offset."""
    size = SYSLOG.stat().st_size
    if size < offset:
        offset = 0  # rotated
    with SYSLOG.open("r", encoding="utf-8", errors="replace") as f:
        f.seek(offset)
        chunk = f.read()
    lines = [l.strip() for l in chunk.splitlines()
             if "memwatch: topcpu:" in l or "memwatch: dockercpu:" in l
             or "memwatch: cpu:" in l or "fastwatch: " in l]
    return lines, size


def stop_session(backend: str, token: str, psid: str) -> None:
    if not psid:
        return
    try:
        req_json(f"{backend}/api/jellyfin/playback/stop", method="POST",
                 body={"playSessionId": psid}, token=token, timeout=30)
    except Exception:
        pass


def follow(playlist_path: str, text: str) -> str | None:
    """First URI in a playlist, resolved against the playlist's own path —
    never the proxy root, or the 404 reads as an empty playlist (the full
    lesson is on bench_player.follow; this script relearned it once)."""
    for line in text.splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            return urllib.parse.urljoin(playlist_path, line)
    return None


def run_condition(label: str, backend: str, token: str, item: dict,
                  sub_index: int, cap_s: int) -> dict:
    q = (f"{backend}/api/jellyfin/playback/{item['itemId']}"
         f"?mediaSourceId={urllib.parse.quote(item['mediaSourceId'])}"
         f"&quality=auto&subtitleIndex={sub_index}")
    pb = req_json(q, token=token, timeout=60)
    psid = pb["playSessionId"]
    # Registered the moment the session exists — an exception anywhere below
    # would otherwise leave ffmpeg writing out the rest of a ~1.4 GB episode.
    # The first version of this script did exactly that.
    atexit.register(stop_session, backend, token, psid)
    turl = pb["transcodingUrl"]
    log(f"[{label}] session {psid[:8]}… subtitleIndex={sub_index}")

    # The stream lives under the proxy prefix; relative URIs resolve against
    # the UNPREFIXED playlist path, then get prefixed per request.
    prox = f"{backend}/api/jellyfin/stream"
    tok_q = lambda u: f"{prox}{u}{'&' if '?' in u else '?'}token={token}"
    master = fetch(tok_q(turl)).decode("utf-8", "replace")
    main_uri = follow(turl, master)
    if not main_uri:
        stop_session(backend, token, psid)
        raise RuntimeError(f"[{label}] master playlist named no rendition")
    main = fetch(tok_q(main_uri)).decode("utf-8", "replace")
    durs = [float(m) for m in re.findall(r"#EXTINF:([\d.]+)", main)]
    seg_uris = [urllib.parse.urljoin(main_uri, l.strip())
                for l in main.splitlines() if l.strip() and not l.startswith("#")]
    total_s = sum(durs)
    log(f"[{label}] {len(seg_uris)} segments, {total_s/60:.1f} min of content")

    syslog_off = syslog_size()
    ticks: list[str] = []
    t0 = time.time()
    consumed_s = 0.0
    consumed_b = 0
    last_report = 0.0
    done = 0
    try:
        for i, (uri, d) in enumerate(zip(seg_uris, durs)):
            data = fetch(tok_q(uri), timeout=120)  # blocks until ffmpeg produces it
            consumed_b += len(data)
            consumed_s += d
            done = i + 1
            el = time.time() - t0
            if el - last_report >= 15:
                last_report = el
                new, syslog_off = memwatch_since(syslog_off)
                ticks += new
                x = consumed_s / el if el else 0
                jf = [float(m.group(1)) for tk in ticks
                      for m in [re.search(r"fastwatch: dockercpu: Jellyfin=([\d.]+)%", tk)] if m]
                cur = f"{jf[-1]:.0f}%" if jf else "?"
                log(f"[{label}] t={el:5.0f}s  seg {done}/{len(seg_uris)}  "
                    f"{consumed_s/60:4.1f}min consumed  {x:4.1f}x realtime  "
                    f"{consumed_b/1e6:6.0f}MB  jf-cpu={cur} ({len(jf)} samples)")
            if time.time() - t0 > cap_s:
                log(f"[{label}] cap {cap_s}s reached at seg {done}/{len(seg_uris)}")
                break
    finally:
        stop_session(backend, token, psid)
        log(f"[{label}] session stopped")
    el = time.time() - t0
    new, syslog_off = memwatch_since(syslog_off)
    ticks += new
    return {"label": label, "elapsed": el, "consumed_s": consumed_s,
            "segments": done, "total_segments": len(seg_uris),
            "bytes": consumed_b, "speed": consumed_s / el if el else 0,
            "ticks": ticks}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend", default="http://localhost:3000")
    ap.add_argument("--title", default="Mebius Dust")
    ap.add_argument("--cap", type=int, default=660, help="max seconds per condition")
    args = ap.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    b = args.backend.rstrip("/")

    try:
        token = req_json(f"{b}/api/auth/login", "POST",
                         {"username": "jf_test_fixture", "password": "jf_pw_123"})["token"]
    except urllib.error.HTTPError:
        token = req_json(f"{b}/api/auth/signup", "POST",
                         {"username": "jf_test_fixture", "password": "jf_pw_123"})["token"]

    # Find the episode the suite always uses.
    from datetime import date
    season = ("WINTER", "SPRING", "SUMMER", "FALL")[(date.today().month - 1) // 3]
    shows = req_json(f"{b}/api/anime?season={season}&year={date.today().year}&format=TV", timeout=200)
    item = None
    for s in shows:
        titles = [t for t in (s.get("title") or {}).values() if t]
        if not any(args.title.lower() in t.lower() for t in titles):
            continue
        av = req_json(f"{b}/api/jellyfin/availability", "POST",
                      {"mediaId": s["id"], "titles": titles[:10]}, token=token, timeout=90)
        if av.get("available"):
            item = av
            break
    if not item:
        log(f"FAIL: '{args.title}' not available"); return 1
    pb = req_json(f"{b}/api/jellyfin/playback/{item['itemId']}?mediaSourceId={item['mediaSourceId']}",
                  token=token, timeout=60)
    ass = next((t for t in pb.get("subtitles", []) if t.get("codec") in ("ass", "ssa")), None)
    stop_session(b, token, pb["playSessionId"])
    if not ass:
        log("FAIL: no ASS track on this episode"); return 1
    log(f"episode: {item.get('libraryTitle')} S{item.get('seasonNumber')}E{item.get('episodeNumber')}"
        f" — ASS track index {ass['index']}")

    results = []
    for label, idx in [("A burn-in", ass["index"]), ("B remux  ", -1)]:
        results.append(run_condition(label, b, token, item, idx, args.cap))
        log(f"[{label}] cooling 75s so ffmpeg exits and a tick separates conditions")
        time.sleep(75)

    log("\n=== RESULTS ===")
    for r in results:
        log(f"{r['label']}: {r['consumed_s']/60:.1f} min of video in {r['elapsed']:.0f}s "
            f"= {r['speed']:.1f}x realtime  ({r['segments']}/{r['total_segments']} segs, {r['bytes']/1e6:.0f} MB)")
        for t in r["ticks"]:
            m = re.search(r"memwatch: (topcpu|dockercpu|cpu):.*$", t)
            if m: log(f"    {m.group(0)[:150]}")
    log("Done: transcode CPU benchmark complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
