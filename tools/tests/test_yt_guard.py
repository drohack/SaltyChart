"""
tools/yt_guard.py - the enforced YouTube budget - tested offline.

Why this file exists at all: the guard shipped with zero repo tests while its
first version blocked `curl raw.githubusercontent.com/yt-dlp/...`, blocked
`echo "yt-dlp wiki FAQ"`, silently could not gate `ytimg.com`, and could not see
`curl .../api/translate/stream` - the very loop it was built to stop. Each of
those was found by the guard firing (or not firing) on a person mid-work. A
matcher is a list of decisions, and every decision here was wrong once, so every
one is pinned.

Runs in well under a second with no servers and no network. State goes to a
temp file, never `tools/.yt_budget.json`, so running this can neither consume
nor reset the real budget.

Every check prints one PASS/FAIL line naming its invariant; the mutation rows in
`mutation_audit.py` key on those names.
"""

import os
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
import yt_guard as g  # noqa: E402

fails = 0


def check(name: str, ok: bool, detail: str = "") -> None:
    global fails
    fails += not ok
    # `FAIL: <name>` is the string the mutation rows key on, so it must be
    # unambiguous against the PASS line for the same check.
    print(f"  {'PASS  ' if ok else 'FAIL: '}{name}{('  - ' + detail) if detail and not ok else ''}", flush=True)


def fresh_state() -> None:
    g._save({"calls": [], "blocked_until": 0, "blocks": []})


# Isolate: the real budget file must be untouchable from a test.
g.STATE_PATH = os.path.join(tempfile.mkdtemp(), "budget.json")
fresh_state()
NOW = time.time()

print("-- matcher: things that DO touch YouTube --", flush=True)
for cmd in g.INVOKE_SAMPLES:
    check(f"matcher positive: {cmd[:58]}", g.touches_youtube(cmd))
check("matcher positive: googlevideo media host",
      g.touches_youtube("curl -r 0-500 https://rr3---sn-x.googlevideo.com/videoplayback?x=1"))
check("matcher positive: youtu.be short link", g.touches_youtube("curl https://youtu.be/abc"))
check("matcher positive: nocookie embed host", g.touches_youtube("curl https://www.youtube-nocookie.com/embed/x"))

print("-- matcher: things that must NOT count (each one blocked a person once) --", flush=True)
NEGATIVES = (
    ("GitHub docs about yt-dlp", "curl https://raw.githubusercontent.com/yt-dlp/yt-dlp/master/README.md"),
    ("GitHub docs about transcript lib", "curl https://raw.githubusercontent.com/jdepoix/youtube-transcript-api/master/README.md"),
    ("prose mention in echo", 'echo "yt-dlp wiki FAQ" && sed -n 1,5p faq.md'),
    ("pip install", "py -3.13 -m pip install --upgrade yt-dlp"),
    ("word in a grep", "git log --oneline | grep youtube"),
    ("filename only", "sed -n '57,80p' ytdlp_faq.md"),
    ("compiling our script", "py -3.13 -m py_compile tools/local_translate.py backend/scripts/translate_stream.py"),
    ("git add our script", "git add tools/local_translate.py"),
    ("thumbnail CDN (frontend hotlinks it)", "curl https://i.ytimg.com/vi/abc/hqdefault.jpg"),
    ("unrelated", "ls -la"),
)
for why, cmd in NEGATIVES:
    check(f"matcher negative: {why}", not g.touches_youtube(cmd), cmd)

print("-- the settings.json pre-filter, read for real (the old check was a tautology) --", flush=True)
# The exact hook command as it shipped, with the ORIGINAL alternation. The
# first selftest compared samples against PREFILTER_TOKENS - this file's own
# copy of the grep - and stayed green while four invocation patterns were
# unreachable in the real hook. So: extract the alternation from a hook
# command string, and pin that the shipped one could NOT reach our scripts.
OLD_HOOK = ('f=$(mktemp); cat > "$f"; if grep -qiE \'yt-dlp|yt_dlp|youtube|youtu\\.be|googlevideo\' "$f"; '
            'then py -3.13 "$CLAUDE_PROJECT_DIR/tools/yt_guard.py" --hook < "$f"; fi; rm -f "$f"')
alt = g.extract_prefilter(OLD_HOOK)
check("the pre-filter extractor reads the grep alternation out of the hook command",
      alt == r"yt-dlp|yt_dlp|youtube|youtu\.be|googlevideo", repr(alt))
import re as _re
old_pat = _re.compile(alt or "(?!)", _re.IGNORECASE)
check("the shipped pre-filter could not reach local_translate.py",
      not g.prefilter_reaches(old_pat, "py -3.13 tools/local_translate.py --season SPRING --year 2026"))
check("the shipped pre-filter could not reach /api/translate/stream",
      not g.prefilter_reaches(old_pat, "curl -s -N http://localhost:3000/api/translate/stream?videoId=abc"))
