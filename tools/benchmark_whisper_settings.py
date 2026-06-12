"""
Benchmark subtitle-pipeline variants against Summer 2026 anime trailers.

Data lives in tools/benchmark_data/ — downloaded once, reused forever.

  py -3.13 tools/benchmark_whisper_settings.py --download          # fetch audio + CC once
  py -3.13 tools/benchmark_whisper_settings.py                     # baseline decode-param sweep
  py -3.13 tools/benchmark_whisper_settings.py --suite phase1 \
      --output tools/results_phase1.txt                            # raw vs Demucs vocals

A "variant" is a full pipeline spec (audio source -> ASR -> optional translate
-> optional align), not just transcribe kwargs — see DEFAULT_SPEC / _spec().
The swappable backends live in tools/bench_pipeline.py so a winning config can
later be lifted into local_translate.py.

Scoring (two metrics, both vs YouTube English CC ground truth):
  * overlap — mean sentence-embedding cosine similarity of each segment vs the
    CC text within ±4 s of its midpoint (tolerant of paraphrase + loose timing).
  * timing  — mean span IoU of each segment against its best-overlapping CC
    segment (rewards tight timestamps; moves with forced alignment).
  halluc is the % of segments scoring <0.25 semantic similarity.
  SCORE = overlap - halluc.
"""

import argparse, hashlib, json, os, re, shutil, subprocess, sys, time
from datetime import datetime

import bench_pipeline as bp

# Bump when ASR adapter logic changes in a way that should invalidate cached
# transcriptions (the cache key already covers audio file + model + decode args).
CACHE_VERSION = 1

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
    ("-FVOUh7_obU", "Goodbye, Lara"),
    ("7ObipYqbOd8", "Sparks of Tomorrow"),
    # Added to backfill the OMCPr9YwHdM drop — both verified to have *manual*
    # (not auto-generated) English CC, the lesson from that exclusion.
    ("3-Cj3dXwQWI", "Saga of Tanya the Evil Season 2"),
    ("ODxfIvSgWuo", "Mushoku Tensei: Jobless Reincarnation Season 3"),
    # OMCPr9YwHdM (Iwamoto-senpai no Suisen) excluded: its only English CC is
    # auto-generated and does NOT match the audio — 100% halluc / 8% overlap on
    # every setting, a broken reference that polluted absolute scores. Cached
    # files are kept in benchmark_data/ but it's dropped from the scored set.
]

DATA_DIR = os.path.join(os.path.dirname(__file__), "benchmark_data")
# Single consolidated results file: one delimited section per suite. A run only
# replaces (or appends) its own suite's section — other suites are left intact.
RESULTS_FILE = os.path.join(os.path.dirname(__file__), "benchmark_results.txt")
_SECTION_MARK = "@@@ BENCHMARK SUITE: {} @@@"

# ---------------------------------------------------------------------------
# Pipeline specs
# ---------------------------------------------------------------------------
# A variant is a spec dict. Legacy tuples (name, asr_kwargs) are normalised by
# _spec() into full specs, so the baseline decode-param sweep is unchanged.

DEFAULT_SPEC = {
    "audio":      "raw",            # "raw" | "vocals"
    "asr":        "faster_whisper", # key into bp.ASR_BACKENDS
    "asr_model":  "large-v3",       # model name / HF repo (faster_whisper only)
    "asr_kwargs": {},               # overrides bp._FW_DEFAULTS (task, beam_size, ...)
    "translator": None,             # None | key into bp.TRANSLATORS
    "translator_kwargs": {},
    "aligner":    None,             # None | key into bp.ALIGNERS
    "aligner_kwargs": {},
}


def _spec(entry):
    """Normalise a suite entry (legacy tuple or partial dict) into a full spec."""
    if isinstance(entry, tuple):
        name, asr_kwargs = entry
        return {**DEFAULT_SPEC, "name": name, "asr_kwargs": asr_kwargs}
    return {**DEFAULT_SPEC, **entry}


