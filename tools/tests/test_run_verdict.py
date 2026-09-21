"""
Does a batch run that mostly failed say so? `translate_stream.run_verdict`.

Why this exists: both batch scripts counted download errors, printed them in a
per-season summary, and then fell off the end of main() with exit code 0. The
Sunday GPU run logged `FALL 2026: 3 translated, 46 errors` four Sundays running
while Task Scheduler showed lastResult=0x0 - a 403 on nearly every trailer,
reported as success, for a month. The verdict function is the missing half of
that design, and this pins what it must and must not fail.

Offline, sub-second. Every check prints a `PASS  `/`FAIL: ` line the mutation
rows key on.
"""

import io
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "backend", "scripts"))
import translate_stream as ts  # noqa: E402

fails = 0


def check(name, ok, detail=""):
    global fails
    fails += not ok
    print(f"  {'PASS  ' if ok else 'FAIL: '}{name}{('  - ' + detail) if detail and not ok else ''}", flush=True)


print("-- the case that shipped silently --", flush=True)
code, line = ts.run_verdict(49, 46, {"forbidden": 44, "other": 2})
check("46 of 49 failures is a failed run", code == 2, f"code={code} line={line!r}")
check("the verdict names the stale-yt-dlp remedy for a 403 run", "stale yt-dlp" in line and "pip install -U yt-dlp" in line, line)
check("the verdict line starts with Done: so the status bar reads it", line.startswith("Done: FAILED"), line)
check("the verdict carries the numbers", "46 of 49" in line and "44 forbidden" in line, line)

print("-- what must NOT fail a run --", flush=True)
code, line = ts.run_verdict(49, 2, {"unavailable": 2})
check("two private trailers are not a failed run", code == 0, f"code={code} line={line!r}")
code, line = ts.run_verdict(0, 0)
check("nothing to do is a clean run", code == 0, f"code={code}")
code, line = ts.run_verdict(49, 3, {"unavailable": 3})
check("3 failures of 49 (6%) is under the ratio", code == 0, f"code={code}")
code, line = ts.run_verdict(3, 2, {"forbidden": 2})
check("2 failures of 3 is under RUN_FAIL_MIN even at 67%", code == 0, f"code={code}")

print("-- edges of the two thresholds --", flush=True)
code, _ = ts.run_verdict(4, 3, {"forbidden": 3})
check("3 of 4 (75%, at RUN_FAIL_MIN) fails", code == 2, f"code={code}")
code, _ = ts.run_verdict(6, 3, {"forbidden": 3})
check("3 of 6 (exactly 50%) does NOT fail - ratio is strictly greater", code == 0, f"code={code}")
code, _ = ts.run_verdict(6, 4, {"forbidden": 4})
check("4 of 6 (67%) fails", code == 2, f"code={code}")

print("-- a bot wall aborts with its own code --", flush=True)
code, line = ts.run_verdict(10, 1, {"botwall": 1}, aborted=True)
check("aborted run exits 3 regardless of ratio", code == 3, f"code={code}")
check("aborted line says to wait, not to upgrade", "wait out the cooldown" in line, line)

print("-- classification feeding the breakdown --", flush=True)
check("403 classifies forbidden", ts.classify_error(Exception("HTTP Error 403: Forbidden")) == "forbidden")
check("bot phrase inside a 403 classifies botwall (phrase outranks status)",
      ts.classify_error(Exception("HTTP Error 403: Forbidden. Sign in to confirm you're not a bot")) == "botwall")
check("private video classifies unavailable", ts.classify_error(Exception("Private video")) == "unavailable")

