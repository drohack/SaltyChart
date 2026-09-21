# Regression tests

Pre-deploy smoke + regression tests for SaltyChart. Run these before building
Docker images to catch site-breaking regressions.

The suite is **16 parallel checks** (no browser, no shared state) followed by
**7 sequential checks** - the three that mutate a backend `AppConfig` row and
restore it, then the four browser checks; 8 with the burned-in GPU test - so
**23/24** checks in total. Wall-clock varies with cache warmth and what Jellyfin
is doing: **~6.5 min** with `--skip-burned-in`, re-measured 2026-09-21 at 23
checks (a 35 s parallel phase, then 353 s of sequential checks - the player and
the UI flows are 159 s and 158 s of that, and nothing else exceeds 36 s).

## One-shot pre-deploy

```bash
# 0. Start clean - kill stale ts-node-dev / vite processes from prior sessions
py -3.13 tools/tests/kill_stale.py

# 1. Backend + frontend dev servers (Vite is strictPort=true, always 5173)
cd backend && npm run dev          # terminal 1, port 3000
cd frontend && npm run dev         # terminal 2, port 5173

# 2. Run the full pre-deploy suite (default flags assume :3000 + :5173)
py -3.13 -u tools/tests/run_all.py

# Skip the GPU-heavy burned-in detection test
py -3.13 -u tools/tests/run_all.py --skip-burned-in
```

If frontend fails to start with `Port 5173 is in use`, run `kill_stale.py`
again - `strictPort: true` in `vite.config.ts` prevents falling through to
5174 so we never have to guess which port the test suite should target.

`run_all.py` also runs `cleanup_users.py` at startup: every run signs up fresh
throwaway users (`smoke_test_*`, `ui_test_*`, `fe_smoke_*`, ...) and nothing ever
deleted them - ~660 had accumulated, all auto-checked in Randomize's
"Nicknames from" panel like real people. It deletes by known prefixes plus the
10-digit epoch suffix every generated name carries, and never touches the
reused fixtures (`jf_test_fixture`, `player_*_fixture`, `plex_test_fixture`).

Final line is either `Pre-deploy: N/N passed - ready to build` or
`Pre-deploy: FAILED at step X - DO NOT deploy`. Two failures carry no step
number: `Pre-deploy: FAILED in parallel phase` (one of the concurrent checks
went red - its output tail is printed above) and `Pre-deploy: FAILED before
step 1` - `warm_cache.py` couldn't fetch a season key, and the run refuses to
start rather than pass vacuously against missing data.

## Individual tests

