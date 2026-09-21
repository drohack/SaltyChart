"""
Rate-limit everything this repo does to YouTube, and make it ENFORCED.

WHY THIS EXISTS. The written rule in `.claude/rules/tools.md` bounds
*concurrency* - never parallelise downloads, never retry through a bot
challenge. Both were obeyed, serially, and YouTube's IP block was tripped
anyway, because nothing bounded *volume*: roughly 30 requests in 35 minutes of
ad-hoc verification. A blocked IP then stops you verifying the very fix you were
testing, which is the expensive part - it does not just slow the session down,
it removes the ability to check your work.

Advisory documentation has now failed at this more than once, so this is a gate
rather than a paragraph. It is used two ways:

  * as a **PreToolUse hook** (see `.claude/settings.json`), which refuses a
    shell command that would touch YouTube too soon or too often; and
  * as a **library** for scripts: `from yt_guard import request_slot`.

DESIGN NOTES, so the next person does not "simplify" this into uselessness:

  * State lives in a FILE, not memory, because every check is a separate
    process. In-memory counters were the original sin in this repo's AniList
    pacing too - they read zero on every fresh process.
  * A detected block starts a hard cooldown. Continuing to poke a blocked IP is
    what turns a ten-minute timeout into an hour-long one.
  * It bounds *dev tooling*, not the running backend. A viewer watching a
    trailer is real traffic with its own pacing; this is about verification
    loops, which are the ones that burst.
"""

import json
import os
import re
import sys
import time

# --- Budgets -----------------------------------------------------------------
# HONESTY NOTE, because the numbers look more authoritative than they are:
#
# **There is no published limit, and no header tells you where you stand.**
# Checked 2026-09-20 against primary sources, not blog posts:
#
#   * A GET to a youtube.com watch page returns NO rate-limit headers of any
#     kind - no `Retry-After`, no `X-RateLimit-*`, no quota field. (Probed
#     directly; the full header list is 24 entries and none of them counts.)
#   * yt-dlp's README (raw, line ~1182) SHIPS a pacing recommendation as a
#     preset, and this file wrongly said it did not until the raw text was
#     grepped rather than summarised:
#         -t sleep    --sleep-subtitles 5 --sleep-requests 0.75
#                     --sleep-interval 10 --max-sleep-interval 20
#     i.e. 0.75 s between extraction requests and a random 10-20 s before each
#     download. None of these apply unless you opt in; the installed package
#     has no default for any of them. It is a pacing suggestion, not a limit -
#     the README states no requests-per-minute figure anywhere.
#   * yt-dlp's wiki FAQ on 429/402: "the service is blocking your IP address
#     because of overuse. Usually this is a soft block" - remedy is a CAPTCHA
#     in a browser plus `--cookies`. No number for what overuse is.
#   * youtube-transcript-api's README (raw, line ~306): "Same can happen to the
#     IP of your self-hosted solution, if you are doing too many requests." No
#     number for what too many is; its only suggested remedy is rotating
#     residential proxies, and it warns even those can be blocked.
#   * The official YouTube Data API does publish quotas, but it cannot download
#     media, and `captions.download` requires edit permission on the video - so
#     it is not a path available to us.
#
# Nobody publishes the threshold, and it is not purely volume anyway: IP origin
# and ASN matter, and a cloud IP can be refused on its first ever call.
#
# The consequence is the important part: **there is no gradient.** Calls succeed,
# silently, until one doesn't. Nothing counts down, so nothing can warn you, and
# an agent obeying every written rule walks off the cliff at full speed. That is
# exactly what happened.
#
# So these are NOT the limit. They are a deliberately conservative margin, whose
# only empirical anchor is the run that broke: ~30 calls in ~35 minutes. Treat
# them as a speed limit set well below where the road is known to end.
#
# Because a fixed guess cannot learn, the caps below are a BASELINE that
# `effective_limits()` tightens automatically from the only real evidence we
# ever get - our own blocks. See that function.
MIN_INTERVAL_S = 20        # never two YouTube touches closer together than this
BASE_MAX_PER_10_MIN = 6
BASE_MAX_PER_HOUR = 20
BASE_COOLDOWN_S = 30 * 60  # a detected block parks everything at least this long