print("-- the CC check has THREE answers, and only two are verdicts --", flush=True)
# Exception classes named like youtube_transcript_api's, defined here so this
# stays offline and independent of whether the package is installed. The
# classifier matches NAMES through the MRO, which is what makes that possible.
class CouldNotRetrieveTranscript(Exception): pass
class NoTranscriptFound(CouldNotRetrieveTranscript): pass
class TranscriptsDisabled(CouldNotRetrieveTranscript): pass
class VideoUnavailable(CouldNotRetrieveTranscript): pass
class IpBlocked(CouldNotRetrieveTranscript): pass
class RequestBlocked(CouldNotRetrieveTranscript): pass
class YouTubeRequestFailed(CouldNotRetrieveTranscript): pass
class PoTokenRequired(CouldNotRetrieveTranscript): pass
check("no transcript found is a definitive no", ts.classify_check_exception(NoTranscriptFound()) is False)
check("transcripts disabled is a definitive no", ts.classify_check_exception(TranscriptsDisabled()) is False)
check("video unavailable is a definitive no", ts.classify_check_exception(VideoUnavailable()) is False)
check("an IP block is not a verdict", ts.classify_check_exception(IpBlocked()) is None)
check("a request block is not a verdict", ts.classify_check_exception(RequestBlocked()) is None)
check("a failed YouTube request is not a verdict", ts.classify_check_exception(YouTubeRequestFailed()) is None)
check("a PO-token demand is not a verdict", ts.classify_check_exception(PoTokenRequired()) is None)
check("a missing package (ImportError) is not a verdict", ts.classify_check_exception(ImportError("x")) is None)
check("an unknown exception is not a verdict", ts.classify_check_exception(RuntimeError("boom")) is None)

# Drive check_subtitles itself through a FAKE youtube_transcript_api module so
# nothing touches the network: one that blocks (a timeout must leave the
# verdict unknown, not False) and one that raises IpBlocked.
import types, threading
fake = types.ModuleType("youtube_transcript_api")
_ev = threading.Event()
class _StuckApi:
    def list(self, vid):
        _ev.wait(5)  # released after the check returns; never let a test thread linger
        raise RuntimeError("released")
fake.YouTubeTranscriptApi = _StuckApi
saved = sys.modules.get("youtube_transcript_api")
sys.modules["youtube_transcript_api"] = fake
try:
    r = ts.check_subtitles("fake-timeout", timeout=0.2)
    check("a timeout leaves the verdict unknown", r.get("hasEnglish") is None and r.get("checkError") == "timeout", repr(r))
    _ev.set()
    class _BlockedApi:
        def list(self, vid): raise IpBlocked("blocked")
    fake.YouTubeTranscriptApi = _BlockedApi
    r = ts.check_subtitles("fake-blocked", timeout=2)
    check("an IP block during the check is not written as no-CC", r.get("hasEnglish") is None and r.get("checkError") == "IpBlocked", repr(r))
    class _NoneApi:
        def list(self, vid): raise NoTranscriptFound("none")
    fake.YouTubeTranscriptApi = _NoneApi
    r = ts.check_subtitles("fake-none", timeout=2)
    check("no transcript during the check is a definitive False with no checkError", r.get("hasEnglish") is False and "checkError" not in r, repr(r))
    class _Track: pass
    class _YesApi:
        def list(self, vid):
            class L:
                def find_transcript(self, langs): return _Track()
            return L()
    fake.YouTubeTranscriptApi = _YesApi
    r = ts.check_subtitles("fake-yes", timeout=2)
    check("a found track is True with no checkError", r.get("hasEnglish") is True and "checkError" not in r, repr(r))
finally:
    _ev.set()
    if saved is not None: sys.modules["youtube_transcript_api"] = saved
    else: sys.modules.pop("youtube_transcript_api", None)

# The names we match must be names the installed package actually raises. This
# runs ONLY when the package is present and SKIPs (not PASSes) otherwise - the
# dev PC has it, a fresh checkout may not. No network: it imports a module.
try:
    import importlib
    errs = importlib.import_module("youtube_transcript_api._errors")
    missing = [n for n in ts.DEFINITIVE_NO_CC if not hasattr(errs, n)]
    check("every DEFINITIVE_NO_CC name exists in the installed youtube_transcript_api", not missing, repr(missing))
except ImportError:
    print("  SKIP  every DEFINITIVE_NO_CC name exists in the installed youtube_transcript_api (package not installed)", flush=True)