| File | What it covers | Needs | Duration |
|---|---|---|---|
| `test_season_lookahead.py` | 50-day next-season cutover logic (regression for "X days till" bug, and the 76->50 boundary move) - pure Python, 8 cases | nothing | <1s |
| `test_api_smoke.py` | 14 happy paths: health, auth, list CRUD (PUT/GET/watched/hidden/rank reorder), anime/AniList, anime cache latency, all 4 public-list endpoints, options round-trip, /api/users (Compare username picker), and that un-watching clears `watchedRank` so a re-watch appends instead of reviving it | backend running | ~15s |
| `test_api_negative.py` | 11 error paths/auth gates: signup missing-fields/dup, password reset round-trip, missing/malformed JWT, a correctly signed JWT carrying no `id` (must 401 fast, not hang), bad season validation, /public-list nonexistent user, /translate/check shape, /check-batch shape, admin endpoints reject 401/403 | backend running | ~5s |
| `test_jellyfin.py` | 13 steps: `/api/jellyfin` auth + admin gates, `?token=` paths, availability shape incl. `matchedBy` and an id-tier liveness check, stream proxy, a manifest credential-leak assertion, a subtitle fetch, `Cache-Control` on subtitles/attachments, a well-formed WebVTT header, the config keep-on-empty round trip, the admin lookup (a name search offers id-bearing picks; a pasted `tvdb:<held id>` comes back named and cross-walked to TMDB), and the identity-override round trip (wrong id / rejection / unheld film all flip the verdict, Confirm keeps provenance, and the invalidation reaches the persisted blob); live steps auto-skip when Jellyfin is unconfigured (set on /admin) | backend running | ~5s unconfigured, ~90s live |
| `backend npm run test:unit` | Title/id matching helpers via `node --test` - the Unicode normalisation guards and the known false positive | nothing | ~1s |
| `backend npx tsc --noEmit` | Backend type-checks clean (same gate CI runs before building images) | nothing | <1 min |
| `test_yt_guard.py` | The enforced YouTube budget (`tools/yt_guard.py`): every matcher decision - the positives, the false positives that each blocked a person once (GitHub docs about yt-dlp, a prose mention, `pip install`, compiling our own script), and that the **live** `settings.json` pre-filter can reach every positive (a fixture of the grep as it shipped pins that it could NOT reach `local_translate.py`; the live check FAILS until the grep is widened) - plus the four budget gates, cooldown/strike/adaptive tightening, and that `--clear` keeps strike history. State goes to a temp file, never the real budget | nothing | <1s |
| `test_sonarr.py` | 9 steps on the Sonarr auto-add - the one feature that WRITES to a real media server, so the assertions are about the contract and the guards, never which shows are in the plan. Every route 401s unauthenticated; the pause switch is proven by reading the `SonarrPush` rows before and after a real `POST /push`, not the response body; tvdbIds are positive integers with no duplicates; `/report` degrades rather than failing when Sonarr is unreachable; and step 9 fails if any proposed row grades `weak`. A successful add is deliberately NOT covered - it changes a real library | backend running | ~30-120s |
| `test_account_security.py` | The account and admin guards, on a backend it boots itself against an **empty** database. Separate from `test_api_negative.py` for a load-bearing reason: these assertions attempt destructive admin actions, which are refused while the guards hold and SUCCEED under a mutation run - against the dev server that once reset the real admin's password and cleared its email, and the audit reverts source, never data. An empty DB is also the only place the `[SETUP]` first-run claim flow exists | boots its own backend | ~30-60s |
| `test_candidate_separation.py` | The queue rule on `/admin/matching`: a multi-candidate row may leave the review queue only when the entry's own premiere date SEPARATED the candidates. The logic is unit-tested off the network in `seriesIdentity.test.ts`; this covers the half a unit test cannot - that the verdict reaches the page, over real stored rows. Three checks, and the second is the one that would catch a silent break: sending NO `dates` must settle NOTHING, so a field hardcoded `true` or computed from something other than the date cannot sail through the third. That third re-derives every settled row INDEPENDENTLY (exactly one candidate inside 31 days, no undated sibling, and that candidate the one stored) - an invariant, not a count, because counts go stale every season. Also pins `Cyborg 009: Nemesis`, which exists twice in TVDB with one copy undated and must never be settled | backend running | ~5s |
| `test_download_hold.py` | While `AppConfig.subtitleDownloadHealth` records a bot wall: `/api/translate/stream` refuses a cache miss with the friendly message and `holdUntil`, `/check-batch` queues nothing (`X-Check-Queue: held`) and writes no verdict, `/check` answers from cache only (`hasEnglish: null`) and writes no row, and nothing is recorded for a refusal (a refusal is not an attempt). Sequential group: it mutates shared backend state. Injects the row and restores it in a `finally`; makes no YouTube request while the guard holds | backend running | ~2s |
| `test_status_page.py` | `/api/status` - the upstream service status page. Forces a real probe of every configured service, so it is also the only check that would notice a probe query going stale (the AniList one shipped selecting only `pageInfo` and got a 400). Every route 401s unauthenticated and 403s for a signed-up non-admin; `/report` names every registered service and gives each a server-decided state; **a service that is not set up reads `notConfigured`, never `down`**, and after a forced probe nothing probeable is still `unknown`; the alert settings round-trip, with a malformed address dropped rather than stored; rubbish input is coerced, never a 500. Forces one real probe per configured service, so it lives in the sequential group and backs up both AppConfig keys | backend running | ~10-60s |
| `test_run_verdict.py` | `translate_stream.run_verdict` - a batch run that mostly failed must exit non-zero and name the remedy. Pins the case that shipped silently (46 of 49 -> exit 2, "stale yt-dlp"), what must not fail a run (two private trailers; 3 of 49; nothing to do), both threshold edges, the bot-wall abort code, `classify_error`, the **three-valued CC check** (a blocked or timed-out `check_subtitles` is `null`, never `false`; driven through a fake `youtube_transcript_api` module, no network), **`MODEL_RANK` parity** between `translate_stream.py` and `lib/subtitleReport.ts` (via ts-node) plus an AST check that neither script redefines it, the pip `no such option` retry in `ensure_ytdlp_current`, and that `yt_guard.BLOCK_SIGNS` is the imported `BOT_WALL_SIGNS`, not a copy | nothing, node + ts-node | ~2s |
| `test_local_run_report.py` | `POST /api/translate/local-run` - the Sunday run's self-report: 401 unauthenticated, 403 for a signed-up non-admin, 400 on a malformed body, 200 for an admin, and `/report.schedule.lastLocalRun` carries the exit code, line, counts and breakdown. Backs up and restores the stored report | backend running | ~5s |
| `frontend npm run build` | Frontend production build exits clean with zero a11y warnings | nothing | <1 min |
| `test_svelte_check.py` | Catches references to identifiers that no longer exist in `.svelte` script blocks - `vite build` compiles them clean and they throw at runtime. A ratchet against the pre-existing error baseline: fails only when the count rises | nothing | ~1 min |
| `test_rate_limits.py` | The rate limiters actually limit - every limiter is skipped in dev, so nothing else in the suite ever consults one. Boots a second production-mode backend on a spare port with a throwaway DB and hits it until it 429s | nothing (boots its own backend) | ~30s |
| `test_audit_anchors.py` | Every `mutation_audit.py` row still points at code that exists; `EXPLORATORY.md`, the three `CLAUDE.md` guides and `.claude/rules/*.md` cite no dead file paths or `file.ext:NN` line references; the guide split holds (root inside its size budget, every moved section still pointed at from the root, no stub grown back into a second copy); and every path-scoped rule is committable and carries `paths:` frontmatter. The cheap half of doc/anchor rot | nothing | ~2s |
| `test_match_replay.py` | Replays the shipping `matchSeries` over a frozen 8-season corpus and diffs every verdict against a committed baseline; twelve real false positives asserted by name. SKIPs where the (gitignored) fixtures haven't been built | fixtures built locally (else SKIP) | ~30s |
| `test_frontend_smoke.py` | Home/Login/SignUp/Randomize/Compare pages render with no console errors, auth-gated routes accessible after signup | backend + frontend | ~20s |
| `test_ui_interactions.py` | 29 flows: button-click smoke (login, search, hide 18+, season, watched-trailer, theme, wheel, logout, modal Escape, Compare with 2 users), the exploratory-pass guards (no-results message, zero availability calls + disabled Hide button on an unaired season, check-batch chunking, visible translation errors, phone sidebar collapsed, guest options + Compare's missing-user warning, an oversized wheel image warning instead of wedging the page, a theme choice surviving signup), admin page, unknown-never-hides, share-as-image, progressive loading, three silent-failure paths (unreachable library, hung backend, failed hide write), and the /admin/matching review of a resolver title-text accept | backend + frontend | ~3 min |
| `test_subtitle_paths.py` | Subtitle Paths B/C/D - YouTube English CC (plus: the fullscreen button is there and works while YouTube CC is active, and Escape in fullscreen keeps the modal - the path that lost fullscreen once), Whisper overlay (`.sc-subtitle`), CC toggle persistence | backend + frontend + populated SubtitleCache | ~15s |
| `test_player.py` | 10 steps driving the **real Jellyfin player**, which nothing else does: pop-up pre-warm fires and no stream starts early, playback actually advances, exactly one subtitle menu defaulting to plain English, `[`/`]` stepping 0.10 with the control bar hidden, burned-in subtitles verified in the pixels (12 frames sampled with subtitles on and off), the quality menu reaching 480p in one restart, Escape stopping the transcode. Skips when Jellyfin is unconfigured or nothing in the season is in the library | backend + frontend + Jellyfin | ~2 min |
| `test_burned_in_detection.py` | Whisper large-v3 + OCR + sentence-transformers burned-in detection: Eren=yes, Sparks=no | CUDA GPU, backend running | ~60s |

Run any individually with:
```
py -3.13 -u tools/tests/test_api_smoke.py
py -3.13 -u tools/tests/test_frontend_smoke.py --frontend http://localhost:5173
py -3.13 -u tools/tests/test_subtitle_paths.py --frontend http://localhost:5173
py -3.13 -u tools/tests/test_burned_in_detection.py
```

## Test video fixtures

`test_subtitle_paths.py` and `test_burned_in_detection.py` use fixed video IDs
that must exist in `SubtitleCache` with the expected state:

| Video ID | Title | State needed |
|---|---|---|
| `EsQudPqDOQQ` | Eren the Southpaw | Burned-in subs (used by detection test) |
| `7ObipYqbOd8` | Sparks of Tomorrow | YouTube English CC, `hasEnglishSubs=1` |
| `ByOF3FLlAws` | (Tokyo Shinkatsu trailer) | `hasEnglishSubs=0`, cached Whisper segments |

If the local dev DB doesn't have these, populate via the live daemon (open the
trailer in the app once) or copy rows from the prod DB.