# A block counts against us for this long. Community-reported IP-block resets run
# 24-48 h, so a week keeps the memory well past the event itself.
STRIKE_WINDOW_S = 7 * 24 * 3600
# Floors: however many strikes, still allow a trickle, or the repo becomes
# unworkable and someone deletes the guard instead of respecting it.
FLOOR_PER_10_MIN = 1
FLOOR_PER_HOUR = 3
MAX_COOLDOWN_S = 6 * 3600

STATE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".yt_budget.json")

# What counts as "talking to YouTube". Two kinds of evidence, both precise:
#
#  1. A YouTube-owned HOST in the command. `googlevideo.com` matters as much as
#     `youtube.com` - the media URLs live there, and curl-ing them directly is
#     exactly what was being done when the block landed.
#  2. INVOKING a YouTube client: the yt-dlp binary, `python -m yt_dlp`, an
#     `import yt_dlp`, or `youtube_transcript_api` (the import name).
#
# Deliberately NOT a bare substring match. The first version matched "yt-dlp"
# and "youtube" anywhere, and blocked `curl raw.githubusercontent.com/yt-dlp/...`
# - fetching yt-dlp's own documentation from GitHub, which touches YouTube not
# at all. A guard that blocks reading the docs about the thing it guards is one
# people learn to route around, and then it protects nothing.
# Every host here must contain a PREFILTER_TOKENS substring (see --selftest).
# `ytimg.com` is deliberately absent: it is the thumbnail CDN the frontend
# hotlinks on every card, not a scraping surface, and no pre-filter token
# reaches it.
YT_HOSTS = ("youtube.com", "youtu.be", "googlevideo.com", "youtube-nocookie.com")
_HOST_RE = re.compile(
    r"(?<![a-z0-9.-])(?:[a-z0-9-]+\.)*(?:" + "|".join(re.escape(h) for h in YT_HOSTS) + r")\b",
    re.IGNORECASE,
)
#
# The binary only counts when it is being RUN - followed by a flag or a URL.
# `echo "yt-dlp wiki FAQ"` and `pip install --upgrade yt-dlp` both contain the
# word and neither touches YouTube; both were blocked by the looser version.
# Importing the module still counts even for a version check, on purpose: the
# cost of one wasted slot is nothing next to the cost of a missed download.
_INVOKE_RE = re.compile(
    r"(?:(?<![\w/.-])yt-dlp\s+(?:-|https?://))"  # yt-dlp -f ... / yt-dlp https://...
    r"|(?:-m\s+yt_dlp\b)"                         # python -m yt_dlp
    r"|(?:\bimport\s+yt_dlp\b)|(?:\bfrom\s+yt_dlp\b)|(?:\byt_dlp\.)"
    r"|(?:\byoutube_transcript_api\b)"            # import name, underscored
    # Our OWN scripts and endpoint. These wrap yt-dlp internally, so a command
    # that runs them names no YouTube token at all - and the guard was blind to
    # exactly the verification loop (`curl .../api/translate/stream`) that it
    # was built to stop. "Run" means a python launcher followed by the script:
    # `py -3.13 tools/local_translate.py ...` counts, `-m py_compile x.py` and
    # `git add x.py` do not.
    r"|(?:(?:^|[\s;&|(])py(?:thon3?)?(?:\s+-\S+)*\s+\S*(?:local_translate|batch_translate|translate_stream|bench_download)\.py\b)"
    r"|(?:/api/translate/stream\b)"
    r"|(?:\bdownload_audio\s*\()",
    re.IGNORECASE,
)

# Phrases in output that mean YouTube has started refusing us. ONE definition,
# in backend/scripts/translate_stream.py (stdlib-only at import time, so cheap
# even on the hook path). The fallback exists because this file runs as a
# PreToolUse hook and must never crash a developer's command - but it is a
# safety net for a broken checkout, not a second definition, and
# test_yt_guard.py asserts it equals the real one.
try:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend", "scripts"))
    from translate_stream import BOT_WALL_SIGNS as BLOCK_SIGNS  # noqa: E402
except Exception:
    BLOCK_SIGNS = ("sign in to confirm", "not a bot", "ipblocked", "requestblocked",
                   "too many requests", "http error 429")

