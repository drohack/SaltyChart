"""
CPU live-translation benchmark — find the cheapest config that still feels instant.

The on-demand subtitle daemon (backend/scripts/translate_daemon.py) runs CPU-only
on the Unraid box, sharing the box with Plex (which transcodes most of the time).
So the goal is NOT to max the cores — it's the lowest time-to-first-subtitle (TTFS)
and the lowest CPU cost, with speed prioritised over quality (live subs are
throwaway: the Wednesday batch upgrades them to `medium`, the Sunday GPU run to
`large-v3-split`).

This harness sweeps the levers that matter on CPU and reports, per config:
  - TTFS      time to first subtitle = extract(first 5s) + transcribe(first 5s)
  - total     wall-clock to transcribe the whole trailer (from `--start`)
  - xRT       realtime factor (total / audio_duration); <1 means faster than playback
  - cpu_s     process CPU-seconds consumed (the Plex-contention cost; rises with threads)
  - rss_mb    resident memory after model load (the ~5 GB-free constraint)
  - content   timing-free semantic similarity vs real English CC (quality sanity)
  - halluc    % of segments that look like hallucinations (<0.25 sim)

It reuses the real-trailer corpus + scoring from benchmark_whisper_settings.py
(tools/benchmark_data/<vid>/audio.wav + cc_segments.json). Run `--download` there
first if the corpus is missing.

IMPORTANT: run this ON THE UNRAID SERVER (during a quiet Plex window) for numbers
that reflect production hardware — the i5-10400 CPU differs from a dev box. Use a
dev machine only to iterate on the harness itself.

Usage:
  py -3.13 -u tools/bench_live_cpu.py                       # default grid
  py -3.13 -u tools/bench_live_cpu.py --models small base   # subset of models
  py -3.13 -u tools/bench_live_cpu.py --threads 1 2         # subset of thread counts
  py -3.13 -u tools/bench_live_cpu.py --start 30            # simulate playhead start
  py -3.13 -u tools/bench_live_cpu.py --limit 3             # first 3 trailers only
  py -3.13 -u tools/bench_live_cpu.py --no-quality          # skip CC similarity (no sentence-transformers)
"""

import argparse
import gc
import json
import os
import platform
import subprocess
import sys
import tempfile
import time

# Reuse the corpus + scoring already built for the GPU bake-off.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from benchmark_whisper_settings import (  # noqa: E402
    TEST_VIDEOS, DATA_DIR, score_content, score_segments, write_result_section,
)

RESULTS_FILE = os.path.join(os.path.dirname(__file__), "benchmark_results.txt")
SUITE = "live_cpu"

# Ramp matches translate_stream.generate_chunks: first subtitle comes from a 5 s chunk.
FIRST_CHUNK_S = 5


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _audio_duration(path):
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def _extract(src, start, dur, out_path):
    """Extract a 16 kHz mono WAV slice via ffmpeg (single-threaded, to mirror the
    Plex-friendly daemon). Returns wall-clock seconds spent."""
    cmd = ["ffmpeg", "-y", "-threads", "1", "-ss", str(start)]
    if dur is not None:
        cmd += ["-t", str(dur)]
    cmd += ["-i", src, "-ac", "1", "-ar", "16000", "-f", "wav", out_path]
    kwargs = dict(stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                  stderr=subprocess.DEVNULL, check=True, timeout=120)
    if sys.platform == "win32":
        kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    t0 = time.perf_counter()
    subprocess.run(cmd, **kwargs)
    return time.perf_counter() - t0


def _load_cc(vid_dir):
    """Load real timestamped English CC segments ([{start,end,words}]) if present."""
    path = os.path.join(vid_dir, "cc_segments.json")
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return []


def _rss_mb():
    try:
        import psutil
        return psutil.Process().memory_info().rss / 1e6
    except Exception:
        try:
            import resource
            # ru_maxrss is KB on Linux, bytes on macOS.
            maxrss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
            return maxrss / 1024 if sys.platform != "darwin" else maxrss / 1e6
        except Exception:
            return 0.0


def _transcribe(model, audio_path, vad, word_ts):
    """Run a transcribe+translate pass; return (segments, wall_s, cpu_s).
    cpu_s uses process_time() which sums CPU across the process's threads."""
    w0, c0 = time.perf_counter(), time.process_time()
    segments, _ = model.transcribe(
        audio_path, language="ja", task="translate",
        vad_filter=vad, beam_size=1, condition_on_previous_text=False,
        word_timestamps=word_ts,
    )
    out = []
    for seg in segments:  # generator — consuming it does the work
        text = seg.text.strip()
        if not text:
            continue
        w = seg.words if word_ts else None
        out.append({
            "start": round(w[0].start if w else seg.start, 2),
            "end":   round(w[-1].end if w else seg.end, 2),
            "text": text,
        })
    return out, time.perf_counter() - w0, time.process_time() - c0