# ── Baseline suite: the original decode-param sweep on raw audio (large-v3,
#    task=translate). Kept verbatim so results reproduce benchmark_results.txt.
BASELINE = [
    ("baseline",                {}),
    ("beam10",                  {"beam_size": 10}),
    ("reppenalty_120",          {"repetition_penalty": 1.2}),
    ("beam10_rep120",           {"beam_size": 10, "repetition_penalty": 1.2}),
    ("suppress_blank",          {"suppress_blank": True}),
    ("beam10_rep120_suppress",  {"beam_size": 10, "repetition_penalty": 1.2, "suppress_blank": True}),
    ("no_vad",                  {"vad_filter": False}),
    ("auto_lang",               {"language": None}),
    ("beam10_rep120_vadmin300", {"beam_size": 10, "repetition_penalty": 1.2,
                                 "vad_parameters": {"min_speech_duration_ms": 300}}),
]

# ── Phase 1: same top decode settings, raw vs Demucs vocals. Isolates the
#    music-removal effect with decode params held constant.
_P1_DECODE = [
    ("baseline",       {}),
    ("beam10",         {"beam_size": 10}),
    ("reppenalty_120", {"repetition_penalty": 1.2}),
    ("beam10_rep120",  {"beam_size": 10, "repetition_penalty": 1.2}),
]
PHASE1 = (
    [{"name": f"{n}__raw",    "audio": "raw",    "asr_kwargs": k} for n, k in _P1_DECODE]
    + [{"name": f"{n}__vocals", "audio": "vocals", "asr_kwargs": k} for n, k in _P1_DECODE]
)

# ── Phase 2: end-to-end translate vs transcribe(ja) -> Qwen translate.
#    Runs on the Phase-1 winner (vocals, beam10). The control `e2e_translate`
#    on vocals == Phase-1's best (beam10__vocals), so this directly tests
#    whether a dedicated translate step beats Whisper's translate head.
_QWEN_P2 = "qwen3.5:9b"
PHASE2 = [
    # Control: Whisper's end-to-end translate (== Phase-1 best, beam10__vocals).
    {"name": "e2e_translate", "audio": "vocals",
     "asr_kwargs": {"task": "translate", "beam_size": 10}},
    # Split: Whisper Japanese ASR -> Qwen translate.
    {"name": "whisperJP_then_qwen", "audio": "vocals",
     "asr_kwargs": {"task": "transcribe", "beam_size": 10},
     "translator": "ollama_qwen", "translator_kwargs": {"model": _QWEN_P2}},
    # Near-oracle: YouTube Japanese CC -> Qwen translate. Beating the row above
    # means Whisper's JP ASR is the bottleneck; tying it means translation is.
    # DEFERRED: needs --refetch-cc-ja, currently blocked by a YouTube IP block.
    # Re-enable once the block clears (data is otherwise all cached).
    # {"name": "jpCC_then_qwen", "asr": "jp_cc",
    #  "translator": "ollama_qwen", "translator_kwargs": {"model": _QWEN_P2}},
]

# ── Phase 3: model bake-off. Phase 2 showed the split's bottleneck is Whisper's
#    Japanese ASR, so lead with a JP-specialised ASR (kotoba-whisper-v2) for the
#    transcribe step, vs the large-v3 baselines. ASR for the first two arms is
#    served from Phase-2 cache; only kotoba transcribes fresh.
PHASE3 = [
    {"name": "e2e_translate", "audio": "vocals",
     "asr_kwargs": {"task": "translate", "beam_size": 10}},
    {"name": "whisperJP_then_qwen", "audio": "vocals",
     "asr_kwargs": {"task": "transcribe", "beam_size": 10},
     "translator": "ollama_qwen", "translator_kwargs": {"model": _QWEN_P2}},
    # kotoba can't do word-level timestamps (distilled -> DTW crash) and its
    # chunk timestamps are coarse, so it loses on timing/overlap. The `content`
    # metric (timing-independent) is what fairly judges its ASR text quality.
    {"name": "kotobaJP_then_qwen", "audio": "vocals",
     "asr": "kotoba", "asr_model": "kotoba-tech/kotoba-whisper-v2.0",
     "asr_kwargs": {"word_segments": False},
     "translator": "ollama_qwen", "translator_kwargs": {"model": _QWEN_P2}},
]

