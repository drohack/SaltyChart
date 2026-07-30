# CLAUDE.md — SaltyChart contributor guide

This is the canonical project guide for Claude Code sessions (and any other
agent) working in this repo. It covers working conventions, architecture,
API surface, and schema. Start here.

---

## Rules (read before making changes)

### Keep docs and comments in sync with code

Docs drift is a real bug — it misleads the next contributor. **Before
finishing a task, update the docs and comments your change makes stale.**

When your diff touches any of these, update the listed locations too:

- **New API endpoint** → update the endpoint list in the *Backend Service*
  section below (include auth requirements + rate-limit tier).
- **Removed / renamed endpoint** → remove it from that list; grep the
  frontend for callers and update them too.
- **New DB column / table / index** → update `backend/prisma/schema.prisma`
  **and** the raw SQL in `ensureDatabaseSchema()` in `backend/src/index.ts`,
  **and** the schema bullets in the *Backend Service* section below.
  Production does **not** run `prisma migrate`; the raw-SQL path is
  authoritative at runtime.
- **New user-visible feature or page redesign** → update `README.md`
  *Feature highlights* **and** the relevant page bullets in the *Frontend
  Service* section below.
- **Removed feature, dep, file, or component** → grep repo-wide for its
  name; kill stale references in source comments, JSDoc, `README.md`, and
  this file.
- **Changed default behaviour** (default sort, theme, flag, etc.) → search
  for docs or inline comments that named the old default.

### Verify nearby comments when editing code

- Re-read function-level `/** JSDoc */` and header comments next to your
  change. If the body now contradicts them, fix the comment.
- When deleting code, grep for surviving comments referencing the deleted
  identifier, shape, or behaviour (e.g. "hides the 4-column grid" after
  moving to cards).
- Markdown bullets citing specific line numbers, class names, or file paths
  are the most rot-prone — verify each still matches reality.

### Style rules

- Comments explain *why*, not *what*. Delete redundant "increments X"
  comments when editing nearby code.
- Don't create new `*.md` files for ad-hoc notes unless the user explicitly
  asks. Canonical docs are `README.md` (user/deployer-facing) and this
  `CLAUDE.md` (contributor/agent-facing).
- Don't add date-stamped section headers ("Recent features (Month Year)")
  — they stale fast. Use evergreen wording.
- UTF-8 / box-drawing chars are used throughout existing docs — match the
  surrounding style.

### Pre-completion sanity checks

1. `cd frontend && npm run build` → zero a11y warnings, clean exit.
2. `cd backend && npx tsc --noEmit` → clean exit.
3. **Before building Docker images for deploy**: run the full pre-deploy
   suite (`tools/tests/run_all.py`) — see *Testing* section below.
4. Skim `README.md` and this file for stale mentions of the old behaviour
   and update them.
5. If you touched `shareCompare()` in `Compare.svelte` or `shareMyList()`
   in `WatchListSidebar.svelte`, manually verify the share button still
   exports a reasonable image — both functions are DOM-clone-heavy and
   brittle to layout changes.
6. **Clean up Playwright screenshots** at the repo root:
   `rm compare-*.png randomize-*.png home-*.png home-desktop-after-gap-fix.png 2>/dev/null`

### Testing

A regression / smoke-test suite lives at `tools/tests/`. Run it before
building Docker images, after any change to a route, schema, store, or
translation pipeline. Documentation at `tools/tests/README.md`.

```bash
# 0. Kill stale ts-node-dev / vite processes (avoids port conflicts)
py -3.13 tools/tests/kill_stale.py

# 1. Backend dev on :3000, frontend dev on :5173 (Vite strictPort=true)
cd backend && npm run dev   # terminal 1
cd frontend && npm run dev  # terminal 2

# 2. Run the suite
py -3.13 -u tools/tests/run_all.py

# Skip the GPU-heavy burned-in detection test
py -3.13 -u tools/tests/run_all.py --skip-burned-in
```

The backend's `/api/auth/*` rate limiter (20 req/min in prod) is **disabled
when `NODE_ENV !== 'production'`** so rapid signups during tests don't trip it.

**⚠ AniList rate limit while testing.** AniList allows ~**30 req/min per IP**
(degraded state), and the whole home network — dev PC, production server,
every browser's direct `stores/season.ts` call — shares one public IP. A cold
season fetch is up to ~8 GraphQL requests, so repeatedly wiping `SeasonCache`
to test cold loads WILL trip the limit; once tripped, cold fetches stall in
60s+ 429 backoff (looks like "the page never loads") and the penalty can
linger for a long time. Rules of thumb:
- Don't wipe `SeasonCache` more than once or twice per hour; pre-warm the
  displayed season + its leftovers (`curl /api/anime?...`) before `run_all.py`.
- When a season request suddenly takes minutes, check the backend console for
  `AniList 429` lines before suspecting the code.
- Mitigations already in place: cold fetches are coalesced per season,
  expired cache rows are served stale while refreshing in the background,
  and 429 retries respect AniList's headers (15/30/45s fallback).

Suite includes:
| File | Covers |
|---|---|
| `test_season_lookahead.py` | 76-day next-season cutover logic (regression for the "X days till" bug) |
| `test_api_smoke.py` | 13 happy-path API steps: health, auth, list CRUD (PUT/GET/watched/hidden/rank), anime + cache hit, public-list endpoints, options round-trip, /api/users |
| `test_api_negative.py` | 10 negative paths: signup missing/dup, password reset round-trip, missing/malformed JWT, validation errors, /translate/check shape, admin endpoint auth gates |
| `test_frontend_smoke.py` | 5 frontend routes render (Playwright) including auth-gated pages |
| `test_ui_interactions.py` | 10 button-click flows: login, search filter, hide 18+, season change, add-to-list, theme, wheel spin, logout, modal Escape, Compare with 2 users |
| `test_subtitle_paths.py` | Subtitle Paths B/C/D — YouTube CC, Whisper overlay, CC toggle persistence |
| `test_burned_in_detection.py` | Whisper large-v3 + OCR burned-in detection (Eren=yes, Sparks=no) — needs GPU |
| `test_plex.py` | `/api/plex` auth/admin gates + validation; availability & stream-proxy steps auto-skip when Plex is unconfigured |

Final line on success: `Pre-deploy: 10/10 passed — ready to build` (9/9 with
`--skip-burned-in`). On failure:
`Pre-deploy: FAILED at step X — DO NOT deploy`.

---

## Project Overview

SaltyChart is a two-service web application for discovering seasonal anime,
viewing summaries & trailers, and enabling authenticated users to build
and share custom rankings.

## Monorepo Layout

```text
SaltyChart/
├── backend/          # Express + TypeScript REST API
│   └── prisma/       # Prisma schema + SQLite datasource (nested prisma/data.db)
├── frontend/         # Svelte 4 + Vite + Tailwind/DaisyUI single-page app
├── tools/            # Python helpers: local_translate.py, benchmark_whisper_settings.py
│   │                 #   + bench_pipeline.py (swappable ASR/translate/align stages)
│   ├── tests/        # Pre-deploy smoke/regression suite (run_all.py)
│   └── unraid/       # Reference copy of the update_saltychart User Script
├── .github/workflows/ # CI: deploy.yml (push→GHCR), build-base.yml (manual)
├── docs/superpowers/specs/  # Design specs (e.g. CI/CD deployment)
├── docker-compose.yml
├── README.md         # High-level overview & quick-start instructions
└── CLAUDE.md         # this file — contributor/agent guide
```