widened = _re.compile((alt or "") + "|translat|bench_download|download_audio", _re.IGNORECASE)
for cmd in g.INVOKE_SAMPLES:
    check(f"a widened pre-filter reaches every invocation sample: {cmd[:44]}", g.prefilter_reaches(widened, cmd))
for h in g.YT_HOSTS:
    check(f"a widened pre-filter reaches every host: {h}", g.prefilter_reaches(widened, f"curl https://www.{h}/x"))
check("extractor returns None when there is no grep", g.extract_prefilter("echo hi") is None)

# The LIVE file, when present. SKIP (not PASS) when it or the hook is absent;
# FAIL when it is present but narrower than the matcher - which on a checkout
# whose owner has not yet widened the grep is the correct answer.
live = g.load_prefilter()
if live is None:
    print("  SKIP  live settings.json pre-filter reaches every sample (no settings.json / hook found)", flush=True)
else:
    unreachable = [c for c in g.INVOKE_SAMPLES if not g.prefilter_reaches(live, c)]
    check("live settings.json pre-filter reaches every sample", not unreachable,
          f"widen the grep in .claude/settings.json; unreachable: {unreachable!r}")

print("-- budget gates --", flush=True)
fresh_state()
ok, _ = g.check(NOW)
check("clean state allows", ok)
g.record(NOW)
ok, why = g.check(NOW + 1)
check("second call within MIN_INTERVAL is refused", not ok and "Too soon" in why, why)
ok, _ = g.check(NOW + g.MIN_INTERVAL_S + 1)
check("call after MIN_INTERVAL is allowed", ok)

fresh_state()
spaced = [NOW - 590 + i * (g.MIN_INTERVAL_S + 5) for i in range(g.BASE_MAX_PER_10_MIN)]
g._save({"calls": spaced, "blocked_until": 0, "blocks": []})
ok, why = g.check(NOW)
check("10-min cap enforced at exactly the cap", not ok and "per 10 minutes" in why, why)
g._save({"calls": spaced[:-1], "blocked_until": 0, "blocks": []})
ok, _ = g.check(NOW)
check("10-min cap allows one under the cap", ok)

fresh_state()
hourly = [NOW - 3500 + i * 150 for i in range(g.BASE_MAX_PER_HOUR)]
g._save({"calls": hourly, "blocked_until": 0, "blocks": []})
ok, why = g.check(NOW)
check("hourly cap enforced at exactly the cap", not ok and "per hour" in why, why)

print("-- blocks: cooldown, strikes, adaptive tightening --", flush=True)
fresh_state()
g.note_block(NOW)
st = g._load()
check("a block records a strike", len(st["blocks"]) == 1)
check("a block starts a cooldown", st["blocked_until"] > NOW)
ok, why = g.check(NOW + 1)
check("cooldown refuses", not ok and "cooldown" in why, why)
m10, mhr, cool = g.effective_limits({"blocks": []}, NOW)
check("0 strikes: baseline caps", (m10, mhr, cool) == (g.BASE_MAX_PER_10_MIN, g.BASE_MAX_PER_HOUR, g.BASE_COOLDOWN_S))
m10, mhr, cool = g.effective_limits({"blocks": [NOW - 100]}, NOW)
check("1 strike: caps halve, cooldown doubles",
      (m10, mhr, cool) == (g.BASE_MAX_PER_10_MIN // 2, g.BASE_MAX_PER_HOUR // 2, g.BASE_COOLDOWN_S * 2))
m10, mhr, cool = g.effective_limits({"blocks": [NOW - 100] * 6}, NOW)
check("6 strikes: floors hold, cooldown capped",
      (m10, mhr, cool) == (g.FLOOR_PER_10_MIN, g.FLOOR_PER_HOUR, g.MAX_COOLDOWN_S))
m10, _, _ = g.effective_limits({"blocks": [NOW - g.STRIKE_WINDOW_S - 1]}, NOW)
check("a strike older than the window no longer counts", m10 == g.BASE_MAX_PER_10_MIN)

print("-- --clear keeps the evidence --", flush=True)
g._save({"calls": [NOW], "blocked_until": NOW + 999, "blocks": [NOW - 100]})
sys.argv = ["yt_guard", "--clear"]
g.main()
st = g._load()
check("--clear resets calls and cooldown", st["calls"] == [] and st["blocked_until"] == 0)
check("--clear keeps strike history", len(st["blocks"]) == 1)

print("-- hook decision --", flush=True)
check("hook: bot-wall phrases detected", g.looks_blocked("youtube_transcript_api._errors.IpBlocked: blocked"))
check("hook: ordinary output not a block", not g.looks_blocked("Downloaded 24 fragments"))

total = fails
print(f"Done: {'FAIL' if total else 'PASS'} - {total} failing check(s)", flush=True)
sys.exit(1 if total else 0)