# ---------------------------------------------------------------------------
# Benchmark
# ---------------------------------------------------------------------------

def run(videos, models, threads_list, start, vad, word_ts, do_quality):
    import shutil
    from faster_whisper import WhisperModel

    rows = []          # one dict per (model, threads) averaged across videos
    samples = {}       # (model,threads) -> first video's segments for the SAMPLE block
    total_cfgs = len(models) * len(threads_list)
    cfg_i = 0

    for model_name in models:
        for threads in threads_list:
            cfg_i += 1
            tag = f"{model_name}/t{threads}"
            os.environ["OMP_NUM_THREADS"] = str(threads)
            print(f"[cfg {cfg_i}/{total_cfgs} {tag}] starting "
                  f"({len(videos)} videos)...", flush=True)

            per = []  # per-video metrics
            rss = 0.0
            for vi, (vid, title) in enumerate(videos, 1):
                vid_dir = os.path.join(DATA_DIR, vid)
                audio = os.path.join(vid_dir, "audio.wav")
                if not os.path.exists(audio):
                    print(f"[cfg {cfg_i}/{total_cfgs} {tag}] video {vi}/{len(videos)} "
                          f"{vid}: no audio.wav, skipped", flush=True)
                    continue
                dur = _audio_duration(audio)
                # Fresh model per video: load time is excluded from the measured
                # transcribe timings, and it sidesteps a faster-whisper 1.2.1 quirk
                # where a VAD pass that finds no speech (common on a trailer's silent
                # first 5 s) poisons later transcriptions on the SAME `base` model
                # instance. `small` recovers, but a fresh instance is bulletproof.
                model = WhisperModel(model_name, device="cpu",
                                     compute_type="int8", cpu_threads=threads)
                rss = max(rss, _rss_mb())
                tmpdir = tempfile.mkdtemp()
                try:
                    # --- total: whole trailer from `start` (run FIRST so a silent
                    #     TTFS chunk can't corrupt the measured segments) ---
                    if start > 0:
                        rest = os.path.join(tmpdir, "rest.wav")
                        _extract(audio, start, None, rest)
                        src = rest
                    else:
                        src = audio
                    segs, total_s, cpu_s = _transcribe(model, src, vad, word_ts)

                    # --- TTFS: first 5 s chunk (extract + transcribe), timing only ---
                    c0 = os.path.join(tmpdir, "c0.wav")
                    ttfs_extract = _extract(audio, start, FIRST_CHUNK_S, c0)
                    _, ttfs_tx, _ = _transcribe(model, c0, vad, word_ts)
                    ttfs = ttfs_extract + ttfs_tx

                    content = halluc = 0.0
                    if do_quality:
                        cc = _load_cc(vid_dir)
                        # shift segs back to absolute time for fair CC comparison
                        abs_segs = [{**s, "start": s["start"] + start,
                                     "end": s["end"] + start} for s in segs]
                        if cc:
                            content = score_content(abs_segs, cc)
                            _, halluc = score_segments(abs_segs, cc)

                    audio_len = max(0.1, dur - start)
                    per.append({
                        "ttfs": ttfs, "total": total_s, "cpu": cpu_s,
                        "xrt": total_s / audio_len, "content": content,
                        "halluc": halluc, "segs": len(segs),
                    })
                    if (model_name, threads) not in samples:
                        samples[(model_name, threads)] = (title, segs[:4])
                    print(f"[cfg {cfg_i}/{total_cfgs} {tag}] video {vi}/{len(videos)} "
                          f"{vid[:11]}: ttfs={ttfs:.1f}s total={total_s:.1f}s "
                          f"xRT={total_s/audio_len:.2f} cpu={cpu_s:.1f}s "
                          f"segs={len(segs)} cont={content:.0f}%", flush=True)
                finally:
                    del model
                    gc.collect()
                    shutil.rmtree(tmpdir, ignore_errors=True)

            if per:
                n = len(per)
                rows.append({
                    "model": model_name, "threads": threads, "rss": rss, "n": n,
                    "ttfs": sum(p["ttfs"] for p in per) / n,
                    "total": sum(p["total"] for p in per) / n,
                    "xrt": sum(p["xrt"] for p in per) / n,
                    "cpu": sum(p["cpu"] for p in per) / n,
                    "content": sum(p["content"] for p in per) / n,
                    "halluc": sum(p["halluc"] for p in per) / n,
                    "segs": sum(p["segs"] for p in per) / n,
                })

    return rows, samples