print("-- MODEL_RANK: one Python definition, one TypeScript, equal --", flush=True)
import ast, json, subprocess
BACKEND = os.path.join(HERE, "..", "..", "backend")
try:
    out = subprocess.run(
        ["node", "--require", "ts-node/register", "-e",
         "const m=require('./src/lib/subtitleReport'); process.stdout.write(JSON.stringify(m.MODEL_RANK))"],
        cwd=BACKEND, capture_output=True, text=True, timeout=60)
    ts_rank = json.loads(out.stdout.strip()) if out.returncode == 0 else None
    check("Python MODEL_RANK equals the TypeScript copy", ts_rank == ts.MODEL_RANK,
          f"ts={ts_rank!r} py={ts.MODEL_RANK!r} rc={out.returncode} err={out.stderr[-200:]!r}")
except Exception as e:  # node or ts-node missing is a FAIL, not a skip - the gate needs both
    check("Python MODEL_RANK equals the TypeScript copy", False, f"could not run ts-node: {e}")
check("CHAMPION is the top rank", ts.MODEL_RANK.get(ts.CHAMPION) == max(ts.MODEL_RANK.values()), repr(ts.CHAMPION))
# Neither script may assign its own copy; local_translate imports torch so it
# cannot be imported here, hence a syntax-tree check on both files.
for rel in ("../../backend/scripts/batch_translate.py", "../local_translate.py"):
    path = os.path.normpath(os.path.join(HERE, rel))
    tree = ast.parse(io.open(path, encoding="utf-8").read(), path)
    assigns = [n for n in ast.walk(tree) if isinstance(n, ast.Assign)
               and any(isinstance(t, ast.Name) and t.id == "MODEL_RANK" for t in n.targets)]
    imports = [n for n in ast.walk(tree) if isinstance(n, ast.ImportFrom) and n.module == "translate_stream"
               and any(a.name == "MODEL_RANK" for a in n.names)]
    check(f"{os.path.basename(path)} imports MODEL_RANK rather than redefining it", not assigns and imports,
          f"assigns={len(assigns)} imports={len(imports)}")

print("-- ensure_ytdlp_current: an old pip is retried without --break-system-packages --", flush=True)
calls = []
class _R:
    def __init__(self, rc, err=""): self.returncode, self.stdout, self.stderr = rc, "", err
def _fake_run(cmd, **kw):
    calls.append(list(cmd))
    if "pip" in cmd and "--break-system-packages" in cmd:
        return _R(2, "Usage: pip install [options]\n\nno such option: --break-system-packages")
    if "pip" in cmd:
        return _R(0)
    return _R(0)
_real_run = ts.subprocess.run
_real_ver = getattr(ts, "_ytdlp_version", None)
ts.subprocess.run = _fake_run
try:
    said = []
    ts.ensure_ytdlp_current(say=said.append, timeout_s=1)
finally:
    ts.subprocess.run = _real_run
pip_calls = [c for c in calls if "pip" in c]
check("an old pip's 'no such option' triggers exactly one retry without the flag",
      len(pip_calls) == 2 and "--break-system-packages" in pip_calls[0] and "--break-system-packages" not in pip_calls[1],
      repr(pip_calls))
check("the retried run is not reported as an update failure", not any("update failed" in x for x in said), repr(said))

print("-- a transient 403 is retried once, and nothing else is --", flush=True)

# Measured before this existed: a run failed six trailers with `HTTP Error 403:
# Forbidden` AFTER extraction had already succeeded, and re-running one of them
# minutes later downloaded it in full (Firefly Wedding, 14 MB, 79 s, same
# yt-dlp, same options). So that 403 is transient and giving up on first sight
# silently drops trailers that are perfectly fetchable.
#
# The retry has to stay narrow, because request volume is what trips YouTube's
# IP block - and a block then prevents verifying anything. A fake yt_dlp lets
# this assert the policy offline, without a single real request.
import types  # noqa: E402


class _FakeYDL:
    """Stands in for yt_dlp.YoutubeDL. Raises `script` errors in order."""

    def __init__(self, opts):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def extract_info(self, url, download=True):
        _FakeYDL.calls += 1
        err = _FakeYDL.script.pop(0) if _FakeYDL.script else None
        if err:
            raise RuntimeError(err)
        return {"duration": 42}