# ── Phase 4: Qwen3-ASR (current JP CER leader) for the transcribe step, vs the
#    large-v3 baselines (their ASR is served from cache). Judge the `content`
#    metric — Qwen3-ASR timestamps here are approximate (no forced aligner).
PHASE4 = [
    {"name": "e2e_translate", "audio": "vocals",
     "asr_kwargs": {"task": "translate", "beam_size": 10}},
    {"name": "whisperJP_then_qwen", "audio": "vocals",
     "asr_kwargs": {"task": "transcribe", "beam_size": 10},
     "translator": "ollama_qwen", "translator_kwargs": {"model": _QWEN_P2}},
    {"name": "qwen3asrJP_then_qwen", "audio": "vocals",
     "asr": "qwen3", "asr_model": "Qwen/Qwen3-ASR-1.7B",
     "translator": "ollama_qwen", "translator_kwargs": {"model": _QWEN_P2}},
]

# ── Champion: stack the per-phase winners (vocals + best decode + the two real
#    translate contenders). `_BEST` = the top decode combo from the real-CC
#    baseline; included beam10-only rows so we can see if the extra decode params
#    actually help on top of vocals + the split.
_BEST = {"beam_size": 10, "repetition_penalty": 1.2,
         "vad_parameters": {"min_speech_duration_ms": 300}}
CHAMPION = [
    {"name": "e2e_beam10", "audio": "vocals",
     "asr_kwargs": {"task": "translate", "beam_size": 10}},
    {"name": "e2e_best", "audio": "vocals",
     "asr_kwargs": {"task": "translate", **_BEST}},
    {"name": "split_beam10", "audio": "vocals",
     "asr_kwargs": {"task": "transcribe", "beam_size": 10},
     "translator": "ollama_qwen", "translator_kwargs": {"model": _QWEN_P2}},
    {"name": "split_best", "audio": "vocals",
     "asr_kwargs": {"task": "transcribe", **_BEST},
     "translator": "ollama_qwen", "translator_kwargs": {"model": _QWEN_P2}},
]

# ── Translator comparison: same champion ASR (cached), only the translator model
#    differs. Run as TWO separate single-arm suites (warm, default keep_alive) so
#    the two models never co-reside in VRAM and neither suffers cold-reload
#    corruption — `ollama stop <model>` between runs. Judge `content`.
#    (An earlier combined suite with keep_alive=0 cold-reloaded per video and
#    corrupted qwen3:8b's output — don't do that.)
_SPLIT_ASR = {"task": "transcribe", **_BEST}
QWEN38 = [
    {"name": "split_qwen3-8b", "audio": "vocals", "asr_kwargs": _SPLIT_ASR,
     "translator": "ollama_qwen", "translator_kwargs": {"model": "qwen3:8b"}},
]
QWEN359 = [
    {"name": "split_qwen3.5-9b", "audio": "vocals", "asr_kwargs": _SPLIT_ASR,
     "translator": "ollama_qwen", "translator_kwargs": {"model": "qwen3.5:9b"}},
]

SUITES = {
    "baseline": BASELINE,
    "phase1":   PHASE1,
    "phase2":   PHASE2,
    "phase3":   PHASE3,
    "phase4":   PHASE4,
    "champion": CHAMPION,
    "qwen38":   QWEN38,
    "qwen359":  QWEN359,
}

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