## Backend Service

Path: `backend/`

- Tech: Node.js, Express, TypeScript, Prisma Client, SQLite
- Entry: `src/index.ts`
- Dev: `npm install && npm run dev` (hot reload via ts-node-dev)
- Build: `npm run build`
- Start: `npm run start`
- Env variables:
  - `JWT_SECRET` (required for auth token signing). In production the server
    **fails fast at startup** (`[FATAL]`, `process.exit(1)`) if it's unset or
    left as the insecure `'dev-secret'` default. Supplied via an untracked
    `.env` (`JWT_SECRET: ${JWT_SECRET}` in the compose files), never committed.
  - `DATABASE_URL` (defaults to `file:./prisma/data.db` in production)

### API routes mounted under `/api/*`

- `/api/health`          (health check)
- `/api/anime`           (AniList GraphQL proxy + cache; page 1 reveals
  `lastPage`, then pages 2..N are fetched with a concurrency-3 pool — a
  mid-season cold load is 6–12 pages and sequential round trips dominated
  its latency. Concurrent cold requests for the same season are coalesced,
  and an **expired `SeasonCache` row is served stale while a background
  refresh runs** — only a never-fetched season blocks on AniList)
- `/api/auth`            (login, signup, password reset, JWT issuance)
- `/api/list`            (user watchlist CRUD)
- `/api/public-list`     (public watchlist read-only)
- `/api/users`           (user management)
- `/api/options`         (per-user UI preferences)
- `/api/plex`            (Plex Media Server integration — see below)

Routes inside existing routers:

- `PATCH /api/list/watched`   — toggle watched / unwatched and record timestamp
- `PATCH /api/list/rank`      — update per-season *watchedRank* ordering
- `PATCH /api/list/hidden`    — toggle *hidden* flag (excludes an entry from the Randomize wheel)
- `GET   /api/list/users-with-nicknames` — users with at least one custom nickname (**rate-limited**, 60/min)
- `GET   /api/list/users-with-ratings?season=&year=` — users with any entry for a season; powers Randomize's nickname auto-check (**rate-limited**)
- `GET   /api/list/user-ratings?username=&season=&year=` — mediaIds a user has in a season (**rate-limited**)
- `GET   /api/list/nicknames?mediaId=` — nicknames & ranks for a given series (**rate-limited**)
- `PUT   /api/list` — replace entire list for a season/year in one shot
- `POST  /api/auth/reset-password` — reset a user's password by username; no auth required (intentionally low-security — no email, small friend-group app)

### Plex integration routes (`/api/plex`)

The admin points SaltyChart at a Plex server (URL + `X-Plex-Token`) on the
`/admin` page; both are stored in the `AppConfig` DB table. **The token never
reaches a browser** — availability responses carry only ratingKeys and
display strings, the stream proxy injects the token server-side, and anything
logged from the subtitle extractor is run through `redact()` first (ffmpeg
echoes the source URL, which carries the token). Like `/api/translate`,
this router mounts **before `compression()`** (the stream proxy pipes HLS
segments, which compression would buffer), so it carries its own limiter
instances and JSON parser.

- `GET  /api/plex/status`       — `{ configured, isAdmin }` probe (JWT
  required). `isAdmin` rides along so the header's Admin link doesn't need to
  probe an admin-only endpoint (which would 403-spam the console for
  everyone else); `stores/plex.ts` fetches this once per login.
- `POST /api/plex/availability` — `{ mediaId, titles[] }` → is the series in
  the Plex library + the entry's season's first episode (season parsed from
  "Nth Season"/「第N期」 markers; missing season = unavailable; no marker =
  first episode overall, skipping season-0 specials). Returns
  `{ available, showRatingKey, episodeRatingKey, episodeTitle, seasonNumber,
  episodeNumber, plexTitle }`. Fuzzy title match (Unicode-aware
  normalization, exact > prefix > contains with length-ratio guards) against
  each show's `title` **and** `originalTitle` in all `type=show` libraries
  (list cached 1h). Per-mediaId cache: 1h positives, 10min negatives.
  `fresh: true` in the body (sent by the popup when the cached verdict is
  negative) bypasses the negative cache and refreshes the library list on a
  match-miss, so a just-downloaded show appears immediately.
  Always 200 — Plex down/unconfigured is `{ available: false, unknown: true }`
  (never cached). **`unknown` is load-bearing**: it means "couldn't ask", not
  "not in the library", and every consumer must refuse to hide a show on it,
  or one slow moment empties the wheel.
- `GET  /api/plex/stream/*`     — GET-only streaming proxy to the Plex server
  (JWT via `Authorization` header or `?token=` for Safari-native HLS). Used
  for the universal-transcode HLS playlist/segments (`directStream=1`, remux
  not re-encode when codecs allow) and session ping/stop. Forwards `Range`,
  destroys the upstream transfer when the client disconnects.
- `POST /api/plex/warm-subtitles` — `{ episodeRatingKey }`; starts the
  subtitle extraction for that episode in the background and returns
  immediately (JWT required). The Randomize pop-up fires this the moment the
  availability lookup says the episode is on Plex, so the ~3.5s full-file read
  happens while the viewer reads the pop-up instead of after they press Watch.
  No-op when the part is already cached.
- `GET/PUT /api/plex/config` + `POST /api/plex/config/test` — admin only
  (`ADMIN_USER_ID`): read config (URL + `tokenSet`, never the token), save
  (empty token keeps the stored one), and test a connection (returns server
  name + library list, or the error, always as 200 `{ ok, ... }`).

### Rate limiting