# Tokens the PreToolUse pre-filter in `.claude/settings.json` greps for before
# it bothers spawning this script. That grep is a SUPERSET gate, so every host
# in _HOST_RE MUST contain one of these substrings or it can never be gated -
# `ytimg.com` was listed here once with no token that reached it, and would
# have passed silently for ever. `--selftest` asserts the invariant.
PREFILTER_TOKENS = ("yt-dlp", "yt_dlp", "youtube", "youtu.be", "googlevideo",
                    # our own YouTube-touching scripts and endpoint - see _INVOKE_RE
                    "translat", "bench_download", "download_audio")


# One representative command per _INVOKE_RE alternative. --selftest asserts each
# still matches AND is reached by the LIVE .claude/settings.json pre-filter;
# test_yt_guard.py reuses the same list. Add a sample when you add a pattern.
INVOKE_SAMPLES = (
    "yt-dlp -f worstaudio https://example.invalid/x",
    "py -3.13 -m yt_dlp --simulate https://example.invalid/x",
    'py -3.13 -c "import yt_dlp; yt_dlp.YoutubeDL()"',
    'py -3.13 -c "from youtube_transcript_api import YouTubeTranscriptApi"',
    "py -3.13 tools/local_translate.py --season SPRING --year 2026",
    "PYTHONUNBUFFERED=1 python3 -u backend/scripts/batch_translate.py --dry-run",
    "py -3.13 tools/bench_download.py",
    "curl -s -N http://localhost:3000/api/translate/stream?videoId=abc",
    'py -3.13 -c "download_audio(vid, tmp)"',
)


# --- The settings.json pre-filter, read for real ------------------------------
# The PreToolUse hook in .claude/settings.json greps the command with a fixed
# alternation BEFORE spawning this script, so anything that grep does not match
# is never gated - whatever _HOST_RE/_INVOKE_RE say. The first `--selftest`
# compared samples against PREFILTER_TOKENS, this file's own transcription of
# that grep: a tautology that stayed green while the real file was stale and
# four invocation patterns were unreachable. These read the live file.
SETTINGS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".claude", "settings.json")
_GREP_RE = re.compile(r"grep\s+-q\w*\s+'((?:[^'\\]|\\.)*)'")


def extract_prefilter(command: str):
    """The alternation inside `grep -qiE '...'` of a hook command, or None."""
    m = _GREP_RE.search(command or "")
    return m.group(1) if m else None


def load_prefilter(path: str = SETTINGS_PATH):
    """The live pre-filter as a compiled regex (grep -i), or None if the file,
    the PreToolUse hook that runs this script, or its grep cannot be found."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            settings = json.load(fh)
        for entry in (settings.get("hooks") or {}).get("PreToolUse") or []:
            for hook in entry.get("hooks") or []:
                cmd = hook.get("command") or ""
                if "yt_guard.py" in cmd:
                    alt = extract_prefilter(cmd)
                    return re.compile(alt, re.IGNORECASE) if alt else None
    except Exception:
        return None
    return None


def prefilter_reaches(pat, sample: str) -> bool:
    """Would the hook's grep let this command through to the matcher?"""
    return pat.search(sample) is not None


def touches_youtube(command: str) -> bool:
    cmd = command or ""
    return bool(_HOST_RE.search(cmd) or _INVOKE_RE.search(cmd))


def looks_blocked(text: str) -> bool:
    low = (text or "").lower()
    return any(s in low for s in BLOCK_SIGNS)


