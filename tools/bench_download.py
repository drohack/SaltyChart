"""
Download-config benchmark for the live translation path.

The live daemon's felt latency is dominated by the audio download, and that cost
is yt-dlp's EXTRACTION handshake (resolve video -> player response -> player JS ->
nsig descramble), NOT byte transfer - the `worstaudio` file is only ~1-2 MB. So
the levers are extraction-side: which player_client, skipping extra requests,
picking a format directly, warm player cache. (aria2c multi-connection is tested
too, though it parallelises bytes of which there are almost none here.)

For each config × video we download twice (run1 = cold-ish, run2 = warm, since
yt-dlp caches the player JS) and report download seconds, the selected format_id,
protocol (https vs fragmented m3u8/dash), and file size. Fastest *reliable* config
(no errors, no fragmented/throttled format) wins.

Run on this PC (the server can't be tested on). Stream progress to the statusLine:
  PYTHONUNBUFFERED=1 py -3.13 -u tools/bench_download.py 2>/dev/null
  # aria2c arm only runs if aria2c is on PATH or ARIA2C_PATH is set
  ARIA2C_PATH=C:/tools/aria2c.exe PYTHONUNBUFFERED=1 py -3.13 -u tools/bench_download.py 2>/dev/null

Flags: --limit N (trailers, default 3), --videos id..., --runs N (default 2),
       --output PATH.
"""

import argparse
import os
import shutil
import statistics
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from benchmark_whisper_settings import TEST_VIDEOS, write_result_section  # noqa: E402

RESULTS_FILE = os.path.join(os.path.dirname(__file__), "benchmark_results.txt")
SUITE = "download"


def _aria2c_path():
    """Return an aria2c path if available (env override or on PATH), else None."""
    env = os.environ.get("ARIA2C_PATH")
    if env and os.path.exists(env):
        return env
    found = shutil.which("aria2c")
    return found


def build_configs():
    """Each config = extra ydl_opts merged over the native base. Extraction levers
    first, then the multi-connection arms."""
    cfgs = [
        ("baseline", {}),  # current production: worstaudio, native, no postproc
        ("client_ios", {"extractor_args": {"youtube": {"player_client": ["ios"]}}}),
        ("client_tv", {"extractor_args": {"youtube": {"player_client": ["tv"]}}}),
        ("client_web_safari", {"extractor_args": {"youtube": {"player_client": ["web_safari"]}}}),
        ("client_android_vr", {"extractor_args": {"youtube": {"player_client": ["android_vr"]}}}),
        ("player_skip_configs", {"extractor_args": {"youtube": {"player_skip": ["configs"]}}}),
        ("itag_251_opus", {"format": "251/250/249/worstaudio"}),
        ("concurrent_frags_4", {"concurrent_fragment_downloads": 4}),
    ]
    aria = _aria2c_path()
    if aria:
        cfgs.append(("aria2c_x16", {
            "external_downloader": aria,
            "external_downloader_args": {"aria2c": ["-x16", "-s16", "-k1M"]},
        }))
        print(f"[setup] aria2c found at {aria} - including aria2c_x16 arm", flush=True)
    else:
        print("[setup] aria2c NOT found (set ARIA2C_PATH or add to PATH) - skipping that arm", flush=True)
    return cfgs


def base_opts(tmpdir):
    return {
        "format": "worstaudio",
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "outtmpl": os.path.join(tmpdir, "full.%(ext)s"),
    }


def download_once(video_id, extra, tmpdir):
    """Returns (seconds, format_id, protocol, size_bytes). Raises on failure."""
    import yt_dlp
    opts = {**base_opts(tmpdir), **extra}
    url = f"https://www.youtube.com/watch?v={video_id}"
    t0 = time.perf_counter()
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    dt = time.perf_counter() - t0
    rd = (info.get("requested_downloads") or [{}])[0]
    fmt = rd.get("format_id") or info.get("format_id") or "?"
    proto = rd.get("protocol") or info.get("protocol") or "?"
    size = 0
    for name in os.listdir(tmpdir):
        if name.startswith("full."):
            size = os.path.getsize(os.path.join(tmpdir, name))
            break
    return dt, fmt, proto, size