def format_report(rows, samples, videos, start, vad, word_ts, do_quality):
    lines = []
    when = time.strftime("%Y-%m-%d %H:%M")
    lines.append(f"Benchmark: suite '{SUITE}' — live CPU translation  ({when})")
    lines.append(f"Host: {platform.node() or 'unknown'} ({platform.processor() or platform.machine()})"
                 f"  |  Videos: {len(videos)}  |  start={start}s  vad={vad}  word_ts={word_ts}")
    lines.append("Lower is better for ttfs/total/xRT/cpu/rss/halluc; higher for content.")
    lines.append("TTFS = extract(5s)+transcribe(5s); xRT = total/audio_len (<1 = faster than realtime).")
    lines.append("")
    lines.append("=" * 92)
    lines.append("SUMMARY  (sorted by TTFS; metrics averaged across videos)")
    hdr = (f"{'model':7} {'thr':>3} {'ttfs':>6} {'total':>7} {'xRT':>5} "
           f"{'cpu_s':>6} {'rss_mb':>7} {'segs':>5}")
    if do_quality:
        hdr += f" {'cont':>5} {'hall':>5}"
    lines.append(hdr)
    lines.append("-" * 92)
    for r in sorted(rows, key=lambda r: r["ttfs"]):
        row = (f"{r['model']:7} {r['threads']:>3} {r['ttfs']:>6.1f} {r['total']:>7.1f} "
               f"{r['xrt']:>5.2f} {r['cpu']:>6.1f} {r['rss']:>7.0f} {r['segs']:>5.1f}")
        if do_quality:
            row += f" {r['content']:>5.0f} {r['halluc']:>5.0f}"
        lines.append(row)
    lines.append("=" * 92)

    # One sample transcript per model (threads don't change text), for a sanity read.
    seen_models = set()
    for (model_name, threads), (title, segs) in samples.items():
        if model_name in seen_models:
            continue
        seen_models.add(model_name)
        lines.append("")
        lines.append(f"SAMPLE — {model_name} on {title[:40]}")
        for s in segs:
            lines.append(f"  [{s['start']:.1f}->{s['end']:.1f}] {s['text']}")
    return "\n".join(lines)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    ap = argparse.ArgumentParser()
    ap.add_argument("--models", nargs="+", default=["tiny", "base", "small"],
                    help="Whisper model sizes to sweep (default: tiny base small)")
    ap.add_argument("--threads", nargs="+", type=int, default=[1, 2, 3, 4],
                    help="cpu_threads values to sweep (default: 1 2 3 4)")
    ap.add_argument("--start", type=float, default=0.0,
                    help="Simulate a playhead start offset in seconds (default: 0)")
    ap.add_argument("--no-vad", action="store_true", help="Disable VAD filter")
    ap.add_argument("--no-word-ts", action="store_true",
                    help="Disable word_timestamps (uses segment-level timing; faster)")
    ap.add_argument("--no-quality", action="store_true",
                    help="Skip CC similarity scoring (avoids sentence-transformers dep)")
    ap.add_argument("--limit", type=int, default=0, help="Only the first N trailers")
    ap.add_argument("--videos", nargs="+", default=None, help="Explicit video IDs")
    ap.add_argument("--output", default=RESULTS_FILE)
    args = ap.parse_args()

    if args.videos:
        videos = [(v, v) for v in args.videos]
    else:
        videos = list(TEST_VIDEOS)
    if args.limit:
        videos = videos[:args.limit]

    vad = not args.no_vad
    word_ts = not args.no_word_ts
    do_quality = not args.no_quality

    print(f"live_cpu bench: {len(args.models)*len(args.threads)} configs "
          f"({len(args.models)} models x {len(args.threads)} thread counts) "
          f"x {len(videos)} videos  |  start={args.start}s", flush=True)

    rows, samples = run(videos, args.models, args.threads, args.start,
                        vad, word_ts, do_quality)
    if not rows:
        print("Done: no results (corpus missing? run benchmark_whisper_settings.py "
              "--download first)", flush=True)
        return

    report = format_report(rows, samples, videos, args.start, vad, word_ts, do_quality)
    print("\n" + report, flush=True)
    write_result_section(args.output, SUITE, report)

    best = min(rows, key=lambda r: r["ttfs"])
    print(f"\nSaved: '{SUITE}' section -> {args.output}", flush=True)
    print(f"Done: {len(rows)} configs benched. Fastest TTFS = {best['ttfs']:.1f}s "
          f"({best['model']}/t{best['threads']}, cpu={best['cpu']:.1f}s, "
          f"content={best['content']:.0f}%)", flush=True)


if __name__ == "__main__":
    main()
