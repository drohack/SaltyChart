---
paths:
  - "tools/**/*"
  - "tools/*"
---

# Running things in `tools/`

Both rules below cost real money on a shared box the first time they were
broken. They live here rather than in `CLAUDE.md` because they only bind while
you are working in `tools/`, and here they load exactly then. The root guide
keeps a one-line reminder that they exist, because a path-scoped rule is not
re-injected after a `/compact`.

## `tools/bench_player.py` must not be run casually

Every playback remuxes the whole episode to disk regardless of the playhead
(jellyfin#16608), and **nine cold runs once filled the transcode cache until
Jellyfin served 0-byte segments** - indistinguishable from an app bug, and it
cost a debugging session to work out that the benchmark was the cause. The
mechanism is documented in `backend/CLAUDE.md` under *Jellyfin integration
routes*; this is the restraint.

If you do run it: stop each run's encodings before timing the next, or you are
measuring your own load rather than the server's.

## YouTube volume is CAPPED, and the cap is enforced - `tools/yt_guard.py`

**Read this before running anything that touches YouTube, including one-off
verification.** The rule below bounds *concurrency*. That was not enough: an
agent obeyed it exactly - serial, no retries through a challenge - and still
tripped YouTube's IP block, by making roughly **30 requests in 35 minutes**
(counted from that session's log, 2026-09-20) of
ad-hoc "does the fix work" checking. The block then removed the ability to
verify the fix at all, which is the part that actually costs a session.

So volume is now gated rather than documented:

- A **PreToolUse hook** refuses any shell command that contacts a YouTube host
  or invokes a YouTube client and is too soon or over budget. **The budgets,
  the host list, the block phrases and the pre-filter tokens are all constants
  at the top of `tools/yt_guard.py`** - that file is the only place they are
  defined; this document deliberately does not restate the numbers.
  `py -3.13 tools/yt_guard.py` prints the live budget; `--selftest` reads the
  **live** `.claude/settings.json` and checks its pre-filter reaches every host
  **and every invocation sample** (its first version compared against this
  file's own token list - a tautology that stayed green while four patterns
  were unreachable).
- The matcher also counts **our own** YouTube-touching entry points - running
  `local_translate.py`, `batch_translate.py`, `translate_stream.py` or
  `bench_download.py`, calling `download_audio(`, or hitting
  `/api/translate/stream`. They wrap yt-dlp and name no YouTube token, which
  left the first guard blind to the exact `curl .../api/translate/stream` loop
  it was built to stop. **The `settings.json` pre-filter grep must be widened to
  match** or python is never spawned for them: append
  `|translat|bench_download|download_audio` to its alternation. Those tokens
  mirror `PREFILTER_TOKENS`; `--selftest` and `test_yt_guard.py` both **fail on
  a checkout whose grep has not been widened** - that failure is the point, not
  a flake.
- A detected block starts a **repo-wide cooldown that doubles per strike**. The
  batch scripts report into it, so a bot wall hit by a legitimate run also
  stops hand-retries.
- Scripts take a slot with `from yt_guard import request_slot`.
- `py -3.13 tools/yt_guard.py` reports the current budget;
  `--clear` resets it deliberately.

**Stage verification instead of looping.** One download proves a download works;
you do not need thirty. If you are about to check "the same thing but slightly
different" for the fifth time, you are spending the budget that a real
verification will need later. **Do not raise these numbers to get unblocked** -
they were set from the run that caused the outage.

## `tools/audit_premiere_dates.py` asks skyhook ~500 times

It scores TVDB's premiere date against AniList's, over the seasons the Fribb map
independently pairs, and it is how the resolver's season-premiere rung was
justified - first seasons agreed 345/345 when it was written. One request per
unique TVDB id, paced at the client's own 300 ms and **cached to disk**, so a
re-run asks only for ids it has never seen. skyhook is Sonarr's free proxy: run
it when the ladder or the corpus changes, not in a loop, and quote the run
rather than the numbers in the docs.

## Never parallelise YouTube downloads, and never retry through a bot challenge

Both batch translators download **serially behind a delay**
(`--download-delay`; the default is `DOWNLOAD_DELAY_DEFAULT`, defined once per
deployable with the reasoning at the constant in `translate_stream.py`) and
**abort the whole run** on a bot
challenge (`_is_bot_block`). Parallel downloads tripped YouTube's bot wall,
which is why `tools/local_translate.py` accepts `--download-workers` and
ignores it - the flag is kept only so an old invocation does not break.

`--cookies <cookies.txt>` in Netscape format is how YouTube auth is supplied;
`--cookies-from-browser` fails on modern Edge and Chrome because of App-Bound
Encryption (yt-dlp #10927).

The pipeline itself - Demucs, large-v3, the qwen3.5:9b translate stage, and the
phased VRAM handling - is documented in `backend/CLAUDE.md` under *Translation
routes*, and in the script's own docstring.