def refetch_cc(video_id, vid_dir):
    """Fetch REAL timestamped English CC via youtube_transcript_api and write
    cc_segments.json. The old yt-dlp VTT path silently produced empty files for
    these trailers, so scoring was falling back to untimed cc.txt with fabricated
    timestamps. youtube_transcript_api reliably returns {text, start, duration}.

    Returns the segment list (possibly empty), or None on hard failure."""
    from youtube_transcript_api import YouTubeTranscriptApi as YTApi
    cc_json = os.path.join(vid_dir, "cc_segments.json")
    try:
        fetched = YTApi().list(video_id).find_transcript(["en"]).fetch()
    except Exception as e:
        print(f"  no en transcript: {type(e).__name__}")
        return None

    segs = []
    for sn in fetched:
        text = sn.text if hasattr(sn, "text") else sn["text"]
        start = sn.start if hasattr(sn, "start") else sn["start"]
        dur = sn.duration if hasattr(sn, "duration") else sn["duration"]
        words = [w for w in re.sub(r"[^a-z\s]", "", text.lower()).split() if w]
        if words:
            segs.append({"start": round(float(start), 2),
                         "end": round(float(start) + float(dur), 2),
                         "words": words})
    os.makedirs(vid_dir, exist_ok=True)
    with open(cc_json, "w", encoding="utf-8") as f:
        json.dump(segs, f)
    return segs