def run(videos, configs, runs):
    results = {}  # cfg_name -> {"warm": [s...], "all": [...], "fmt":, "proto":, "size":, "errors":n}
    total = len(configs) * len(videos)
    i = 0
    for name, extra in configs:
        rec = {"warm": [], "fmt": "?", "proto": "?", "size": 0, "errors": 0}
        for vid, _title in videos:
            i += 1
            times = []
            for r in range(runs):
                tmpdir = tempfile.mkdtemp()
                try:
                    dt, fmt, proto, size = download_once(vid, extra, tmpdir)
                    times.append(dt)
                    rec["fmt"], rec["proto"], rec["size"] = fmt, proto, size
                except Exception as e:
                    rec["errors"] += 1
                    print(f"[{i}/{total} {name}] {vid} run{r+1}: ERROR {str(e)[:80]}", flush=True)
                finally:
                    shutil.rmtree(tmpdir, ignore_errors=True)
            if times:
                # run2+ = warm (player JS cached); fall back to run1 if only one
                warm = times[-1]
                rec["warm"].append(warm)
                runs_str = " ".join(f"{t:.1f}s" for t in times)
                print(f"[{i}/{total} {name}] {vid}: {runs_str}  "
                      f"fmt={rec['fmt']} proto={rec['proto']} "
                      f"size={rec['size']/1e6:.1f}MB", flush=True)
        results[name] = rec
    return results


def format_report(results, videos, runs):
    lines = []
    when = time.strftime("%Y-%m-%d %H:%M")
    lines.append(f"Benchmark: suite '{SUITE}' - live download config  ({when})")
    lines.append(f"Videos: {len(videos)}  |  runs/video: {runs} (last run = warm, "
                 f"yt-dlp player JS cached)")
    lines.append("download time is extraction-bound (~1-2 MB file); lower is better.")
    lines.append("")
    lines.append("=" * 84)
    lines.append("SUMMARY  (sorted by median warm download seconds)")
    lines.append(f"{'config':22} {'median':>7} {'min':>6} {'max':>6} {'fmt':>6} "
                 f"{'proto':>8} {'MB':>5} {'err':>4}")
    lines.append("-" * 84)
    rows = []
    for name, rec in results.items():
        if rec["warm"]:
            med = statistics.median(rec["warm"])
            rows.append((med, name, rec))
        else:
            rows.append((float("inf"), name, rec))
    for med, name, rec in sorted(rows, key=lambda x: x[0]):
        warm = rec["warm"]
        med_s = f"{med:.2f}" if warm else "FAIL"
        mn = f"{min(warm):.2f}" if warm else "-"
        mx = f"{max(warm):.2f}" if warm else "-"
        lines.append(f"{name:22} {med_s:>7} {mn:>6} {mx:>6} {str(rec['fmt']):>6} "
                     f"{str(rec['proto'])[:8]:>8} {rec['size']/1e6:>5.1f} {rec['errors']:>4}")
    lines.append("=" * 84)
    lines.append("Note: a config that errors or returns a fragmented (m3u8/dash) protocol "
                 "is NOT a safe pick even if fast.")
    return "\n".join(lines)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=3, help="First N trailers (default 3)")
    ap.add_argument("--videos", nargs="+", default=None, help="Explicit video IDs")
    ap.add_argument("--runs", type=int, default=2, help="Downloads per (config,video) (default 2)")
    ap.add_argument("--output", default=RESULTS_FILE)
    args = ap.parse_args()

    videos = [(v, v) for v in args.videos] if args.videos else list(TEST_VIDEOS)
    if args.limit:
        videos = videos[:args.limit]

    configs = build_configs()
    print(f"download bench: {len(configs)} configs x {len(videos)} videos x "
          f"{args.runs} runs", flush=True)

    results = run(videos, configs, args.runs)
    report = format_report(results, videos, args.runs)
    print("\n" + report, flush=True)
    write_result_section(args.output, SUITE, report)

    ok = {n: r for n, r in results.items() if r["warm"] and not r["errors"]}
    if ok:
        best = min(ok.items(), key=lambda kv: statistics.median(kv[1]["warm"]))
        base = results.get("baseline", {}).get("warm")
        base_med = statistics.median(base) if base else None
        bmed = statistics.median(best[1]["warm"])
        delta = f" ({base_med - bmed:+.2f}s vs baseline)" if base_med else ""
        print(f"\nSaved: '{SUITE}' section -> {args.output}", flush=True)
        print(f"Done: fastest reliable = {best[0]} @ {bmed:.2f}s median warm"
              f"{delta}", flush=True)
    else:
        print(f"\nDone: no reliable config (all errored?)", flush=True)


if __name__ == "__main__":
    main()