def _load() -> dict:
    try:
        with open(STATE_PATH, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        if not isinstance(data, dict):
            raise ValueError
        data.setdefault("calls", [])
        data.setdefault("blocked_until", 0)
        data.setdefault("blocks", [])
        return data
    except Exception:
        # Unreadable or absent state must never hard-fail a developer's command;
        # it just means "no history", which is the safe direction here.
        return {"calls": [], "blocked_until": 0, "blocks": []}


def effective_limits(state: dict, now: float) -> tuple[int, int, int]:
    """Current caps, tightened by our own block history.

    This is the answer to "are those numbers just guesses". The baseline is a
    guess - it has to be, since nothing external reports a limit - but it does
    not have to STAY one. Every block we actually observe is hard evidence that
    the budget was too loose, so each strike in the last week halves the caps and
    doubles the cooldown. No strikes for a week and it relaxes back on its own.

    Returns (per_10_min, per_hour, cooldown_seconds).
    """
    strikes = len([t for t in state.get("blocks", []) if now - t < STRIKE_WINDOW_S])
    shrink = 2 ** strikes
    return (
        max(FLOOR_PER_10_MIN, BASE_MAX_PER_10_MIN // shrink),
        max(FLOOR_PER_HOUR, BASE_MAX_PER_HOUR // shrink),
        min(MAX_COOLDOWN_S, BASE_COOLDOWN_S * shrink),
    )


def _save(state: dict) -> None:
    try:
        tmp = STATE_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(state, fh)
        os.replace(tmp, STATE_PATH)
    except Exception:
        pass


def check(now: float | None = None) -> tuple[bool, str]:
    """May we touch YouTube right now? Returns (allowed, reason_if_not).

    Pure-ish: reads state, decides, does NOT record. `record()` is separate so
    the hook can decline without consuming budget.
    """
    now = time.time() if now is None else now
    st = _load()
    max10, maxhr, _cool = effective_limits(st, now)
    strikes = len([t for t in st.get("blocks", []) if now - t < STRIKE_WINDOW_S])
    tight = f" (tightened by {strikes} block(s) in the last week)" if strikes else ""

    if now < st.get("blocked_until", 0):
        wait = int(st["blocked_until"] - now)
        return False, (
            f"YouTube returned a block/rate-limit recently, so this repo is in a "
            f"cooldown with {wait // 60}m {wait % 60}s left. "
            f"Poking a blocked IP extends the block. Do something else, or clear "
            f"the cooldown deliberately with: py -3.13 tools/yt_guard.py --clear"
        )

    calls = [t for t in st.get("calls", []) if now - t < 3600]

    if calls and now - max(calls) < MIN_INTERVAL_S:
        wait = int(MIN_INTERVAL_S - (now - max(calls))) + 1
        return False, (
            f"Too soon: YouTube calls are paced to one per {MIN_INTERVAL_S}s. "
            f"Wait {wait}s. Stage your verification instead of looping."
        )

    recent10 = [t for t in calls if now - t < 600]
    if len(recent10) >= max10:
        wait = int(600 - (now - min(recent10))) + 1
        return False, (
            f"Budget: {max10} YouTube calls per 10 minutes{tight} is the cap and "
            f"{len(recent10)} have been made. Next slot in ~{wait}s. This cap exists "
            f"because bursts are what trip the IP block."
        )

    if len(calls) >= maxhr:
        wait = int(3600 - (now - min(calls))) + 1
        return False, (
            f"Budget: {maxhr} YouTube calls per hour{tight} is the cap and "
            f"{len(calls)} have been made. Next slot in ~{wait // 60}m. "
            f"If you genuinely need more, say so - do not raise this silently."
        )

    return True, ""


def record(now: float | None = None) -> None:
    """Consume one slot."""
    now = time.time() if now is None else now
    st = _load()
    st["calls"] = [t for t in st.get("calls", []) if now - t < 3600] + [now]
    _save(st)


def note_block(now: float | None = None) -> None:
    """YouTube told us to go away.

    Records a STRIKE as well as parking everything, because a block is the only
    hard evidence we ever get that the budget was too generous. The next
    `effective_limits()` halves the caps and doubles the cooldown off the back of
    it, so the guard converges toward whatever the real (unpublished) limit is
    instead of sitting on a guess for ever.
    """
    now = time.time() if now is None else now
    st = _load()
    st["blocks"] = [t for t in st.get("blocks", []) if now - t < STRIKE_WINDOW_S] + [now]
    _, _, cooldown = effective_limits(st, now)
    st["blocked_until"] = now + cooldown
    _save(st)


def request_slot(label: str = "") -> None:
    """Library entry point: block until a slot is free, then consume it.

    Scripts should call this before every YouTube request. It SLEEPS rather than
    raising for the ordinary "too soon" case (that is just pacing), but raises on
    a cooldown or an exhausted budget, because those mean stop, not wait.
    """
    while True:
        ok, why = check()
        if ok:
            record()
            return
        if "Too soon" not in why:
            raise RuntimeError(f"yt_guard refused{' (' + label + ')' if label else ''}: {why}")
        m = re.search(r"Wait (\d+)s", why)
        time.sleep(int(m.group(1)) if m else MIN_INTERVAL_S)


def _hook() -> int:
    """PreToolUse hook: read the tool call on stdin, allow or deny."""
    try:
        payload = json.load(sys.stdin)
    except Exception:
        return 0  # unparseable input must never block ordinary work
    cmd = (payload.get("tool_input") or {}).get("command", "")
    if not touches_youtube(cmd):
        return 0

    ok, why = check()
    if ok:
        record()
        return 0

    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                f"BLOCKED by tools/yt_guard.py - {why}\n\n"
                "This is an enforced budget, not a suggestion: ad-hoc verification "
                "loops tripped YouTube's IP block before, which then prevented "
                "verifying the fix at all. Re-read tools/yt_guard.py before "
                "changing the numbers."
            ),
        }
    }))
    return 0