def refetch_cc_ja(video_id, vid_dir):
    """Fetch Japanese CC (raw text, with timestamps) via youtube_transcript_api
    -> cc_ja_segments.json. Used as an alternative translation INPUT (YouTube's
    Japanese vs Whisper's Japanese) to isolate ASR error from translation error.
    Stores raw text (not word-stripped) since it feeds the translator.

    Returns segs (possibly []), or None if no Japanese transcript exists."""
    from youtube_transcript_api import YouTubeTranscriptApi as YTApi
    out = os.path.join(vid_dir, "cc_ja_segments.json")
    try:
        fetched = YTApi().list(video_id).find_transcript(["ja"]).fetch()
    except Exception as e:
        print(f"  no ja transcript: {type(e).__name__}")
        return None
    segs = []
    for sn in fetched:
        text = (sn.text if hasattr(sn, "text") else sn["text"]).strip()
        start = sn.start if hasattr(sn, "start") else sn["start"]
        dur = sn.duration if hasattr(sn, "duration") else sn["duration"]
        if text:
            segs.append({"start": round(float(start), 2),
                         "end": round(float(start) + float(dur), 2),
                         "text": text})
    os.makedirs(vid_dir, exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(segs, f, ensure_ascii=False)
    return segs


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


def score_content(whisper_segs, cc_segs):
    """Timing-independent content match: for each output segment, its best
    semantic similarity to ANY CC segment (no ±window). Isolates transcription/
    translation QUALITY from timestamp accuracy — used to judge models (like
    kotoba) whose timestamps are poor but whose text may be fine. Returns %."""
    if not whisper_segs or not cc_segs:
        return 0.0
    embed = _get_embed_model()
    cc_texts = [" ".join(cs["words"]) for cs in cc_segs if cs.get("words")]
    w_texts = [s["text"] for s in whisper_segs if s.get("text", "").strip()]
    if not cc_texts or not w_texts:
        return 0.0
    cc_emb = embed.encode(cc_texts)
    w_emb = embed.encode(w_texts)
    scores = [max(max(0.0, _cosine(we, ce)) for ce in cc_emb) for we in w_emb]
    return sum(scores) / len(scores) * 100

# ---------------------------------------------------------------------------
# Pipeline execution
# ---------------------------------------------------------------------------

def _asr_cache_key(spec, audio_path):
    """Stable key for an ASR result: audio file (+mtime) + backend + model +
    decode args. Independent of translator/aligner so the (expensive) GPU
    transcription is reused across translator variants in later phases."""
    try:
        mtime = int(os.path.getmtime(audio_path))
    except OSError:
        mtime = 0
    payload = json.dumps({
        "v": CACHE_VERSION,
        "audio": os.path.basename(audio_path), "mtime": mtime,
        "asr": spec["asr"], "model": spec["asr_model"],
        "kwargs": spec["asr_kwargs"],
    }, sort_keys=True)
    return hashlib.sha1(payload.encode()).hexdigest()[:16]


def run_pipeline(spec, vdata, cache_dir=None):
    """audio source -> ASR -> optional translate -> optional align. Returns
    [{start, end, text}].  The ASR step is cached to disk (cache_dir) keyed by
    audio+model+decode-args; translation/alignment run fresh (they're the
    variables under test and are comparatively cheap)."""
    # jp_cc: not an ASR model — use the cached YouTube Japanese CC as the
    # transcription input (isolates ASR error from translation error).
    if spec["asr"] == "jp_cc":
        cc_ja = vdata.get("cc_ja")
        if not cc_ja or not os.path.exists(cc_ja):
            raise RuntimeError("no Japanese CC for this video (run --refetch-cc-ja)")
        segs = json.load(open(cc_ja, encoding="utf-8"))
        if not segs:
            raise RuntimeError("empty Japanese CC for this video")
        if spec["translator"]:
            segs = bp.TRANSLATORS[spec["translator"]](segs, **spec["translator_kwargs"])
        if spec["aligner"]:
            segs = bp.ALIGNERS[spec["aligner"]](segs, vdata["audio"], **spec["aligner_kwargs"])
        return segs

    audio = vdata["audio"] if spec["audio"] == "raw" else vdata["audio_vocals"]

    segs, cpath = None, None
    if cache_dir:
        cpath = os.path.join(cache_dir, "asr_" + _asr_cache_key(spec, audio) + ".json")
        if os.path.exists(cpath):
            try:
                segs = json.load(open(cpath, encoding="utf-8"))
            except Exception:
                segs = None

    if segs is None:
        asr = bp.ASR_BACKENDS[spec["asr"]]
        if spec["asr"] == "faster_whisper":
            segs = asr(audio, model_name=spec["asr_model"], **spec["asr_kwargs"])
        else:
            segs = asr(audio, **spec["asr_kwargs"])
        if cpath:
            os.makedirs(cache_dir, exist_ok=True)
            with open(cpath, "w", encoding="utf-8") as f:
                json.dump(segs, f)

    if spec["translator"]:
        segs = bp.TRANSLATORS[spec["translator"]](segs, **spec["translator_kwargs"])

    if spec["aligner"]:
        segs = bp.ALIGNERS[spec["aligner"]](segs, audio, **spec["aligner_kwargs"])

    return segs

# ---------------------------------------------------------------------------
# Consolidated results file (one delimited section per suite)
# ---------------------------------------------------------------------------

# Stable display order; suites not listed append in the order they were first run.
_SUITE_ORDER = ["baseline", "phase1", "phase2", "phase3", "phase4",
                "champion", "qwen38", "qwen359"]


def read_result_sections(path):
    """Parse the consolidated results file into an ordered {suite: text} dict.
    Tolerates a non-sectioned legacy file by returning it untouched under no key."""
    sections = {}
    if not os.path.exists(path):
        return sections
    prefix, suffix = "@@@ BENCHMARK SUITE: ", " @@@"
    cur, buf = None, []
    for line in open(path, encoding="utf-8"):
        s = line.rstrip("\n")
        if s.startswith(prefix) and s.endswith(suffix):
            if cur is not None:
                sections[cur] = "".join(buf).strip("\n")
            cur, buf = s[len(prefix):-len(suffix)].strip(), []
        elif cur is not None:
            buf.append(line)
    if cur is not None:
        sections[cur] = "".join(buf).strip("\n")
    return sections


def write_result_section(path, suite, report):
    """Replace (or append) this suite's section in the consolidated file, leaving
    every other suite's section intact."""
    sections = read_result_sections(path)
    sections[suite] = report
    order = [s for s in _SUITE_ORDER if s in sections]
    order += [s for s in sections if s not in order]
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write("SaltyChart benchmark results — one section per suite. Each run "
                "replaces only its own suite's section.\n")
        for s in order:
            f.write("\n" + _SECTION_MARK.format(s) + "\n\n")
            f.write(sections[s].rstrip("\n") + "\n")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true",
                        help="Download full-trailer audio (16k mono) + CC for all test videos")
    parser.add_argument("--download-hq", action="store_true",
                        help="Download best-quality source audio (audio_hq.*) for Demucs separation")
    parser.add_argument("--refetch-cc", action="store_true",
                        help="Re-fetch REAL timestamped English CC via youtube_transcript_api")
    parser.add_argument("--refetch-cc-ja", action="store_true",
                        help="Fetch Japanese CC (raw text) as an alternative translation input")
    parser.add_argument("--suite", default="baseline", choices=list(SUITES),
                        help="Which variant suite to run (default: baseline)")
    parser.add_argument("--audio", default=None, choices=["raw", "vocals"],
                        help="Override every variant's audio source (e.g. carry "
                             "the Phase-1 winner into later suites)")
    parser.add_argument("--output", default=None,
                        help="Output file (default: tools/benchmark_results.txt — one "
                             "consolidated file; a run replaces only its suite's section)")
    parser.add_argument("--no-cache", action="store_true",
                        help="Disable the on-disk ASR result cache (force recompute)")
    args = parser.parse_args()

    if args.output is None:
        args.output = RESULTS_FILE

    specs = [_spec(e) for e in SUITES[args.suite]]
    if args.audio:
        for s in specs:
            s["audio"] = args.audio
    if not specs:
        print(f"Suite '{args.suite}' is empty — nothing to run.")
        return

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

    if args.refetch_cc:
        print(f"Re-fetching real timestamped English CC (youtube_transcript_api)\n")
        ok = 0
        for i, (vid, title) in enumerate(TEST_VIDEOS, 1):
            vid_dir = os.path.join(DATA_DIR, vid)
            sys.stdout.write(f"  [{i}/{len(TEST_VIDEOS)}] {vid}  {title[:30]}: ")
            sys.stdout.flush()
            # Skip videos that already have real CC — avoids re-hitting YouTube
            # (lockout risk). Delete cc_segments.json to force a re-fetch.
            cc_json = os.path.join(vid_dir, "cc_segments.json")
            if os.path.exists(cc_json):
                try:
                    if json.load(open(cc_json, encoding="utf-8")):
                        print("cached (skip)")
                        continue
                except Exception:
                    pass
            segs = refetch_cc(vid, vid_dir)
            if segs:
                ok += 1
                print(f"{len(segs)} segs, {sum(len(s['words']) for s in segs)} words")
            elif segs == []:
                print("empty transcript")
            time.sleep(1)
        print(f"\nDone: {ok}/{len(TEST_VIDEOS)} videos now have real timestamped CC.")
        return

    if args.refetch_cc_ja:
        print(f"Fetching Japanese CC (translation-input arm) via youtube_transcript_api\n")
        ok = 0
        for i, (vid, title) in enumerate(TEST_VIDEOS, 1):
            vid_dir = os.path.join(DATA_DIR, vid)
            out = os.path.join(vid_dir, "cc_ja_segments.json")
            sys.stdout.write(f"  [{i}/{len(TEST_VIDEOS)}] {vid}  {title[:30]}: ")
            sys.stdout.flush()
            if os.path.exists(out):
                try:
                    if json.load(open(out, encoding="utf-8")):
                        print("cached (skip)"); ok += 1; continue
                except Exception:
                    pass
            segs = refetch_cc_ja(vid, vid_dir)
            if segs:
                ok += 1
                print(f"{len(segs)} segs")
            elif segs == []:
                print("empty")
            time.sleep(1)
        print(f"\nDone: {ok}/{len(TEST_VIDEOS)} videos have Japanese CC.")
        return

    if args.download_hq:
        print(f"Downloading best-quality source audio to {DATA_DIR}/\n")
        for i, (vid, title) in enumerate(TEST_VIDEOS, 1):
            vid_dir = os.path.join(DATA_DIR, vid)
            os.makedirs(vid_dir, exist_ok=True)
            existing = [f for f in os.listdir(vid_dir) if f.startswith("audio_hq.")]
            if existing:
                print(f"  [{i}/{len(TEST_VIDEOS)}] {vid}: audio_hq exists ({existing[0]})")
                continue
            sys.stdout.write(f"  [{i}/{len(TEST_VIDEOS)}] {vid}: downloading bestaudio... ")
            sys.stdout.flush()
            r = subprocess.run(
                ["yt-dlp", "--quiet", "--no-warnings", "-f", "bestaudio",
                 "-o", os.path.join(vid_dir, "audio_hq.%(ext)s"),
                 f"https://www.youtube.com/watch?v={vid}"],
                capture_output=True, timeout=180,
            )
            got = [f for f in os.listdir(vid_dir) if f.startswith("audio_hq.")]
            print("ok " + got[0] if got else f"FAIL: {r.stderr.decode(errors='replace').strip().splitlines()[-1:]}")
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

        video_data[vid] = {"title": title, "audio": audio_path,
                            "audio_vocals": os.path.join(vid_dir, "audio_vocals.wav"),
                            "cc_ja": os.path.join(vid_dir, "cc_ja_segments.json"),
                            "cc": cc_segs}

    if not video_data:
        print("No data. Run:  py -3.13 tools/benchmark_whisper_settings.py --download")
        return

    have_cc = sum(1 for v in video_data.values() if v["cc"])
    device, compute_type = bp._device_compute()
    print(f"Loaded {len(video_data)} videos ({have_cc} with CC).  "
          f"Suite '{args.suite}': {len(specs)} variant(s) on {device}.\n")

    # ── Vocal separation (only if a variant needs it) ──────────────────────────
    if any(s["audio"] == "vocals" for s in specs):
        print("Separating vocals (Demucs) for variants that need it...")
        for i, (vid, vdata) in enumerate(video_data.items(), 1):
            if os.path.exists(vdata["audio_vocals"]):
                print(f"  [{i}/{len(video_data)}] {vid}: vocals cached")
                continue
            try:
                bp.separate_vocals(vdata["audio"], vdata["audio_vocals"])
                print(f"  [{i}/{len(video_data)}] {vid}: separated")
            except Exception as e:
                print(f"  [{i}/{len(video_data)}] {vid}: SEPARATION FAILED: {e}")
        print()

    # ── Benchmark ─────────────────────────────────────────────────────────────
    all_results = {}
    total = len(specs) * len(video_data)
    done  = 0
    for spec in specs:
        sname = spec["name"]
        all_results[sname] = {}
        for vid, vdata in video_data.items():
            done += 1
            try:
                cache_dir = None if args.no_cache else os.path.join(DATA_DIR, vid, "cache")
                segs = run_pipeline(spec, vdata, cache_dir=cache_dir)
                ov, halluc = score_segments(segs, vdata["cc"])
                timing = bp.score_timing(segs, vdata["cc"])
                content = score_content(segs, vdata["cc"])
                all_results[sname][vid] = {
                    "segs": segs, "seg_count": len(segs),
                    "overlap": ov, "halluc": halluc, "timing": timing,
                    "content": content, "score": ov - halluc,
                }
                cc_note = f"ov={ov:.0f}% iou={timing:.0f}% cont={content:.0f}%" if vdata["cc"] else "no CC"
                print(f"  [{done:3d}/{total}] {sname:<24} {vid}  "
                      f"{len(segs):3d} segs  {cc_note}  halluc={halluc:.0f}%")
            except Exception as e:
                print(f"  [{done:3d}/{total}] {sname:<24} {vid}  ERROR: {e}")
                all_results[sname][vid] = {
                    "segs": [], "seg_count": 0, "overlap": 0,
                    "halluc": 100, "timing": 0, "content": 0, "score": -100,
                }
        print()

    # ── Report ────────────────────────────────────────────────────────────────
    lines = []
    lines.append(f"Benchmark: suite '{args.suite}' — SUMMER 2026 trailers  "
                 f"({datetime.now().strftime('%Y-%m-%d %H:%M')})")
    lines.append(f"Device: {device} ({compute_type})  |  "
                 f"Videos: {len(video_data)}  |  With CC: {have_cc}")
    lines.append("Scoring: overlap = ±4s semantic similarity; timing = mean span IoU; "
                 "content = timing-free best-match similarity; SCORE = overlap - halluc")
    lines.append("")

    # Summary sorted by score desc
    lines.append("=" * 88)
    lines.append("SUMMARY  (sorted by score; metrics averaged across all videos)")
    lines.append(f"{'Setting':<28} {'segs':>5} {'overlap':>8} {'timing':>8} "
                 f"{'content':>8} {'halluc':>8} {'SCORE':>7}")
    lines.append("-" * 88)

    rows = []
    for spec in specs:
        sname = spec["name"]
        vd = all_results[sname]
        if not vd: continue
        n = len(vd)
        avg_segs    = sum(v["seg_count"] for v in vd.values()) / n
        avg_overlap = sum(v["overlap"]   for v in vd.values()) / n
        avg_timing  = sum(v["timing"]    for v in vd.values()) / n
        avg_content = sum(v["content"]   for v in vd.values()) / n
        avg_halluc  = sum(v["halluc"]    for v in vd.values()) / n
        avg_score   = avg_overlap - avg_halluc
        rows.append((sname, avg_segs, avg_overlap, avg_timing, avg_content, avg_halluc, avg_score))

    rows.sort(key=lambda r: r[6], reverse=True)
    best = rows[0][6]
    for name, segs, ov, timing, content, halluc, score in rows:
        star = " ★" if score == best else ""
        lines.append(f"{name:<28} {segs:>5.1f} {ov:>7.1f}% {timing:>7.1f}% "
                     f"{content:>7.1f}% {halluc:>7.1f}% {score:>6.1f}{star}")
    lines.append("")

    # Per-setting detail (in suite order)
    for spec in specs:
        sname = spec["name"]
        detail = {k: spec[k] for k in ("audio", "asr_model", "asr_kwargs", "translator", "aligner")
                  if spec[k] not in (None, {}, "raw")}
        lines.append("=" * 88)
        lines.append(f"SETTING: {sname}  {detail or '(defaults)'}")
        lines.append(f"  {'Video':<36} {'segs':>5} {'overlap':>8} {'timing':>8} "
                     f"{'content':>8} {'halluc':>8} {'score':>6}")
        lines.append("  " + "-" * 84)
        for vid, vdata in video_data.items():
            r = all_results[sname].get(vid, {})
            lines.append(
                f"  {vid} {vdata['title'][:30]:<30} "
                f"{r.get('seg_count',0):>5} "
                f"{r.get('overlap',0):>7.1f}% "
                f"{r.get('timing',0):>7.1f}% "
                f"{r.get('content',0):>7.1f}% "
                f"{r.get('halluc',0):>7.1f}% "
                f"{r.get('score',0):>6.1f}"
            )
        lines.append("")

    # Sample for first video with CC
    sample_vid = next((v for v, d in video_data.items() if d["cc"]),
                      list(video_data.keys())[0])
    lines.append("=" * 80)
    lines.append(f"SAMPLE — {sample_vid} ({video_data[sample_vid]['title']})")
    lines.append("")
    for spec in specs[:6]:  # first 6 settings only to keep report readable
        sname = spec["name"]
        segs = all_results[sname].get(sample_vid, {}).get("segs", [])
        row = next((r for r in rows if r[0] == sname), None)
        score_str = f"score={row[5]:.1f}" if row else ""
        lines.append(f"  --- {sname} ({len(segs)} segs, {score_str}) ---")
        for seg in segs[:4]:
            lines.append(f"    [{seg['start']:.1f}→{seg['end']:.1f}] {seg['text'][:80]}")
        lines.append("")

    report = "\n".join(lines)
    print("\n" + report)
    write_result_section(args.output, args.suite, report)
    print(f"\nSaved: {args.suite} section -> {args.output}")


if __name__ == "__main__":
    main()
