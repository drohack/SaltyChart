"""
Benchmark faster-whisper settings for large-v3 against Summer 2026 trailers.

Data lives in tools/benchmark_data/ — downloaded once, reused forever.

  py -3.13 tools/benchmark_whisper_settings.py --download   # fetch audio + CC once
  py -3.13 tools/benchmark_whisper_settings.py              # run benchmark

Scoring: timestamp-aligned word overlap.  For each Whisper segment, compare
against YouTube CC words that appear within ±3 s of the segment midpoint.
This correctly handles paraphrases and avoids penalising segments that cover
parts of the trailer with no CC.
"""

import argparse, json, os, re, shutil, subprocess, sys, time
from datetime import datetime

# ---------------------------------------------------------------------------
# 10 confirmed Summer 2026 trailers with YouTube English CC
# ---------------------------------------------------------------------------

TEST_VIDEOS = [
    ("7fdSXo-be7o", "BanG Dream! Yume Infinity Mita"),
    ("p0JRE_K6s5A", "I Became a Legend After My 10 Year Stand"),
    ("ECtHlHde3EQ", "Otome Kaijuu Caramelise"),
    ("y-efbopLrYk", "Young Ladies Don't Play Fighting Games"),
    ("nR_vqhD2rGM", "Though I Am an Inept Villainess"),
    ("aQWo0lR5lNw", "Otomege Sekai wa Mob ni Kibishii Sekai desu 2"),
    ("HZW_fbHDsT8", "Toumei na Yoru ni Kakeru Kimi to"),
    ("OMCPr9YwHdM", "Iwamoto-senpai no Suisen"),
    ("-FVOUh7_obU", "Goodbye, Lara"),
    ("7ObipYqbOd8", "Sparks of Tomorrow"),
]

DATA_DIR = os.path.join(os.path.dirname(__file__), "benchmark_data")

# ---------------------------------------------------------------------------
# Settings — baseline + 28 variants covering 10 dimensions with multiple values
# ---------------------------------------------------------------------------

BASE = dict(
    language="ja", task="translate",
    vad_filter=True, beam_size=5,
    condition_on_previous_text=True,
    word_timestamps=True,
)

SETTINGS = [
    # ── Known winners (individual) ────────────────────────────────────────
    ("baseline",                    {}),
    ("beam10",                      {"beam_size": 10}),
    ("reppenalty_120",              {"repetition_penalty": 1.2}),

    # ── Combo: our two best together ──────────────────────────────────────
    ("beam10_rep120",               {"beam_size": 10, "repetition_penalty": 1.2}),

    # ── suppress_blank ────────────────────────────────────────────────────
    ("suppress_blank",              {"suppress_blank": True}),
    ("beam10_rep120_suppress",      {"beam_size": 10, "repetition_penalty": 1.2, "suppress_blank": True}),

    # ── vad_filter off ────────────────────────────────────────────────────
    ("no_vad",                      {"vad_filter": False}),

    # ── auto language detection ───────────────────────────────────────────
    ("auto_lang",                   {"language": None}),

    # ── triple combo: best individual settings + vad_min_300 ─────────────
    ("beam10_rep120_vadmin300",     {"beam_size": 10, "repetition_penalty": 1.2,
                                     "vad_parameters": {"min_speech_duration_ms": 300}}),
]

# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------

def parse_vtt_segments(vtt_path):
    """Parse VTT into [{start, end, words}, ...] for timestamp-aligned scoring."""
    segments = []
    cur_start = cur_end = None
    with open(vtt_path, encoding="utf-8") as f:
        for line in f:
            line = line.rstrip()
            if "-->" in line:
                parts = line.split("-->")
                cur_start = _vtt_time(parts[0].strip())
                cur_end   = _vtt_time(parts[1].strip().split()[0])
            elif line and cur_start is not None and not line.startswith("WEBVTT") \
                    and not line.startswith("Kind:") and not line.startswith("Language:") \
                    and not line.isdigit():
                text = re.sub(r"<[^>]+>", "", line)
                words = [w for w in re.sub(r"[^a-z\s]", "", text.lower()).split() if w]
                if words:
                    segments.append({"start": cur_start, "end": cur_end, "words": words})
                cur_start = cur_end = None
    return segments

def _vtt_time(s):
    """Convert VTT timestamp (HH:MM:SS.mmm or MM:SS.mmm) to seconds."""
    parts = s.split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    return int(parts[0]) * 60 + float(parts[1])

