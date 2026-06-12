"""
Swappable building blocks for the SaltyChart subtitle-pipeline bake-off.

The benchmark harness (`benchmark_whisper_settings.py`) composes these into a
pipeline per variant:

    audio source  ->  ASR  ->  (optional) translate  ->  (optional) align

so we can change one layer at a time and attribute every score delta.

Segment shape throughout is the same `{start, end, text}` dict used by
`local_translate.py` and the server cache, so a winning configuration can be
lifted straight into production later.

Phase 1 (Demucs) needs `pip install demucs`.
Phase 2 (Qwen translate) needs a local Ollama with a Qwen model pulled.
Phase 3 extras: `pip install whisperx sentencepiece` and the model weights.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
import urllib.request

# ---------------------------------------------------------------------------
# Model cache — lazy-load each backend once, reuse across all videos/variants
# ---------------------------------------------------------------------------

_models = {}


def _device_compute():
    try:
        import torch
        if torch.cuda.is_available():
            return "cuda", "float16"
    except ImportError:
        pass
    return "cpu", "int8"


def get_faster_whisper(model_name="large-v3"):
    """Lazy singleton faster-whisper model. `model_name` may be a built-in
    name (large-v3, large-v3-turbo, medium...) or a HF repo id / local path
    (e.g. kotoba-tech/kotoba-whisper-v2.0-faster)."""
    key = ("fw", model_name)
    if key not in _models:
        device, compute = _device_compute()
        from faster_whisper import WhisperModel
        print(f"[pipeline] loading faster-whisper '{model_name}' ({compute} on {device})...", flush=True)
        _models[key] = WhisperModel(model_name, device=device, compute_type=compute)
    return _models[key]


# ---------------------------------------------------------------------------
# Phase 1 — background-audio removal (Demucs vocal separation)
# ---------------------------------------------------------------------------

_demucs_model = None


def _get_demucs(model="htdemucs"):
    global _demucs_model
    if _demucs_model is None:
        from demucs.pretrained import get_model
        device, _ = _device_compute()
        print(f"[pipeline] loading Demucs '{model}' on {device}...", flush=True)
        m = get_model(model)
        m.to(device).eval()
        _demucs_model = m
    return _demucs_model


def release_demucs():
    """Free the cached Demucs model + GPU memory. Call after separation so Demucs
    isn't resident alongside the ASR model and the Ollama translator (which would
    blow a 10 GB card). The model reloads on the next separate_vocals call."""
    global _demucs_model
    _demucs_model = None
    try:
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except ImportError:
        pass


def _decode_ffmpeg(path, sr, channels):
    """Decode any audio file to a float32 torch tensor [channels, samples] at
    the requested sample rate via the ffmpeg *binary* (no torchaudio)."""
    import numpy as np
    import torch
    cmd = ["ffmpeg", "-v", "quiet", "-i", path,
           "-f", "f32le", "-ar", str(sr), "-ac", str(channels), "pipe:1"]
    ff = dict(stdout=subprocess.PIPE, check=True)
    if sys.platform == "win32":
        ff["creationflags"] = subprocess.CREATE_NO_WINDOW
    raw = subprocess.run(cmd, **ff).stdout
    arr = np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).T.copy()
    return torch.from_numpy(arr)


def separate_vocals(audio_path, out_path=None, model="htdemucs"):
    """Demucs vocal separation -> 16 kHz mono WAV, cached next to the source as
    `audio_vocals.wav` (generated once). Returns the vocals path.

    Audio I/O goes through the ffmpeg *binary* (decode to the model's native
    44.1 kHz stereo, encode the vocals stem back to 16 kHz mono). This avoids
    torchaudio's load/save, which on torchaudio>=2.9 require torchcodec +
    matching FFmpeg shared DLLs (unreliable on Windows). Demucs runs on CUDA.

    Note: benchmark_data audio is already 16 kHz mono, so separation works on
    upsampled audio — fine for a *relative* raw-vs-vocals comparison (both come
    from the same source); production could separate from higher-quality audio."""
    import torch
    from demucs.apply import apply_model

    if out_path is None:
        out_path = os.path.join(os.path.dirname(audio_path), "audio_vocals.wav")
    if os.path.exists(out_path) and os.path.getsize(out_path) > 0:
        return out_path

    m = _get_demucs(model)
    device, _ = _device_compute()
    # Prefer a high-quality source sibling (audio_hq.*) for separation — Demucs
    # is trained on 44.1 kHz stereo, so separating the 16 kHz mono benchmark wav
    # produces far worse artifacts. We still emit a 16 kHz mono stem for Whisper.
    import glob as _glob
    src = audio_path
    hq = _glob.glob(os.path.join(os.path.dirname(audio_path), "audio_hq.*"))
    if hq:
        src = hq[0]
    wav = _decode_ffmpeg(src, m.samplerate, m.audio_channels)  # [C, N]

    ref = wav.mean(0)
    std = ref.std() + 1e-8
    wav_n = (wav - ref.mean()) / std
    with torch.no_grad():
        sources = apply_model(m, wav_n[None].to(device), device=device,
                              progress=False, overlap=0.25)[0]
    sources = sources * std + ref.mean()
    vocals = sources[m.sources.index("vocals")].mean(0)  # [N] mono
    mono = vocals.detach().cpu().numpy().astype("float32")

    cmd = ["ffmpeg", "-y", "-f", "f32le", "-ar", str(m.samplerate), "-ac", "1",
           "-i", "pipe:0", "-ar", "16000", "-ac", "1", out_path]
    ff = dict(input=mono.tobytes(), check=True,
              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if sys.platform == "win32":
        ff["creationflags"] = subprocess.CREATE_NO_WINDOW
    subprocess.run(cmd, **ff)
    if not os.path.exists(out_path) or os.path.getsize(out_path) == 0:
        raise RuntimeError(f"ffmpeg failed to write vocals wav: {out_path}")
    return out_path


# ---------------------------------------------------------------------------
# ASR adapters — each returns [{start, end, text}, ...]
# ---------------------------------------------------------------------------

_FW_DEFAULTS = dict(
    language="ja", task="translate",
    vad_filter=True, beam_size=5,
    condition_on_previous_text=True,
    word_timestamps=True,
)


def _segs_from_fw(segs):
    out = []
    for seg in segs:
        text = seg.text.strip()
        if not text:
            continue
        w = seg.words
        out.append({
            "start": round(w[0].start if w else seg.start, 2),
            "end":   round(w[-1].end  if w else seg.end,   2),
            "text":  text,
        })
    return out


def asr_faster_whisper(audio_path, model_name="large-v3", **kwargs):
    """faster-whisper ASR. kwargs override _FW_DEFAULTS (task, beam_size,
    vad_filter, language, repetition_penalty, ...)."""
    model = get_faster_whisper(model_name)
    params = {**_FW_DEFAULTS, **kwargs}
    segs, _ = model.transcribe(audio_path, **params)
    return _segs_from_fw(segs)


_hf_pipes = {}


def asr_kotoba(audio_path, model_name="kotoba-tech/kotoba-whisper-v2.0",
               chunk_length_s=15, word_segments=True, max_seg_s=6.0, gap_s=0.6, **kwargs):
    """Japanese-specialised ASR via the HF transformers pipeline. We use
    transformers (not faster-whisper) because kotoba's distilled architecture
    segfaults ctranslate2 on this setup. Returns [{start,end,text}] (JP).

    word_segments=True requests WORD-level timestamps and groups them into
    sentence-level segments (break on sentence-ending punctuation, a >gap_s
    pause, or >max_seg_s duration) — this gives faster-whisper-comparable timing
    granularity instead of coarse 15 s chunk timestamps."""
    import torch
    from transformers import pipeline
    key = ("hf", model_name)
    if key not in _hf_pipes:
        device, _ = _device_compute()
        dtype = torch.float16 if device == "cuda" else torch.float32
        print(f"[pipeline] loading transformers ASR '{model_name}' ({dtype} on {device})...", flush=True)
        _hf_pipes[key] = pipeline(
            "automatic-speech-recognition", model=model_name,
            torch_dtype=dtype, device=0 if device == "cuda" else -1,
            chunk_length_s=chunk_length_s, batch_size=8,
        )
    pipe = _hf_pipes[key]
    res = pipe(audio_path, return_timestamps="word" if word_segments else True,
               generate_kwargs={"language": "ja", "task": "transcribe"})
    chunks = res.get("chunks", [])

    if not word_segments:
        out = []
        for ch in chunks:
            ts = ch.get("timestamp") or (None, None)
            text = (ch.get("text") or "").strip()
            if text and ts[0] is not None:
                end = ts[1] if ts[1] is not None else ts[0]
                out.append({"start": round(float(ts[0]), 2), "end": round(float(end), 2), "text": text})
        return out

    # Group word-level chunks into sentence-ish segments.
    out, buf, bstart, lastend = [], [], None, None

    def _flush():
        if buf:
            text = "".join(buf).strip()
            if text:
                out.append({"start": round(float(bstart), 2),
                            "end": round(float(lastend), 2), "text": text})

    for ch in chunks:
        ts = ch.get("timestamp") or (None, None)
        if ts[0] is None:
            continue
        s = float(ts[0])
        e = float(ts[1]) if ts[1] is not None else s
        word = ch.get("text") or ""
        if buf and (s - lastend > gap_s or (e - bstart) > max_seg_s):
            _flush(); buf, bstart = [], None
        if not buf:
            bstart = s
        buf.append(word)
        lastend = e
        if word.strip()[-1:] in "。！？!?":
            _flush(); buf, bstart = [], None
    _flush()
    return out


_qwen3asr_model = None


def _audio_duration(path):
    cmd = ["ffprobe", "-v", "quiet", "-show_entries", "format=duration",
           "-of", "default=nk=1:nw=1", path]
    ff = dict(capture_output=True, text=True, timeout=15)
    if sys.platform == "win32":
        ff["creationflags"] = subprocess.CREATE_NO_WINDOW
    try:
        return float(subprocess.run(cmd, **ff).stdout.strip())
    except Exception:
        return 90.0


def asr_qwen3(audio_path, model_repo="Qwen/Qwen3-ASR-1.7B", **kwargs):
    """Qwen3-ASR (current JP CER leader, ~2x lower than Whisper) via the official
    qwen-asr package. It returns one text blob; we split on Japanese sentence
    punctuation into segments. Timestamps here are EVEN-SPREAD approximations
    (real word timestamps need the separate Qwen3-ForcedAligner) — so for this
    arm judge the timing-independent `content` metric, not overlap/timing."""
    import re
    import torch
    global _qwen3asr_model
    if _qwen3asr_model is None:
        from qwen_asr import Qwen3ASRModel
        device, _ = _device_compute()
        print(f"[pipeline] loading Qwen3-ASR '{model_repo}'...", flush=True)
        _qwen3asr_model = Qwen3ASRModel.from_pretrained(
            model_repo, dtype=torch.bfloat16,
            device_map="cuda:0" if device == "cuda" else "cpu")
    res = _qwen3asr_model.transcribe(audio_path, language="Japanese")
    text = (res[0].text if res else "").strip()
    parts = [p.strip() for p in re.split(r"(?<=[。！？!?])", text) if p.strip()]
    if not parts:
        return []
    dur = _audio_duration(audio_path)
    n = len(parts)
    return [{"start": round(dur * i / n, 2), "end": round(dur * (i + 1) / n, 2), "text": p}
            for i, p in enumerate(parts)]


ASR_BACKENDS = {
    "faster_whisper": asr_faster_whisper,
    "kotoba": asr_kotoba,
    "qwen3": asr_qwen3,
}


# ---------------------------------------------------------------------------
# Translator adapters — take [{start,end,text(JP)}] -> same list, text->EN.
# Order and timestamps are preserved 1:1.
# ---------------------------------------------------------------------------

_ANIME_SYS_PROMPT = (
    "You are a professional anime subtitle translator. Translate each numbered "
    "Japanese line into natural, concise English subtitle text. Preserve "
    "character and place names. Keep exactly one output line per input line, "
    "prefixed with the same number, in the same order. Do not merge, split, "
    "add, or drop lines. Output only the numbered translations."
)


def _ollama_generate(prompt, model, host="http://127.0.0.1:11434", system=None,
                     think=False, temperature=0.0, keep_alive=None):
    # temperature 0 (greedy) for reproducible benchmark scores — at 0.2 the
    # translation varied several SCORE points run-to-run, making rankings noisy.
    body = {"model": model, "prompt": prompt, "stream": False,
            "think": think, "options": {"temperature": temperature, "seed": 1}}
    if system:
        body["system"] = system
    if keep_alive is not None:
        # e.g. 0 → unload the model right after this call (frees VRAM between videos)
        body["keep_alive"] = keep_alive
    req = urllib.request.Request(
        f"{host}/api/generate",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read().decode()).get("response", "")


def _parse_numbered(text, n):
    """Parse 'i. translation' lines back into a list of length n. Falls back to
    splitting on newlines; pads/truncates to n so timestamps stay aligned."""
    import re
    out = {}
    for line in text.splitlines():
        m = re.match(r"\s*(\d+)[\.\):]\s*(.*)", line)
        if m:
            idx = int(m.group(1))
            if 1 <= idx <= n:
                out[idx] = m.group(2).strip()
    if len(out) >= max(1, n // 2):  # enough matched -> trust numbering
        return [out.get(i + 1, "") for i in range(n)]
    # fallback: positional
    lines = [l.strip() for l in text.splitlines() if l.strip()]
    lines = (lines + [""] * n)[:n]
    return lines


def translate_ollama_qwen(segs, model="qwen3.5:9b", host="http://127.0.0.1:11434",
                          context=None, keep_alive=None):
    """Translate a whole trailer's lines in one Ollama call for coherence.

    Default qwen3.5:9b — benchmarked clearly better than text-only qwen3:8b on the
    bake-off corpus (content 57.3 vs 53.6, halluc 34.5% vs 41.0%; see suites
    `qwen359`/`qwen38`), so worth keeping despite a downside: the Ollama qwen3.5:9b
    build is a *vision* model whose ~1.2 GB vision encoder sits unused in RAM (the
    LLM itself runs 100% on GPU). qwen2.5 produces multilingual word-salad in this
    Ollama build — avoid. Thinking is disabled so the response is just the numbered
    translations.

    context: optional show name injected into the system prompt to help with
    proper nouns (character/place names). keep_alive: forwarded to Ollama (0 to
    unload the model after the call, freeing VRAM between videos)."""
    if not segs:
        return segs
    system = _ANIME_SYS_PROMPT
    if context:
        system += f" This dialogue is from the anime \"{context}\" — use it to get character and place names right."
    numbered = "\n".join(f"{i + 1}. {s['text']}" for i, s in enumerate(segs))
    resp = _ollama_generate(numbered, model, host=host, system=system, keep_alive=keep_alive)
    translations = _parse_numbered(resp, len(segs))
    out = []
    for s, t in zip(segs, translations):
        out.append({**s, "text": t or s["text"]})
    return out


def translate_nllb(segs, model_name="facebook/nllb-200-distilled-1.3B"):  # Phase 3
    raise NotImplementedError("NLLB adapter not implemented yet (Phase 3)")


def translate_opusmt(segs, model_name="Helsinki-NLP/opus-mt-ja-en"):       # Phase 3
    raise NotImplementedError("Opus-MT adapter not implemented yet (Phase 3)")


TRANSLATORS = {
    "ollama_qwen": translate_ollama_qwen,
    "nllb": translate_nllb,
    "opusmt": translate_opusmt,
}


# ---------------------------------------------------------------------------
# Alignment — Phase 3 (WhisperX forced alignment for tight timestamps)
# ---------------------------------------------------------------------------

def align_whisperx(segs, audio_path, language="ja"):  # Phase 3
    raise NotImplementedError("whisperx aligner not implemented yet (Phase 3)")


ALIGNERS = {
    "whisperx": align_whisperx,
}


# ---------------------------------------------------------------------------
# Timing metric — span IoU of each segment against the nearest CC span
# ---------------------------------------------------------------------------

def score_timing(whisper_segs, cc_segs):
    """Mean intersection-over-union (%) of each Whisper segment's [start,end]
    against its best-overlapping CC segment. 0 if either side is empty.

    Unlike the ±4s semantic score, this rewards *tight* timestamps — the metric
    forced alignment / WhisperX is meant to move in Phase 3."""
    if not whisper_segs or not cc_segs:
        return 0.0
    ious = []
    for seg in whisper_segs:
        s, e = seg["start"], seg["end"]
        best = 0.0
        for cs in cc_segs:
            inter = max(0.0, min(e, cs["end"]) - max(s, cs["start"]))
            if inter <= 0:
                continue
            union = max(e, cs["end"]) - min(s, cs["start"])
            if union > 0:
                best = max(best, inter / union)
        ious.append(best)
    return sum(ious) / len(ious) * 100 if ious else 0.0
