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

## Never parallelise YouTube downloads, and never retry through a bot challenge

Both batch translators download **serially behind a delay**
(`--download-delay`, default 5 s) and **abort the whole run** on a bot
challenge (`_is_bot_block`). Parallel downloads tripped YouTube's bot wall,
which is why `tools/local_translate.py` accepts `--download-workers` and
ignores it - the flag is kept only so an old invocation does not break.

`--cookies <cookies.txt>` in Netscape format is how YouTube auth is supplied;
`--cookies-from-browser` fails on modern Edge and Chrome because of App-Bound
Encryption (yt-dlp #10927).

The pipeline itself - Demucs, large-v3, the qwen3.5:9b translate stage, and the
phased VRAM handling - is documented in `backend/CLAUDE.md` under *Translation
routes*, and in the script's own docstring.