def download_video_data(video_id, title, vid_dir):
    """Download FULL trailer audio + CC. Returns True on success."""
    os.makedirs(vid_dir, exist_ok=True)
    audio_path  = os.path.join(vid_dir, "audio.wav")
    cc_json     = os.path.join(vid_dir, "cc_segments.json")

    # Full-trailer audio (no time limit)
    if not os.path.exists(audio_path):
        sys.stdout.write("  Downloading audio (full trailer)... ")
        sys.stdout.flush()
        try:
            r = subprocess.run(
                ["yt-dlp", "--quiet", "-x", "--audio-format", "wav",
                 "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1",
                 "-o", os.path.join(vid_dir, "audio"),
                 f"https://www.youtube.com/watch?v={video_id}"],
                capture_output=True, timeout=180,
            )
        except subprocess.TimeoutExpired:
            print("TIMEOUT"); return False
        if not os.path.exists(audio_path):
            err = r.stderr.decode(errors="replace").strip().splitlines()
            print(f"FAIL: {err[-1] if err else '?'}"); return False
        print(f"ok ({os.path.getsize(audio_path)//1024}KB)")
    else:
        print(f"  Audio exists ({os.path.getsize(audio_path)//1024}KB).")

    # CC subtitles
    if not os.path.exists(cc_json):
        sys.stdout.write("  Downloading CC...              ")
        sys.stdout.flush()
        import glob as _g
        sub_tpl = os.path.join(vid_dir, "cc_sub")
        subprocess.run(
            ["yt-dlp", "--quiet", "--skip-download",
             "--write-subs", "--sub-lang", "en", "--sub-format", "vtt",
             "-o", sub_tpl,
             f"https://www.youtube.com/watch?v={video_id}"],
            capture_output=True, timeout=30,
        )
        segs = []
        for vtt in _g.glob(os.path.join(vid_dir, "*.vtt")):
            segs = parse_vtt_segments(vtt)
            break
        with open(cc_json, "w", encoding="utf-8") as f:
            json.dump(segs, f)
        if segs:
            print(f"ok ({len(segs)} segments, "
                  f"{sum(len(s['words']) for s in segs)} words)")
        else:
            print("no CC (saved empty)")
    else:
        segs = json.load(open(cc_json))
        print(f"  CC exists ({len(segs)} segments).")

    with open(os.path.join(vid_dir, "title.txt"), "w", encoding="utf-8") as f:
        f.write(title)
    return True

# ---------------------------------------------------------------------------
# Scoring — semantic similarity via sentence embeddings
# ---------------------------------------------------------------------------

_embed_model = None

def _get_embed_model():
    global _embed_model
    if _embed_model is None:
        from sentence_transformers import SentenceTransformer
        import warnings; warnings.filterwarnings("ignore")
        _embed_model = SentenceTransformer("all-MiniLM-L6-v2")
    return _embed_model

def _cosine(a, b):
    import numpy as np
    a, b = np.array(a), np.array(b)
    d = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / d) if d > 0 else 0.0

def score_segments(whisper_segs, cc_segs, window=4.0):
    """
    For each Whisper segment, find the CC text within ±window seconds and
    measure semantic similarity using sentence embeddings.

    "I'm looking forward to working with you for a long time" and
    "look forward to working with you for years to come" both score ~0.93.
    Genuine hallucinations (music/noise transcribed as words) score ~0.1.

    Returns (avg_similarity_pct, halluc_pct).
    """
    if not cc_segs:
        halluc = 0
        for seg in whisper_segs:
            words = [w for w in re.sub(r"[^a-z\s]", "", seg["text"].lower()).split() if w]
            if len(words) > 3 and max((words.count(w) for w in set(words)), default=0) / len(words) > 0.5:
                halluc += 1
        return 0.0, (halluc / len(whisper_segs) * 100 if whisper_segs else 0.0)

    embed = _get_embed_model()
    scores, halluc_count = [], 0

    for seg in whisper_segs:
        if not seg["text"].strip():
            continue
        mid = (seg["start"] + seg["end"]) / 2
        nearby_text = " ".join(
            " ".join(cs["words"])
            for cs in cc_segs
            if abs((cs["start"] + cs["end"]) / 2 - mid) <= window
        ).strip()
        if not nearby_text:
            continue  # No CC near this point — skip, don't penalise
        w_emb, c_emb = embed.encode([seg["text"], nearby_text])
        sim = max(0.0, _cosine(w_emb, c_emb))
        scores.append(sim)
        if sim < 0.25:
            halluc_count += 1

    if not scores:
        return 0.0, 0.0
    return sum(scores) / len(scores) * 100, halluc_count / len(scores) * 100

# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

def transcribe(model, audio_path, extra_kwargs):
    params = {**BASE, **extra_kwargs}
    segs, _ = model.transcribe(audio_path, **params)
    results = []
    for seg in segs:
        text = seg.text.strip()
        if not text:
            continue
        w = seg.words
        results.append({
            "start": round(w[0].start if w else seg.start, 2),
            "end":   round(w[-1].end  if w else seg.end,   2),
            "text":  text,
        })
    return results

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true",
                        help="Download full-trailer audio + CC for all test videos")
    parser.add_argument("--output", default=os.path.join(
        os.path.dirname(__file__), "benchmark_results.txt"))
    args = parser.parse_args()

    # ── Download ─────────────────────────────────────────────────────────────
    if args.download:
        print(f"Downloading to {DATA_DIR}/\n")
        for vid, title in TEST_VIDEOS:
            vid_dir = os.path.join(DATA_DIR, vid)
            print(f"{vid}  {title}")
            ok = download_video_data(vid, title, vid_dir)
            print(f"  {'✓' if ok else '✗'}\n")
            time.sleep(1)
        print("Done.")
        return

    # ── Load ──────────────────────────────────────────────────────────────────
    video_data = {}
    for vid, title in TEST_VIDEOS:
        vid_dir    = os.path.join(DATA_DIR, vid)
        audio_path = os.path.join(vid_dir, "audio.wav")
        cc_json    = os.path.join(vid_dir, "cc_segments.json")
        cc_txt     = os.path.join(vid_dir, "cc.txt")
        if not os.path.exists(audio_path):
            print(f"MISSING audio: {vid} — run with --download first")
            continue

        # Prefer timestamped cc_segments.json; fall back to cc.txt with
        # approximate timestamps (words spread evenly across audio duration)
        cc_segs = json.load(open(cc_json, encoding="utf-8")) if os.path.exists(cc_json) else []
        if not cc_segs and os.path.exists(cc_txt):
            words = open(cc_txt, encoding="utf-8").read().split()
            if words:
                # Get audio duration from ffprobe
                try:
                    r = subprocess.run(
                        ["ffprobe", "-v", "quiet", "-show_entries",
                         "format=duration", "-of", "default=nk=1:nw=1", audio_path],
                        capture_output=True, text=True, timeout=10)
                    duration = float(r.stdout.strip())
                except Exception:
                    duration = 90.0  # assume 90s if ffprobe fails
                # Distribute words into ~5s segments across the duration
                seg_dur = 5.0
                words_per_seg = max(1, round(len(words) / (duration / seg_dur)))
                for i in range(0, len(words), words_per_seg):
                    t = (i / len(words)) * duration
                    cc_segs.append({
                        "start": round(t, 1),
                        "end":   round(min(t + seg_dur, duration), 1),
                        "words": words[i:i + words_per_seg],
                    })

        video_data[vid] = {"title": title, "audio": audio_path, "cc": cc_segs}

    if not video_data:
        print("No data. Run:  py -3.13 tools/benchmark_whisper_settings.py --download")
        return

    have_cc = sum(1 for v in video_data.values() if v["cc"])
    print(f"Loaded {len(video_data)} videos ({have_cc} with CC).  "
          f"Running {len(SETTINGS)} setting variants...\n")

    # ── Model ─────────────────────────────────────────────────────────────────
    print("Loading large-v3 model...")
    try:
        import torch
        device = "cuda" if torch.cuda.is_available() else "cpu"
    except ImportError:
        device = "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    from faster_whisper import WhisperModel
    model = WhisperModel("large-v3", device=device, compute_type=compute_type)
    print(f"Model loaded ({compute_type} on {device}).\n")

    # ── Benchmark ─────────────────────────────────────────────────────────────
    all_results = {}
    total = len(SETTINGS) * len(video_data)
    done  = 0
    for sname, extra_kwargs in SETTINGS:
        all_results[sname] = {}
        for vid, vdata in video_data.items():
            done += 1
            try:
                segs = transcribe(model, vdata["audio"], extra_kwargs)
                ov, halluc = score_segments(segs, vdata["cc"])
                all_results[sname][vid] = {
                    "segs": segs, "seg_count": len(segs),
                    "overlap": ov, "halluc": halluc, "score": ov - halluc,
                }
                cc_note = f"ov={ov:.0f}%" if vdata["cc"] else "no CC"
                print(f"  [{done:3d}/{total}] {sname:<22} {vid}  "
                      f"{len(segs):3d} segs  {cc_note}  halluc={halluc:.0f}%")
            except Exception as e:
                print(f"  [{done:3d}/{total}] {sname:<22} {vid}  ERROR: {e}")
                all_results[sname][vid] = {
                    "segs": [], "seg_count": 0, "overlap": 0,
                    "halluc": 100, "score": -100,
                }
        print()

    # ── Report ────────────────────────────────────────────────────────────────
    lines = []
    lines.append(f"Benchmark: large-v3 full trailers — SUMMER 2026  "
                 f"({datetime.now().strftime('%Y-%m-%d %H:%M')})")
    lines.append(f"Device: {device} ({compute_type})  |  "
                 f"Videos: {len(video_data)}  |  With CC: {have_cc}  |  "
                 f"Scoring: timestamp-aligned ±3s window")
    lines.append("")

    # Summary sorted by score desc
    lines.append("=" * 72)
    lines.append("SUMMARY  (sorted by score; overlap and halluc are averaged across videos with CC)")
    lines.append(f"{'Setting':<26} {'segs':>5} {'overlap':>8} {'halluc':>8} {'SCORE':>7}")
    lines.append("-" * 72)

    rows = []
    for sname, _ in SETTINGS:
        vd = all_results[sname]
        if not vd: continue
        cc_vids = [v for v in vd.values() if video_data[next(k for k,d in video_data.items() if d is video_data.get(next(iter(vd)), None) or True)]["cc"]]
        # simpler: just average over all
        avg_segs    = sum(v["seg_count"] for v in vd.values()) / len(vd)
        avg_overlap = sum(v["overlap"]   for v in vd.values()) / len(vd)
        avg_halluc  = sum(v["halluc"]    for v in vd.values()) / len(vd)
        avg_score   = avg_overlap - avg_halluc
        rows.append((sname, avg_segs, avg_overlap, avg_halluc, avg_score))

    rows.sort(key=lambda r: r[4], reverse=True)
    best = rows[0][4]
    for name, segs, ov, halluc, score in rows:
        star = " ★" if score == best else ""
        lines.append(f"{name:<26} {segs:>5.1f} {ov:>7.1f}% "
                     f"{halluc:>7.1f}% {score:>6.1f}{star}")
    lines.append("")

    # Per-setting detail (in SETTINGS order)
    for sname, extra_kwargs in SETTINGS:
        lines.append("=" * 72)
        lines.append(f"SETTING: {sname}  {extra_kwargs or '(baseline)'}")
        lines.append(f"  {'Video':<36} {'segs':>5} {'overlap':>8} {'halluc':>8} {'score':>6}")
        lines.append("  " + "-" * 68)
        for vid, vdata in video_data.items():
            r = all_results[sname].get(vid, {})
            lines.append(
                f"  {vid} {vdata['title'][:30]:<30} "
                f"{r.get('seg_count',0):>5} "
                f"{r.get('overlap',0):>7.1f}% "
                f"{r.get('halluc',0):>7.1f}% "
                f"{r.get('score',0):>6.1f}"
            )
        lines.append("")

    # Sample for first video with CC
    sample_vid = next((v for v, d in video_data.items() if d["cc"]),
                      list(video_data.keys())[0])
    lines.append("=" * 72)
    lines.append(f"SAMPLE — {sample_vid} ({video_data[sample_vid]['title']})")
    lines.append("")
    for sname, _ in SETTINGS[:6]:  # first 6 settings only to keep report readable
        segs = all_results[sname].get(sample_vid, {}).get("segs", [])
        row = next((r for r in rows if r[0] == sname), None)
        score_str = f"score={row[4]:.1f}" if row else ""
        lines.append(f"  --- {sname} ({len(segs)} segs, {score_str}) ---")
        for seg in segs[:4]:
            lines.append(f"    [{seg['start']:.1f}→{seg['end']:.1f}] {seg['text'][:80]}")
        lines.append("")

    report = "\n".join(lines)
    print("\n" + report)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"\nSaved: {args.output}")


if __name__ == "__main__":
    main()