A 120 req/min per-IP `generalLimiter` covers all routes. `/api/translate/*`
mounts before `compression()` (SSE can't be buffered), so the limiter is
applied explicitly on that mount — `app.use('/api/translate', generalLimiter,
translateRouter)` — rather than relying on the later global `app.use`.
`/api/auth/*` has a stricter 20 req/min limiter. The 4 unauthenticated
`/api/list/*` endpoints above additionally sit behind a 60 req/min
`publicListLimiter`. `/api/plex` also mounts before `compression()` and so
carries its own limiters: 120 req/min for the JSON endpoints and a separate
**600 req/min** for `/api/plex/stream/*` (HLS playback is a playlist refresh +
a segment every few seconds plus seek bursts — it must not eat the general
budget).

### Error response shape

Every error is `{ error: 'human message', code: 'CODE_NAME' }`. Codes
include `BAD_REQUEST`, `UNAUTHORIZED`, `INVALID_CREDENTIALS`,
`INVALID_TOKEN`, `USER_NOT_FOUND`, `USER_EXISTS`, `ADMIN_REQUIRED`,
`BATCH_RUNNING`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `SERVER_ERROR`.
Frontend code reads `data.error` (unchanged from before the unification)
and may branch on `data.code` for programmatic handling.

### Translation routes (`/api/translate`)

- `GET /api/translate/check-batch?videoIds=id1,id2,...` — bulk DB lookup for English sub status (up to 100 IDs); returns only confirmed positives; queues background Python checks for uncached IDs
- `GET /api/translate/check?videoId=&mediaId=`  — checks English subs + subtitle dismiss state; cached
- `GET /api/translate/stream?videoId=&mediaId=&start=` — SSE subtitle stream; serves from cache on repeat plays. Optional `start=<sec>` begins transcription at the viewer's playhead (live CPU savings); `start>0` runs are partial and not cached
- `PATCH /api/translate/dismiss?videoId=`       — persist subtitle on/off preference; no auth, all users
- `POST /api/translate/upload`                  — upload pre-translated subtitles; admin only, respects model rank
- `DELETE /api/translate/cache?videoId=`        — delete a cached translation; admin only
- `POST /api/translate/batch`                   — trigger batch pre-translation; admin only, JWT required
- `GET /api/translate/batch/status`             — batch job progress/logs; admin only

Both check and stream endpoints query `SubtitleCache` first. On a cache hit,
`/stream` sends a `{cached: true}` SSE event followed by all segments
instantly (~50 ms). On a miss, the daemon translates and saves to cache on
completion. Concurrent requests for the same uncached video are deduplicated
— the second waits for the first to finish.

The `/check` endpoint returns `{hasEnglish, subtitlesDisabled,
hasCachedSegments, modelName}`. If `hasEnglish` or `subtitlesDisabled` is
true the frontend hides the translated subtitle overlay. The dismiss state
is set via the CC toggle button (calls `PATCH /dismiss`) and persists for
all users. `hasCachedSegments` and `modelName` are used by the local
translation script to decide whether to re-translate.

YouTube caption control — three paths in `openModal` (`AnimeGridTranslate.svelte`):

**Page load pre-fetch:** `Home.svelte` fires `GET /api/translate/check-batch`
immediately after the anime list loads (~5ms DB-only). Returns all video IDs
with `hasEnglishSubs=1` and queues background Python checks for uncached IDs.
Results stored in `prefetchedSubs` (`Map<string, boolean>`) + `prefetchComplete`
boolean, both passed as props to each `AnimeGrid`.

**Path A — confirmed English (`prefetchedSubs.get(id) === true`):**
Instant, no network call. `hasEnglishSubs = true` so `onApiChange` skips
`unloadModule`; YouTube CC starts in English immediately. Translation never starts.

**Path B — batch complete, video not in map (`prefetchComplete === true`):**
Iframe opens immediately (no wait). `onApiChange` calls `unloadModule` to
suppress Japanese CC; translation starts. `/check` fires async in the
background — if Python has since completed and returns `hasEnglish: true`,
the frontend calls `loadModule` + `setOption` to switch to English CC and
hides the overlay. The server deduplicates translations so a video is only
ever translated once; if cached segments already exist the stream returns
instantly (~50ms).

**Path C — batch not yet complete (user clicked within ~5ms of page load):**
Races `/check` against a 150ms timeout. If check returns fast (cached positive
in DB), uses the result; otherwise falls through to the same behavior as path B.

`check_subtitles()` in `backend/scripts/translate_stream.py` uses
`ytt.list(videoId).find_transcript(['en'])` which detects manually uploaded,
auto-generated, and auto-translatable English CC — not just manually uploaded
ones (the old `ytt.fetch(languages=["en"])` only found manually uploaded tracks).

The cache (`SubtitleCache.hasEnglishSubs`) trusts positives forever (English
CC doesn't get removed from YouTube videos) and trusts negatives for **7 days**
via `lastEnCheckAt`. After 7 days, a cached `hasEnglishSubs=0` falls through
to re-run Python so newly-added YouTube CC eventually gets picked up. This
balances "don't re-check on every play" (rate-limit risk) with "eventually
notice when CC is added". The cache write never downgrades a stored true to
false (transient network failure protection).

`youtube_transcript_api` must be installed locally (`pip install youtube-transcript-api`)
for the English sub detection to work in dev. It is pre-installed in Docker.

On-demand translation uses a persistent Python daemon
(`backend/scripts/translate_daemon.py`) with the `small` Whisper model
(int8) for fast live results. Batch pre-translation
(`backend/scripts/batch_translate.py`) uses the `medium` model (int8) for
higher quality and automatically upgrades videos previously translated with
`small`. The batch also pre-checks English subtitles and caches
`hasEnglishSubs` to avoid a Python spawn on first play.

**Live path is CPU-only and shares the Unraid box with Plex** (which transcodes
most of the time, ~5 GB RAM free), so the daemon is tuned to be cheap and a good
neighbour rather than to max the cores:

- `os.nice(10)` at startup (Linux) so Whisper yields CPU to Plex.
- Env knobs (apply bench winners without code changes): `WHISPER_LIVE_MODEL`
  (default `small`), `WHISPER_LIVE_THREADS` (CTranslate2 `cpu_threads`; **default
  2** — benchmarked sweet spot, `0`=CT2 default), `WHISPER_LIVE_WORKERS`
  (max concurrent, default 2),
  `WHISPER_LIVE_IDLE` (idle-exit seconds), `WHISPER_LIVE_NICE`.
- **Single ffmpeg pass:** the live `download_audio(..., as_wav=False)` keeps the
  native audio (no whole-file WAV transcode); `extract_chunk` slices 16 kHz-mono
  chunks straight from it with `-threads 1`. (Batch still uses `as_wav=True` for
  its full-audio pass — unchanged.)
- **Playhead start:** `/api/translate/stream?start=<sec>` makes the daemon begin
  at the viewer's current position (`generate_chunks(duration, start)`) instead of
  second 0, so it doesn't translate already-watched audio. The frontend
  (`AnimeGridTranslate.svelte`) sends `start` only when the playhead is >3 s in;
  the common open-from-start case stays `start=0`. **`start>0` runs are partial
  and NOT cached** (the batch produces the complete cached version) — gated by the
  `cache` flag on `pendingSegments` in `translate.ts`.
- The daemon logs a per-request timing line to stderr (→ backend console):
  `[daemon] <vid> model=… thr=… start=…s dur=…s dl=…s ttfs=…s total=…s segs=…`,
  so live latency is observable and comparable across pipeline changes.
- faster-whisper 1.2.1 quirk: a `vad_filter` pass that finds no speech (common on
  a trailer's silent first 5 s) can poison **later** transcriptions on the same
  `base`-model instance; `small` recovers, so the production daemon (small) is
  safe. If `WHISPER_LIVE_MODEL` is changed to `base`/`tiny`, the daemon would need
  a fresh model per request (the bench loads fresh per video for this reason).

`local_translate.py` uses `beam_size=10` (benchmarked on full Summer 2026
trailers; beam_10 captured most of the quality gain over the default beam_5
with diminishing returns beyond beam_10 — see the bake-off harness below).

**Benchmark / pipeline bake-off harness.** Data lives in `tools/benchmark_data/`
(gitignored). All results go to **one consolidated file `tools/benchmark_results.txt`**
with a delimited section per suite (`@@@ BENCHMARK SUITE: <name> @@@`); each run
**replaces only its own suite's section** (others left intact — no proliferation of
ad-hoc result files). `--output` overrides the path. The harness
`tools/benchmark_whisper_settings.py` composes swappable pipeline stages from
`tools/bench_pipeline.py` (audio source → ASR → optional translate → optional
align) so each layer can be A/B'd in isolation. A variant is a *pipeline spec*;
related variants are grouped into **suites** run via `--suite` (`baseline`,
`phase1`…`phase4`, `champion`, `qwen38`/`qwen359` translator A/B, `turbocmp`
large-v3-vs-turbo). ASR outputs are
cached to `benchmark_data/<vid>/cache/` keyed by audio+model+decode-args, so re-runs
and translator-only sweeps don't recompute transcription (`--no-cache` to force).

Corpus: 11 Summer 2026 trailers with **real timestamped English CC** fetched via
`youtube_transcript_api` (`--refetch-cc`) — *not* yt-dlp VTT, which silently
returned empty files and made the harness fall back to fabricated even-spaced
timestamps. One video (`OMCPr9YwHdM`) is excluded (auto-generated CC that doesn't
match its audio). Data-prep flags: `--download` (16 kHz mono for Whisper),
`--download-hq` (best-quality source for Demucs), `--refetch-cc`,
`--refetch-cc-ja` (Japanese CC as an alt translation input). Metrics per variant:
`overlap` (±4 s semantic similarity vs CC), `timing` (mean segment-span IoU),
`content` (timing-independent best-match similarity — judges text quality when
timestamps are unreliable), `halluc` (% segments <0.25 sim), `SCORE = overlap −
halluc`.

**Live CPU benchmark** (`tools/bench_live_cpu.py`, suite section `live_cpu`).
Separate harness for the on-server live path: sweeps model `{tiny,base,small}` ×
`cpu_threads {1,2,3,4}` over the same corpus and reports **TTFS** (extract+
transcribe of the first 5 s chunk — the latency the viewer feels), `total`
wall-clock, `xRT` (total/audio-len), `cpu_s` (process CPU-seconds = the
Plex-contention cost, rises with threads), `rss_mb`, plus `content`/`halluc` as a
quality floor so we don't ship gibberish (`tiny` is ~97% halluc — unusable). It
loads a **fresh model per video** (timing excludes load; also dodges the
`base`+VAD poisoning quirk above). **Benchmark on the dev PC, not the server**
(the server runs prod and can't be tested on) — this PC's CPU is faster per-core
than the i5-10400 and isn't Plex-contended, so treat absolute numbers as
optimistic and prefer **relative** ranking + low thread counts; quality numbers
transfer exactly.

Finding (suite `live_cpu`, 2026-06): **`small` wins on both axes — keep it.**
`tiny`/`base` are *slower* in total wall-clock (they hallucinate into repetition
loops) *and* far worse quality (`tiny` 86–93% halluc = garbage, `base` 63% vs
`small` 47%). There is no faster CPU model to switch to for ja→en. And
transcription is **not** the bottleneck: `small` at 1 thread already runs at
xRT ≈ 0.13 (≈8× faster than playback), so thread count only shifts TTFS by ~1–2 s
while doubling `cpu_s` per extra thread. The latency the viewer feels is the
**audio download**, which the bench excludes — hence the pipeline changes (native
single-pass download, playhead `start`) target the right thing, not the model.
`word_timestamps` is kept on despite a ~10–20% cost: transcription is already far
ahead of playback, and it trims the pre-speech lead-in (better subtitle timing).

**Download** (suite `download`, `tools/bench_download.py`): the audio download is at
its floor — **no config beats the ~1.2 s `worstaudio` baseline**, and overriding the
yt-dlp `player_client` is *risky*: `ios`/`tv`/`web_safari` all failed (6/6 — PO-token
gated in 2026), `concurrent_fragments` and a specific opus itag were slightly slower,
and **`aria2c -x16` was ~20–28× slower** (≈32 s vs 1.2 s). Multi-connection is
pointless on a 0.3–0.6 MB file whose cost is YouTube's extraction handshake, not
bandwidth. So `download_audio` stays on the plain default client and there's no
aria2c in the image — the bench exists to prove there's nothing to chase here.

Key findings (production still uses large-v3 end-to-end `task=translate`; these
are not yet promoted):
- **Decode params** (refreshed on real CC): the `beam_size=10` + `repetition_penalty=1.2`
  family is best; `beam10_rep120_vadmin300` marginally tops it. `no_vad`,
  `suppress_blank`, `auto_lang` are no better than baseline. `beam_size=10`
  remains a reasonable default for `local_translate.py`.
- **Demucs vocal separation helps** (htdemucs, two-stems) — ~+6–8 SCORE, ~5–6 pp
  less hallucination. *Must separate from full-quality source audio*, not the
  16 kHz-mono Whisper input (separating mono upsampled audio actually hurts).
- **Best overall config (suite `champion`): `split_best`** — vocals + large-v3
  `task=transcribe` with `beam_size=10, repetition_penalty=1.2,
  vad_parameters.min_speech_duration_ms=300` → **qwen3.5:9b** translate (Ollama,
  greedy/temp 0). SCORE **1.9** vs end-to-end translate **1.0**, winning timing
  (52.7 vs 43.6 IoU) and hallucination (34.5% vs 35.7%), matching content. The
  tuned decode params *help the transcribe path* (rescued the hallucination-prone
  clips: Tanya −53→+13, Inept Villainess −29→−1) but *hurt* end-to-end translate
  (e2e SCORE 1.0→−1.6) — they interact with the task, which is why no single
  earlier phase found this; only the fully-stacked run did. Splitting translation
  out of Whisper also yields more natural English; its residual weakness is
  mis-heard proper names.
- **Japanese-specialised ASR did NOT help on this domain**: kotoba-whisper-v2.0
  (content 51.3) and Qwen3-ASR-1.7B (52.2) both *lose* to large-v3 transcribe
  (55.8) — their clean-speech leaderboard CER wins don't transfer to stylized
  anime-trailer audio (music/SFX/dramatic delivery/proper nouns).

Bench-environment gotchas (Windows, this machine):
- **Do not leave `torchcodec` installed** — torchaudio≥2.9 routes through it and it
  hijacks faster-whisper's decoder (gibberish/crash). `separate_vocals` does audio
  I/O via the ffmpeg *binary* instead.
- **qwen2.5 produces multilingual word-salad in this Ollama build** (0.30.6) — use
  qwen3 / qwen3.5; disable thinking (`think:false`).
- The `qwen-asr` package downgrades transformers (5.5.3→4.57.6); core (faster-whisper,
  sentence-transformers) still works but verify after install.
- kotoba can't emit word-level timestamps (distilled → DTW alignment crash) and its
  chunk timestamps are coarse; Qwen3-ASR needs a separate `Qwen3-ForcedAligner` for
  timing. Both make them poor subtitle-timing fits regardless of text quality.

The backend includes an auto-scheduler (in `index.ts`) that runs the batch
script automatically on Wednesdays between 2–4am when the next anime season
is within **50 days**. The local large-v3 GPU script runs every Sunday (no
window gate) and handles all 3 seasons first; this medium batch is the
fallback for anything large-v3 missed. Runs once per Wednesday max, with
`--cutoff 10` to stop by 10am. No external cron setup needed.

Each batch run covers **only the current-displayed season** by default — so a run
never hits YouTube with more than one season's worth of downloads (avoids the bot
wall). `--all-seasons` restores the old prev+current+next sweep; `--season`/`--year`
overrides to a specific one. Downloads are **sequential with a `--download-delay`
(default 5 s)** between trailers, and the run **aborts on a YouTube bot-challenge**
(`_is_bot_block`) instead of hammering the rest — mirroring `local_translate.py`.

Audio is chunked with a ramp-up strategy (5 s, 5 s, 10 s, 10 s, then 20 s)
starting from second 0. On-demand uses `beam_size=1` +
`condition_on_previous_text=False` for speed; batch uses `beam_size=5` +
`condition_on_previous_text=True` for quality. All transcription calls use
`word_timestamps=True` — segment start times are taken from `words[0].start`
rather than `seg.start`, which eliminates the pre-speech lead-in that caused
subtitles to appear before the person actually spoke. Subtitle timing syncs to
YouTube's iframe API `currentTime` and respects play/pause state.

Python dependencies: `faster-whisper`, `yt-dlp`, `youtube-transcript-api`,
and system-level `ffmpeg`. Both `small` and `medium` models are
pre-downloaded in the Docker image.

**Local GPU translation:** `tools/local_translate.py` runs on your PC with
GPU support (`large-v3` + `float16` on CUDA) and uploads results via
`POST /api/translate/upload`. Supports `--video` for single videos,
`--no-upload` for local-only testing, `--dry-run`, `--season` / `--year`,
and `-u` / `-p` for login. `tools/translate.bat` is a Windows wrapper with
no `--within-days` gate — it always runs and covers 3 seasons, skipping
already-cached videos automatically.

The full-audio (large) path uses the **champion split pipeline** (the bake-off
winner — see the bake-off harness section above): bestaudio → **Demucs vocal
separation** → large-v3 `task=transcribe` (ja, `beam_size=10,
repetition_penalty=1.2, vad_min_speech_300`) → **`qwen3.5:9b` translate via
Ollama** (greedy, anime-title context). Uploaded as **`modelName=large-v3-split`**
(rank 6, above plain `large-v3`), so existing `large-v3` subs auto-upgrade on the
next run. Reuses `bench_pipeline.separate_vocals` / `translate_ollama_qwen`.
(Translator choice: `qwen3.5:9b` benchmarked clearly better than text-only
`qwen3:8b` — content 57.3 vs 53.6, halluc 34.5% vs 41.0% (suites `qwen359`/`qwen38`),
so it's kept despite being the Ollama *vision* build whose ~1.2 GB vision encoder
sits unused in RAM; the LLM itself runs 100% on GPU. `--translate-model` overrides.)
- The script **manages Ollama**: starts `ollama serve` if it's down and
  unloads the model + stops the server when finished (leaves the box clean;
  `--keep-ollama` to skip). If Ollama is unreachable or the model is missing it
  **falls back to end-to-end Whisper translate** (tagged `large-v3`) so a run
  never produces nothing. `--legacy-translate` forces the old e2e path.
- Extra deps on the local box: `pip install demucs` + Ollama with
  `ollama pull qwen3.5:9b`. **Do not install `torchcodec`** (torchaudio routes
  through it and it breaks faster-whisper; audio I/O uses the ffmpeg binary).
  `qwen2.5` is broken in the local Ollama build (word-salad) — use `qwen3`/`qwen3.5`.
- Phase 1 **downloads run serially** with a delay between trailers
  (`--download-delay`, default 5 s) — bursty parallel downloads were what tripped
  YouTube's "confirm you're not a bot" wall, so parallelism was removed (the
  `--download-workers` flag is now ignored). yt-dlp also gets `sleep_interval_requests=1.5`.
  On a bot-challenge the run **aborts immediately** (`BotBlockError`) instead of
  hammering the rest. YouTube auth via `--cookies <cookies.txt>` (Netscape format;
  `--cookies-from-browser` exists but fails on modern Edge/Chrome — App-Bound
  Encryption / DPAPI, yt-dlp #10927 — so a cookies.txt export is the reliable path).
  Seasons are processed **one at a time** (fetch → phase 1/2/3 → next season). Long
  trailers are **sub-batched** in the translator (≤20 lines/Ollama call) and any line
  the model leaves in Japanese is retried — prevents the occasional untranslated line.
- Transcriber: large-v3 is the default. `large-v3-turbo` benchmarks comparable content
  (56.6 vs 56.8) but slightly more hallucination (suite `turbocmp`); it's ~4–8× faster
  and available via `--model large-v3-turbo` if speed ever matters.
- VRAM (10 GB): the season run is **phased** — separate-all (Demucs) → transcribe-all
  (Whisper, then `del`+`gc.collect()` to free it) → translate-all (translator stays warm).
  Only one model is GPU-resident at a time, so measured peak is **~6.4 GB** (vs ~9.8 GB
  if Whisper + the translator co-resided per-video) and each model loads once (no
  per-video reloads). All inference is on GPU; easyocr (burned-in OCR) on GPU (~1 GB).
  `run_phased()` in `local_translate.py` owns this; the legacy/fallback per-video path
  is Whisper-only.
- To re-translate the back-catalog with the new pipeline, re-run with `--force`
  (or rely on the rank-6 auto-upgrade for any still tagged `large-v3`).

**Windows Scheduled Task:** "SaltyChart Translate" (`\SaltyChart Translate`
in Task Scheduler root) runs `local_translate.py` directly every **Sunday at
5am** using `py -3.13` with server http://192.168.1.2:8085. Note: the task
calls `local_translate.py` directly, not through `translate.bat`, so changes
to `translate.bat` do NOT affect the scheduled run — update task arguments in
Task Scheduler → SaltyChart Translate → Properties → Actions → Edit (requires
Windows password). The task was created 2026-04-08 with `LogonType: Password`.
No `--within-days` flag (removed; the script always runs covering 3 seasons).
`--within-days` never applied to batch_translate.py or the live daemon.
The Sunday run ensures large-v3 always completes before Wednesday's medium batch.

### Database schema

Auto-created / updated at startup via raw SQL in `ensureDatabaseSchema()`.
Production does **not** run `prisma migrate`; keep
`backend/prisma/schema.prisma` and the raw SQL in `backend/src/index.ts`
in sync when adding columns/tables/indexes.

Tables / columns:

- `Settings` — per-user record storing theme, title language, autoplay,
  hide-from-compare, JSON columns `nicknameUserSel` and `subtitlePrefs`,
  and `addWatchedTo`.
- `WatchList.watchedRank` — integer; 0-based rank assigned after a show is
  watched and ranked in the Randomize page.
- `WatchList.hidden` — boolean; when true the show is skipped by the
  Randomize wheel.
- `AppConfig` — server-wide key/value config (`key` TEXT PK, `value` TEXT).
  Currently holds `plexUrl` / `plexToken`, written by the admin `/admin` page
  via `PUT /api/plex/config`.
- `PlexSubtitle` — `partId` + `streamIndex` unique, `vtt` TEXT, `createdAt`.
  WebVTT extracted from a Plex part's embedded subtitle streams. Extraction
  reads the **entire** episode file (~3.5s for a 900MB MKV at LAN speed), so
  the result is persisted, not just held in memory — an in-memory-only cache
  made every deploy re-pay that cost for every episode. An in-process `Map`
  sits in front of it as an L1 cache. Measured after a backend restart:
  3.9s → 6.7ms.
- `SubtitleCache` — `videoId` unique, `mediaId`, `modelName`,
  `hasEnglishSubs`, `lastEnCheckAt`, `subtitlesDisabled`, `hasBurnedInSubs`,
  `segments` JSON, `createdAt`. Caches check results, translated segments, and
  user subtitle preferences per YouTube video. `modelName` rank order (upload
  only upgrades to an equal-or-higher rank): tiny < base < small < medium <
  large-v2 < large-v3 < **large-v3-split** (the local champion pipeline). The
  rank table lives in **three** places — `backend/src/routes/translate.ts`,
  `backend/scripts/batch_translate.py`, and `tools/local_translate.py` — keep
  all three in sync (a missing `large-v3-split` in any one makes that path treat
  the champion output as rank 0 and needlessly reprocess it).

Performance indexes (added via `CREATE INDEX IF NOT EXISTS` at startup):

- `WatchList_userId_idx` — speeds `findMany({ where: { userId } })`
- `WatchList_season_year_idx` — speeds `/users-with-ratings`
- `Settings_hideFromCompare_idx` — speeds `/api/users`

The bootstrap logic will automatically create tables, add missing columns,
back-fill default `Settings` rows for existing users, and build the indexes
above idempotently on every start-up.

## Frontend Service

Path: `frontend/`

- Tech: Svelte 4, Vite, TypeScript, TailwindCSS (DaisyUI)
- Entry: `src/main.ts` → `App.svelte` (client-side router)
- Dev: `npm install && npm run dev` (Vite dev server on port 5173)
- Build: `npm run build` (produces static assets)
- Preview: `npm run preview`
- Pages (lazy-loaded in `App.svelte`): Home, Login, SignUp, ResetPassword, Randomize, Compare, Admin (header link + page gated to the admin user via the `isAdmin` flag on `/api/plex/status` — `stores/plex.ts`)
- State: simple Svelte stores in `src/stores/` (e.g. `authToken`, `userName`)
- The main anime grid (`AnimeGridTranslate.svelte`) handles trailer subtitles
  via `/api/translate`. If the video has YouTube English CC (checked via a
  batch pre-fetch on page load), YouTube CC is shown and no translation runs.
  Otherwise, Japanese CC is suppressed and Whisper-translated subtitles are
  overlaid. Subtitles sync to the YouTube iframe API's `currentTime` and
  support play/pause/scrub.

### Additional UI features (grouped by surface)

**Global *Options* modal** (gear icon in header). Persists settings in the
`options` store and syncs with `/api/options` when authenticated, or
`localStorage` for guests.
- Theme: `LIGHT`, `NIGHT`, `SYSTEM`, `HIGH_CONTRAST`
- Title language: English / Romaji / Native
- Video autoplay toggle
- Hide-from-Compare toggle (excludes a user's list from public comparisons)
- Nickname user picker (choose which users' custom nicknames show up in pop-ups)

**Season toolbar** (`SeasonSelect.svelte`)
- Search box (client-side fuzzy filter)
- Hide 18+ toggle (adult / pornographic tag)
- Hide sequels & Hide in "My List" toggles

**Main Anime grid refinements**
- Series already in *My List* are no longer 50% opaque; instead they get a
  subtle border highlight so images remain readable.
- Adult shows display a small "18+" badge.
- **Progressive loading** (Home): the current-season fetch and the Leftovers
  fetch each gate only their own sections — the toolbar/headers render
  immediately, `SkeletonGrid.svelte` shimmer cards hold each section's slot
  while its fetch is in flight, and one failed fetch shows a per-section
  error + Retry without blanking the rest. Covers blur-up: the tiny
  `coverImage.medium` renders blurred underneath while `large` fades in on
  load (`fadeInWhenLoaded` in `AnimeGridTranslate.svelte`).

**Randomize page**
- Wheel spin plays a *tick* sound, shows confetti, and displays a spinner
  overlay while the list loads.
- Supports ranking *post-watch* lists via drag-and-drop; ranks are persisted
  in `WatchList.watchedRank` and exposed in compare/randomize pop-ups.
- Pop-up shows other users' nickname + rank for the selected show (queried
  via the nickname endpoints) as well as your own.
- Individual shows can be *hidden* from the wheel via a context-menu (uses
  the `/api/list/hidden` endpoint and `WatchList.hidden` DB column). The
  unwatched column also has **Hide All / Show All / Hide Not on Plex** — the
  last hides every visible unwatched entry the Plex server doesn't have, so
  the wheel only lands on something watchable (shown only when Plex is
  configured; uses the prefetched availability cache).
- "Nicknames from" panel auto-checks users who have any entry for the
  current season/year. Re-runs whenever season or year changes, via
  `GET /api/list/users-with-ratings`. Manual toggles persist only within
  the current season view (they reset on season change).
- When Plex is configured (see `/api/plex` routes), the show pop-up gains a
  **▶ Watch here (via Plex) — SxEy** button (`PlexPlayerModal.svelte`, a
  lazy-loaded video.js chunk — HLS comes from video.js's bundled VHS, there
  is no separate hls.js — streaming through the backend proxy) plus a
  "Plex: <matched title>" caption so a bad fuzzy match is visible; when the
  series (or the entry's specific season) isn't in the library a muted
  "Not on Plex" note shows instead. **Season-aware**: a "2nd Season" /
  「第2期」 entry resolves to that season's episode 1 and is honestly
  unavailable if Plex lacks that season. Availability is prefetched for all
  wheel items when the list loads, so the button appears instantly.
- `PlexPlayerModal.svelte` is a **thin wrapper around video.js 8**
  (Apache-2.0), lazy-loaded in its own chunk — keep it that way. video.js
  owns the control bar, menus, fullscreen, PiP, hotkeys and error handling.
  The wrapper adds only: the Plex HLS source URL, the transcode session
  ping/stop, the JWT on every request (VHS `xhr.onRequest` hook), and the
  **`]` / `[` keys that step playback speed by 0.10× across 0.2×–4.0×** with
  a corner flash — Plex's own player is locked to 0.25× steps, which is the
  entire reason this player exists. `playbackRates` feeds video.js's speed
  menu the same steps so the two can't disagree. The speed keys deliberately
  don't count as user activity: `player.reportUserActivity` is wrapped and
  gated for ~600ms after a speed change — every activity path in video.js
  funnels through it, so clearing `userActive` afterwards just loses the
  race. Only applies when the bar was already hidden, so mouse users are
  unaffected. Subtitles are also pinned at `bottom: 3em` (video.js otherwise
  drops them to 1em while controls are hidden, so they hop whenever the bar
  slides in or out).
- Enabled video.js options: `skipButtons` (±10s), `enableSmoothSeeking`,
  `experimentalSvgIcons`, `persistTextTrackSettings` (video.js stores the
  viewer's caption styling in localStorage; SaltyChart only seeds defaults —
  transparent background, white text, uniform edge — when nothing is stored
  yet), plus a small `:global` style to un-hide the elapsed/duration
  readouts the default skin suppresses.
- **Seeking = repositioning the session, not making a new one.** Plex only
  produces segments forward from where a session started, so a seek beyond
  that returns 404s VHS retries forever ("buffering forever"). The fix is to
  re-request `start.m3u8` with a new `offset` **and the same `session` id** —
  Plex moves the existing transcoder (verified: session count unchanged
  across six seeks, one session for the whole playback, stopped once on
  close). Do *not* mint a session per seek: that churns sessions and leaks
  one whenever a `/stop` is missed. The player repositions when a seek lands
  outside the buffered range, and a watchdog does the same after 10s without
  progress — it deliberately does *not* skip while `seeking()` is true, since
  that's precisely the stuck case. A seek arriving mid-reposition is stashed
  in `pendingSeek` and applied once the new source loads. Three guards keep
  that from eating itself: loading at an offset makes the player emit its own
  `seeked` at that offset (ignored when it's within 5s of the restart target,
  or it would restart at the same spot forever), the watchdog skips while a
  restart is in flight, and the `restarting` flag times out after 30s so a
  source that never reaches `loadedmetadata` can't latch it and silently
  swallow every later seek.
- Picture-in-picture is deliberately disabled. Chromecast is wired up via
  `@silvermine/videojs-chromecast` (MIT) but **cannot work as deployed**:
  Google's Cast sender SDK only initialises in a secure context (HTTPS or
  localhost), and SaltyChart is served over plain HTTP on the LAN, so
  `window.chrome.cast` never exists and the button never renders. The player
  therefore checks `window.isSecureContext` and skips loading the plugin and
  Google's SDK entirely rather than delaying every player open for a button
  that can't appear. Serving the app over HTTPS lights it up with no code
  change.
- **Subtitles** come from the file itself, surfaced through video.js's own
  captions menu (there is no separate SaltyChart control). Plex's HLS output
  never carries subtitle renditions — verified across embedded-ASS,
  embedded-SRT and sidecar-SRT files — and its only offer is to *burn* them,
  which additionally ignores `subtitleStreamID` (PMS 1.43). So
  `/api/plex/subtitles` converts them: a sidecar file is fetched from Plex
  and converted in ~0.1s, while embedded tracks need one ffmpeg pass over
  the source file (~10-40s, all languages at once, then cached). A library
  scan of 60 shows found 44 embedded-only, 8 sidecar, 8 with no subtitles.
  **Playback waits for the English track** — starting an anime episode before
  its subtitles arrive just means missing the opening dialogue, so `autoplay`
  is off and `startPlayback()` runs once the track is registered (the video
  loads and buffers throughout, so it starts instantly then). A "Loading
  subtitles…" chip with a **Play anyway** button covers the wait, and a 45s
  cap starts playback regardless; a file with no English track doesn't wait at
  all. In practice the wait is usually zero — see `warm-subtitles` above.
  Tracks are registered with video.js only once the fetch lands; attaching
  them earlier makes the browser eagerly pull every language into the
  still-running extraction. The player passes every subtitle index it
  already has from Plex's metadata (`indexes=…`), so the server needs no
  ffprobe of its own. Extractions are deduplicated per part and capped at
  **2 concurrent** — each one streams a whole episode file through ffmpeg on
  the same box that transcodes for Plex.
- **The extractor's file URL must carry `download=1`.** Without it Plex reads
  a plain `/library/parts/{id}/file.mkv` request as a second *playback* of
  that item and reaps the transcode session the player is streaming from:
  the first segment succeeds, every one after it 404s (the session ping 404s
  too), and the video buffers forever on the first open of any episode whose
  subtitles aren't cached yet. A/B verified against a live session — plain
  URL → next segment 404, `download=1` → 200. Passing a different
  `X-Plex-Client-Identifier` does *not* help; only `download=1` does.
- **Plex burns the part's remembered subtitle selection into the video** and
  ignores `subtitles=none` *and* `subtitleStreamID=0` on the stream URL (PMS
  1.43 reported `subtitleDecision: burn` with both set). That produced
  doubled text — Plex's burned-in copy under the player's own WebVTT track.
  The player therefore calls `POST /api/plex/clear-burn/:partId` before
  starting a stream, which PUTs `subtitleStreamID=0` onto the part. When
  debugging "double subtitles", pull a frame straight from the source file
  (`ffmpeg -ss <t> -i <file> -map 0:v:0 -frames:v 1`) before blaming
  hardsubs — these library files are *not* hardsubbed; Plex was the source.
- Track selection prefers a **plain English dialogue track**: labels matching
  `sdh|dubtitle|sign|song` are set aside (SDH interleaves "[door creaks]",
  dubtitles are written for the dub rather than the Japanese audio, and
  signs/songs aren't dialogue). The file's **own flags**, which Plex exposes
  but hides in the UI, do the rest: `default` breaks the tie *within* the
  chosen set — not on its own, since releases do flag SDH as default —
  `forced` excludes signs-only tracks, and `title` is folded into the menu
  label so several tracks Plex all calls "English" appear as "English",
  "English (Dubtitle)", "English Forced". If nothing plain exists the flag
  decides among the rest, then the first English track. Exactly one track is
  enabled, by object identity — matching on labels switched on every English
  variant at once, which is what double subtitles looked like.
- While the player is open `handleModalKey` is suppressed so Enter can't
  mark-watched underneath. Caveat: playback runs under the server account
  (the admin's X-Plex-Token), so progress doesn't sync to viewers' Plex
  profiles.

**Compare page** (redesigned; mobile + desktop share the same card layout)
- One card per anime with cover thumbnail, canonical title (de-emphasised),
  and a 3-column rank strip `[your rank | diff badge | other rank]`. Custom
  nicknames are the primary typography (bold, up to 2-line clamp); titles
  are italic/faded secondary info.
- Sticky username bar pins `[you | other]` to the viewport top while cards
  scroll beneath. Implementation requires `html, body { overflow-x: clip }`
  in `app.css` — `overflow: hidden` would create a scroll container that
  breaks `position: sticky`.
- Unified controls: season/year row, then a 2-column grid with
  `{yourName}:` + pre/post selector on the left, and `2nd user:` + combobox
  + pre/post on the right (bottom-aligned so the two pre/post dropdowns
  share a row).
- Default sort is `rankA` (your ranking), not `diff`.
- Desktop content caps at `calc(100vw - 50rem)` at the 2cols breakpoint
  (narrower than Home's `-40rem` so the cards don't feel sprawling).
- Heatmap legend + Share-as-image button retained on desktop only.
- Can toggle between *pre-watch* order and *post-watch* rank per user
  independently (you can compare your pre-watch vs their post-watch).

**Misc**
- The header logo carries a small `?` badge (top-right of "SaltyChart" in
  `App.svelte`) whose tooltip shows the deployed version — the
  `YYYYMMDD-<sha>` tag injected by CI as the `APP_VERSION` build-arg →
  `VITE_APP_VERSION` (frontend Dockerfile). Local/dev builds show `dev`.
- On first load (or after cache expiry), the default season uses a **76-day
  look-ahead**: if the next anime season starts within 76 days, that season
  is shown instead of the current one. This means the app switches to the
  upcoming season roughly 2 weeks after the current season's first episode
  airs — the goal is to browse trailers for what's coming next.
  `computeInitialSeason()` in `src/stores/season.ts` owns this logic.
- The home page shows "X days until [next season]" helper text, derived
  locally from the browser date (no API call). Season start dates used are
  Jan 1 / Apr 1 / Jul 1 / Oct 1 (`nextSeasonInfo()` in `season.ts`).
- Ctrl+Shift+R (or Ctrl+F5) hard-reloads the page and resets the cached
  season selection back to the computed default.
- The last selected season/year is remembered across navigations (1-hour TTL).

## Prisma

Path: `backend/prisma/schema.prisma` (a legacy root-level `prisma/` folder
from the old SvelteKit prototype has been removed).

- Defines `User`, `WatchList` (with `watchedRank`, `hidden` columns),
  `Settings`, the two runtime caches `SeasonCache` / `SubtitleCache`, and the
  server-wide `AppConfig` key/value table (Plex URL/token).
  `Settings.nicknameUserSel` and `subtitlePrefs` (JSON, read/written via raw SQL
  in `/api/options`) are now declared on the model too. `SeasonCache` /
  `SubtitleCache` are created & patched only by the raw SQL in `index.ts`; the
  Prisma models mirror them so `prisma migrate` doesn't flag drift (and offer a
  reset that would drop cached translations) and so the client is typed for them.
- Index declarations in the schema: `@@index([userId])`,
  `@@index([season, year])` on `WatchList`; `@@index([hideFromCompare])`
  on `Settings`. These are also created at runtime via
  `CREATE INDEX IF NOT EXISTS` so production doesn't need to run
  `prisma migrate`.
- SQLite datasource via `DATABASE_URL` (defaults to `file:./prisma/data.db`
  inside the container; locally the real DB is at
  `backend/prisma/prisma/data.db`).
- Run `npx prisma generate` after schema changes and mirror any
  column/index work in the raw SQL in `backend/src/index.ts`.

## Docker Compose

Compose file: `docker-compose.yml` (mirrors the production compose on the
Unraid server at `/mnt/user/appdata/saltychart/docker-compose.yml`).

- `backend` service: `ghcr.io/drohack/saltychart-backend:latest`, SQLite
  bind-mounted from `/mnt/user/appdata/saltychart/prisma` (a legacy
  `saltychart_db` named volume exists on the server but is stale since
  April 2026 — never point anything at it), exposes 3000 internally,
  health-checked before frontend startup. `JWT_SECRET` comes from an
  untracked `.env` (hardcoded directly in the server's compose copy).
- `frontend` service: `ghcr.io/drohack/saltychart-frontend:latest`, nginx
  serving on host port 8085.
- Local usage: `docker build` the images yourself (see Deployment below) or
  `docker compose pull && docker compose up -d` to run what CI published.

## Deployment (CI/CD)

**Push to `master` = deploy.** No manual builds, transfers, or GUI steps.

- `.github/workflows/deploy.yml` — on every push to master (ignoring
  `**.md`, `docs/**`, `tools/**`): gates on backend `tsc --noEmit` +
  frontend `vite build`, then builds and pushes
  `ghcr.io/drohack/saltychart-{backend,frontend}` tagged `latest` +
  immutable `YYYYMMDD-<shortsha>`. Single job; both images push together
  atomically after both builds succeed.
- `.github/workflows/build-base.yml` — **manual dispatch only**, takes a
  `version` input. Builds `backend/Dockerfile.base` →
  `ghcr.io/drohack/saltychart-backend-base:<version>` (~3.3 GB: python3,
  ffmpeg, pip deps, pre-downloaded Whisper small+medium).
- `backend/Dockerfile`'s runtime stage is `FROM` the **pinned** base tag, so
  routine deploys transfer only ~100 MB of app layers, never the models.
  **Rule: any edit to `backend/Dockerfile.base` requires dispatching
  `build-base` with a new version AND bumping the `FROM` tag in
  `backend/Dockerfile` to match** — the base is never rebuilt automatically.
- Pull side: Unraid User Script `update_saltychart` (cron `*/10`, reference
  copy `tools/unraid/update_saltychart.sh`) — `docker compose pull`; if a
  new image arrived it backs up the DB via the existing
  `backup_saltychart_db` script, then `docker compose up -d` + image prune,
  logging to `/mnt/user/appdata/saltychart/update.log`.
- The full pre-deploy suite (`tools/tests/run_all.py`) **cannot run in CI**
  (Playwright against live dev servers + GPU test) — run it locally before
  pushing to master (see *Testing* above).
- Data safety: the DB bind mount (`/mnt/user/appdata/saltychart/prisma`) is
  never touched by deploys, and every applied update is preceded by a DB
  backup. Backup/restore User Scripts snapshot the **live** DB via the
  SQLite online-backup API — reference copies in `tools/unraid/`. Rollback =
  pin compose to a previous `YYYYMMDD-<sha>` tag (+ `restore_saltychart_db`
  if needed).
- Design spec: `docs/superpowers/specs/2026-07-09-cicd-deployment-design.md`.
  README has the user-facing walkthrough incl. offline tar fallback.

## Common Workflows

Local development:
```bash
# One-time setup
cp backend/.env.example backend/.env   # provides DATABASE_URL for ts-node-dev
pip install youtube-transcript-api     # enables English CC detection locally

cd backend && npm install && npm run dev
cd frontend && npm install && npm run dev
```

Full stack via Docker Compose:
```bash
docker compose up --build
```

Backend codegen (Prisma): `npm run generate`

Production build:
```bash
cd backend && npm run build
cd frontend && npm run build
```

## Technical rules (specific to this codebase)

- Always load environment variables (`dotenv.config()`) before importing
  the Prisma client.
- When modifying the DB schema, update both `schema.prisma` and raw SQL
  logic in `backend/src/index.ts` (or add Prisma migrations). This is
  especially important for the `Settings` table, which is created and
  patched via raw SQL, and for new preference columns that the frontend
  expects.
- Frontend routing is file-based in `src/pages`; lazy-loading requires
  updating the switch in `App.svelte`.
- Cache season data in `SeasonCache` table (SQLite) and in-memory LRU
  (`routes/anime.ts`).
- Respect rate limits for the AniList API (handled via retry/backoff logic).

## Troubleshooting

- If the DB schema is out of sync, inspect console logs from
  `ensureDatabaseSchema()`.
- For 429 errors from AniList, check retry headers and backoff code in
  `anime.ts`.
- For CORS or proxy issues, verify `vite.config.ts` proxy settings
  (frontend).
- If every trailer shows Whisper auto-translation instead of YouTube English CC
  locally, run `pip install youtube-transcript-api`. Without it the Python
  `check_subtitles()` silently returns `hasEnglish: false` for all videos.
  The backend ts-node-dev process must be restarted after installing.
- If the backend starts but every request returns 500, `DATABASE_URL` is
  missing. The server now exits with `[FATAL]` on startup if it's not set.
  Fix: ensure `backend/.env` exists (copy from `backend/.env.example`).

## References

- Root `README.md`: high-level overview & quick start
- `backend/src/` for API logic and the raw-SQL schema bootstrap
- `backend/prisma/schema.prisma` for the declarative Prisma schema
- `frontend/src/` for UI components, pages, stores
- `tools/` for Python helper scripts (local GPU translation etc.)