def _run_download(script, tmp_has_file=True):
    """Drive download_audio against the fake, returning (attempts, outcome)."""
    _FakeYDL.calls = 0
    _FakeYDL.script = list(script)
    fake = types.ModuleType("yt_dlp")
    fake.YoutubeDL = _FakeYDL
    saved = sys.modules.get("yt_dlp")
    sys.modules["yt_dlp"] = fake
    saved_sleep = ts.time.sleep
    ts.time.sleep = lambda *_a, **_k: None          # no real backoff in a test
    saved_listdir = os.listdir
    ts.os.listdir = lambda d: (["full.wav"] if tmp_has_file else [])
    try:
        try:
            ts.download_audio("VIDEOID", "/tmp")
            return _FakeYDL.calls, "ok"
        except Exception as e:                       # noqa: BLE001
            return _FakeYDL.calls, ts.classify_error(str(e))
    finally:
        ts.os.listdir = saved_listdir
        ts.time.sleep = saved_sleep
        if saved is None:
            sys.modules.pop("yt_dlp", None)
        else:
            sys.modules["yt_dlp"] = saved


FORBIDDEN = "unable to download video data: HTTP Error 403: Forbidden"
attempts, outcome = _run_download([FORBIDDEN, None])
check("a 403 is retried once and the second attempt is kept",
      attempts == 2 and outcome == "ok", f"attempts={attempts} outcome={outcome}")

attempts, outcome = _run_download([FORBIDDEN, FORBIDDEN])
check("a 403 that fails twice gives up - one retry, never a loop",
      attempts == 2 and outcome == "forbidden", f"attempts={attempts} outcome={outcome}")

# The two that must NEVER be retried, and they are the safety argument: a dead
# video can never succeed, and retrying a bot wall deepens the block that
# aborting exists to escape.
attempts, outcome = _run_download(["ERROR: [youtube] X: Video unavailable"] * 2)
check("a dead video is not retried", attempts == 1 and outcome == "unavailable",
      f"attempts={attempts} outcome={outcome}")

attempts, outcome = _run_download(["Sign in to confirm you are not a bot"] * 2)
check("a bot wall is not retried - retrying deepens the block",
      attempts == 1 and outcome == "botwall", f"attempts={attempts} outcome={outcome}")

attempts, outcome = _run_download([None])
check("a clean download still costs exactly one request", attempts == 1 and outcome == "ok",
      f"attempts={attempts} outcome={outcome}")

print("-- one definition: the GPU run shares the retry policy, never copies it --", flush=True)

# `tools/local_translate.py` has its OWN download_audio (it also returns a video
# URL for frame grabs), so the server-side retry did not reach it - and that is
# the run which actually lost six trailers to transient 403s. Sharing the POLICY
# rather than the download is what keeps the two from drifting; this asserts
# they are the SAME function object, not two that happen to agree today. The
# MODEL_RANK lesson, applied before it could bite.
sys.path.insert(0, os.path.join(HERE, "..", "..", "tools"))
import local_translate as lt  # noqa: E402

check("local_translate imports should_retry_download rather than reimplementing it",
      lt.should_retry_download is ts.should_retry_download,
      f"{lt.should_retry_download!r} vs {ts.should_retry_download!r}")
check("and the delay with it", lt.RETRY_403_DELAY_S == ts.RETRY_403_DELAY_S,
      f"{lt.RETRY_403_DELAY_S} vs {ts.RETRY_403_DELAY_S}")

print("-- one definition: tools/ imports the container's phrase list --", flush=True)
sys.path.insert(0, os.path.join(HERE, ".."))
import yt_guard as g  # noqa: E402
check("yt_guard.BLOCK_SIGNS is translate_stream.BOT_WALL_SIGNS", tuple(g.BLOCK_SIGNS) == tuple(ts.BOT_WALL_SIGNS),
      f"{g.BLOCK_SIGNS!r} vs {ts.BOT_WALL_SIGNS!r}")

print(f"Done: {'FAIL' if fails else 'PASS'} - {fails} failing check(s)", flush=True)
sys.exit(1 if fails else 0)