def main() -> int:
    args = sys.argv[1:]
    if "--hook" in args:
        return _hook()
    if "--clear" in args:
        st = _load()
        # Strikes deliberately SURVIVE --clear: clearing is for "I know this
        # cooldown is stale", not for erasing the evidence that set the caps.
        _save({"calls": [], "blocked_until": 0, "blocks": st.get("blocks", [])})
        print("yt_guard: budget and cooldown cleared (block history kept)", flush=True)
        return 0
    if "--selftest" in args:
        # Against the LIVE .claude/settings.json - not this file's own tokens.
        # Every host and every invocation sample must be reachable by the hook's
        # grep, or the matcher never runs for it; and every PREFILTER_TOKENS
        # entry must appear in that grep, so drift in either direction is named.
        pat = load_prefilter()
        if pat is None:
            print(f"yt_guard: FAIL - could not read a PreToolUse hook running yt_guard.py from {os.path.normpath(SETTINGS_PATH)}", flush=True)
            return 1
        bad = []
        for h in YT_HOSTS:
            if not prefilter_reaches(pat, f"curl https://www.{h}/x"):
                bad.append(f"host unreachable by the live pre-filter: {h}")
        for cmd in INVOKE_SAMPLES:
            if not touches_youtube(cmd):
                bad.append(f"sample no longer matches the matcher: {cmd!r}")
            elif not prefilter_reaches(pat, cmd):
                bad.append(f"sample unreachable by the live pre-filter: {cmd!r}")
        for tok in PREFILTER_TOKENS:
            if tok.replace(".", r"\.") not in pat.pattern and tok not in pat.pattern:
                bad.append(f"PREFILTER_TOKENS entry missing from settings.json grep: {tok!r}")
        if bad:
            print(f"yt_guard: FAIL - {len(bad)} case(s); live pre-filter is /{pat.pattern}/:", flush=True)
            for b in bad: print(f"  {b}", flush=True)
            print("  fix: widen the grep in .claude/settings.json to include every PREFILTER_TOKENS entry", flush=True)
            return 1
        print(f"yt_guard: OK - {len(YT_HOSTS)} host(s) and {len(INVOKE_SAMPLES)} invocation sample(s) reachable by the LIVE pre-filter /{pat.pattern}/", flush=True)
        return 0
    if "--blocked" in args:
        note_block()
        st = _load()
        _, _, cool = effective_limits(st, time.time())
        print(f"yt_guard: strike recorded, cooldown {cool // 60} minutes", flush=True)
        return 0
    # Default: report status, so "can I call YouTube?" is answerable at a glance.
    now = time.time()
    st = _load()
    calls = [t for t in st.get("calls", []) if now - t < 3600]
    max10, maxhr, cool = effective_limits(st, now)
    strikes = len([t for t in st.get("blocks", []) if now - t < STRIKE_WINDOW_S])
    ok, why = check(now)
    print(f"yt_guard: {'OK' if ok else 'REFUSING'}", flush=True)
    print(f"  calls in last 10 min: {len([t for t in calls if now - t < 600])}/{max10}", flush=True)
    print(f"  calls in last hour:   {len(calls)}/{maxhr}", flush=True)
    print(f"  blocks in last 7 days: {strikes} (cooldown would be {cool // 60}m)", flush=True)
    if st.get("blocked_until", 0) > now:
        print(f"  cooldown: {int(st['blocked_until'] - now)}s remaining", flush=True)
    if not ok:
        print(f"  reason: {why}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