**Adding a test here?** It needs a `mutation_audit.py` row, and that row has a
price - see the `testing` skill (`.claude/skills/testing/SKILL.md`) for the
cost table and the rules that keep a row honest (name a UI flow, keep `expect`
unambiguous, mutate the guard rather than the feature).

## When to run

- **Before every deploy** - `run_all.py` is the gate.
- After any change to `backend/src/routes/*`, `frontend/src/components/AnimeGridTranslate.svelte`,
  `frontend/src/pages/Home.svelte`, `frontend/src/stores/season.ts`, or
  `tools/local_translate.py`.
- After any Whisper / sentence-transformers / Prisma version bump.
- After any change to the SubtitleCache or WatchList schema.

## What this suite cannot catch - `EXPLORATORY.md`

Every check here asks *"does this mechanism work?"* in isolation, from a clean
load, asserted by whoever wrote the feature. That shape can't see state going
stale across a sequence, a control nobody thought to assert on, a console error
where nothing is looking, or a layout that collapses at 390px.

`EXPLORATORY.md` is the charter for an agent driving a real browser as a user.
It is deliberately **not** automated - its output is a findings list, and
anything it finds twice should graduate into this suite with a
`mutation_audit.py` row. Read its *Traps* section before starting; several
plausible-looking "bugs" there are measurement artifacts.

The mutation audit itself is 157 rows (2026-09-21; the last full run measured
86 rows in 21 min on 2026-08-06), and a full run **prints its own wall clock** on the last line
(`N rows, M min, measured <date>`) - quote that, never an estimate. It warms
the season cache once at the start, so a full run has to fit inside the 6 h
`SeasonCache` TTL or its later rows re-fetch against AniList mid-audit. A run
that logs a live `AniList 429` is a bug, not weather: the last one to do so was
spending 100 requests per season refresh on a season with three pages.

## Output format

All tests emit self-contained progress lines per the global CLAUDE.md
convention. Each line shows overall position so the Claude Code status bar
makes sense in isolation:

```
[parallel 1-11/15] running 11 independent checks concurrently...
[1/15 pre-deploy] PASS - backend tsc (1.8s)
[2/13 API-smoke] POST /api/auth/signup as smoke_test_1781202612885
[2/13 API-smoke] PASS - got JWT token
[1/2 EsQudPqDOQQ] step 3/4: frame 2/7 (13.1s): MATCH (fz=86% sem=86%)
```
