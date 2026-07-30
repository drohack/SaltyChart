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
| `test_jellyfin.py` | 10 steps: `/api/jellyfin` auth/admin gates, `?token=` paths, availability shape, stream proxy + a manifest credential-leak assertion, subtitle fetch, `Cache-Control` on subtitles/attachments, and a well-formed WebVTT header (the `Region:` lift); live steps auto-skip when Jellyfin is unconfigured |
| `test_player.py` | 9 steps driving the **real player**: pop-up pre-warm fires (and no stream starts early), playback advances, exactly one subtitle menu with a plain-English default, track switching, `[`/`]` stepping 0.10 with the bar hidden, libass canvas covering the video with no silent WebVTT fallback, Escape stopping the transcode. Auto-skips when Jellyfin is unconfigured or nothing in the season is in the library |
| `backend npm run test:unit` | Matching helpers via `node --test`: Unicode normalisation guards, season parsing, and the known false positive |

Final line on success: `Pre-deploy: 12/12 passed — ready to build` (11/11 with
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
│   │                 #   + bench_player.py (Jellyfin playback startup timings)
│   │                 #   + check_match_corpus.py (real-data library matching check)
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
- `/api/jellyfin`        (Jellyfin integration: availability, playback, streaming — see below)

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

### Jellyfin integration routes (`/api/jellyfin`)

The admin points SaltyChart at a Jellyfin server (URL + API key) on the
`/admin` page; both are stored in the `AppConfig` DB table. **The API key
never reaches a browser** — availability responses carry only ids and display
strings, and the stream proxy injects the key server-side. Like
`/api/translate`, this router mounts **before `compression()`** (the stream
proxy pipes HLS segments, which compression would buffer), so it carries its
own limiter instances and JSON parser.

An **admin API key alone authenticates everything** — no user login, no
per-viewer Jellyfin accounts. Playback therefore runs under the server
account, so progress doesn't sync to anyone's Jellyfin profile.

**"Direct stream" still runs ffmpeg and still writes to the transcode cache.**
This library direct-streams (8/8 sampled episodes: codecs copied, no transcode
reasons), and it is tempting to read that as "no ffmpeg involved". It is not.
Browsers cannot play MKV, so every playback is *remuxed* into MPEG-TS segments
for HLS — cheap on CPU, identical on disk to a real transcode. Three modes,
and only the first is free:

| mode | ffmpeg | re-encodes video | writes to transcode dir |
|---|---|---|---|
| direct play | no | no | no |
| **direct stream (remux)** ← what we do | **yes** | no | **yes** |
| transcode | yes | yes | yes |

Two consequences that have both bitten:

- Jellyfin's ffmpeg writes segments **until the whole file is done, regardless
  of the playhead**, and its cleanup timers do not keep up for remux jobs
  (jellyfin#16608). An abandoned session therefore leaves most of a ~1.4 GB
  episode on disk. This is why the pop-up pre-warm never touches the HLS
  manifest — and why `tools/bench_player.py`, which *does* start real sessions,
  must not be run casually: nine cold runs filled the transcode cache and made
  Jellyfin serve empty (HTTP 200, 0-byte) segments, which presents as "video
  never starts" and is indistinguishable from an app bug until you request a
  segment directly from Jellyfin and see the same thing.
- Keeping the subtitles *out* of the video avoids the third row, not the
  second. Burning them in would force a full re-encode of every stream; it
  would not change how much lands in the transcode cache.

- `GET  /api/jellyfin/status`   — `{ configured, isAdmin }` probe (JWT
  required). `isAdmin` rides along so the header's Admin link doesn't need to
  probe an admin-only endpoint (which would 403-spam the console for
  everyone else); `stores/jellyfin.ts` fetches this once per login.
- `POST /api/jellyfin/availability` — `{ mediaId, titles[] }` → is the series
  in the library + the entry's season's first episode (season parsed from
  "Nth Season"/「第N期」 markers; missing season = unavailable; no marker =
  first episode overall, skipping season-0 specials). Returns
  `{ available, seriesId, itemId, mediaSourceId, episodeTitle, seasonNumber,
  episodeNumber, libraryTitle, matchedBy }`. Matching is the shared module —
  see *Matching AniList entries to the library* below. The series list is
  fetched once and cached 1h; **`Fields=ProviderIds,OriginalTitle` is
  mandatory** on that query or Jellyfin returns `ProviderIds: null`, which
  reads exactly like "no ids exist" and silently disables the id tier.
  Per-mediaId cache: 1h positives, 10min negatives. `fresh: true` bypasses
  the negative cache and refetches the library on a match-miss (throttled to
  one refetch per 30s — every negative asking for its own refetch turned into
  a stampede that reported everything as missing).
  Always 200 — server down/unconfigured is `{ available: false, unknown: true }`
  (never cached). **`unknown` is load-bearing**: it means "couldn't ask", not
  "not in the library", and every consumer must refuse to hide a show on it,
  or one slow moment empties the wheel.
- `GET  /api/jellyfin/playback/:itemId` — one call returning the
  `playSessionId`, the `mediaSourceId`, the subtitle streams (with the file's
  own `isDefault`/`isForced`/`isHearingImpaired` flags and codec) and the
  embedded font attachments.
- `GET  /api/jellyfin/stream/*` — GET-only streaming proxy (JWT via
  `Authorization` header or `?token=`). Forwards `Range`, destroys the
  upstream transfer when the client disconnects. **Manifests are buffered and
  refused if they contain a credential**: Jellyfin embeds the caller's own key
  into subtitle rendition URIs when asked for HLS subtitles, so never send
  `subtitleMethod=Hls` — subtitles are fetched as files instead, and this
  guard makes "the key never reaches a browser" a guarantee rather than a
  convention.
- `GET  /api/jellyfin/subtitles` — `{ itemId, mediaSourceId, index, format }`,
  proxying Jellyfin's own conversion. `format=ass` on an ASS source is a
  pass-through of the original (styling, positioning and karaoke intact).
  `format=vtt` additionally **lifts `Region:` lines into the header**
  (`liftVttRegions`): Jellyfin emits them *after* the blank line that closes it,
  and a spec-following parser then reads `Region:` as a cue id and throws —
  costing a console error and one dropped cue (360 of 361 on a measured
  episode). Note this does not make regions *work*: vtt.js splits that header
  line on `:` and ignores it unless there are exactly two parts, so Jellyfin's
  `id:subtitle width:80% …` is unparseable to it wherever it sits. Costs
  nothing, because Jellyfin repeats the placement on every cue (`line:90%`).
- `GET  /api/jellyfin/attachments` — an embedded font, so libass renders signs
  in the typeface the release intended. **Indices are the file's own stream
  numbers and do not start at 0** — they must come from `/playback`, or every
  request 502s.
- Both of the above send `Cache-Control: private, max-age=86400`. They are
  immutable for a given item+index (replacing a release changes the item id),
  so a rewatch never refetches a font pack.
- `POST /api/jellyfin/playback/stop` — `{ playSessionId }`; tears the
  transcode down rather than leaving it to time out on a shared box.
- `GET/PUT /api/jellyfin/config` + `POST /api/jellyfin/config/test` — admin
  only (`ADMIN_USER_ID`): read config (URL + `apiKeySet`, never the key), save
  (empty key keeps the stored one), and test a connection (returns server name,
  version + library list, or the error, always as 200 `{ ok, ... }`). The test
  hits authenticated `/System/Info`, not `/System/Info/Public`, so a green
  result proves the key works rather than only that the server is reachable.

### Matching AniList entries to the library

`backend/src/lib/animeMatch.ts` — pure, no I/O, so it is unit-tested directly
(`npm run test:unit`) and reusable by anything else that needs to resolve an
AniList entry (a future Sonarr sync). `backend/src/lib/anilistTvdbMap.ts` does
the I/O half.

Two tiers, and **both are permanent**:

1. **id** — AniList id → TVDB id (community map from `Fribb/anime-lists`,
   ~7.2k pairs, cached in `AppConfig` and refreshed weekly) → a library series
   carrying that TVDB id. Exact.
2. **title** — the Unicode-aware fuzzy matcher: NFKD, strip diacritics, keep
   letters/digits of **every** script, then exact > prefix > contains with
   length/ratio guards. Do not "simplify" `normalizeTitle` to `[a-z0-9]`: that
   reduced 「転生貴族、鑑定スキルで成り上がる 第3期」 to `"3"`, which then
   matched *30 Rock*.

Measured over a full season against the real library, the id tier finds a
strict **subset** of what titles find (35 vs 45 of 52) — it adds no reach,
because community id coverage tracks how long a season has been airing (~55%
two months out, ~94% once finished). Its value is **confidence**: the response
says `matchedBy`, the pop-up marks title-only matches as unconfirmed, and bulk
actions refuse to act on them. That matters — fuzzy matching produced a real
false positive (AniList's 2026 *Mahou Shoujo Lyrical Nanoha EXCEEDS* matching
the library's 2004 *Magical Girl Lyrical Nanoha*).

**Jellyfin's matching is controlled by `tvshow.nfo`, not by folder names.**
The Anime library reads local metadata first — `LocalMetadataReaderOrder:
['Nfo']`, always on, no UI toggle (the "Metadata savers" checkbox is the
opposite thing: it makes Jellyfin *write* NFOs, which would fight Sonarr —
leave it empty). Its remote fetchers are TheMovieDb/OMDb and
`EnableInternetProviders` is false, so the NFO is effectively the only source
of truth for identification.

Sonarr → Settings → Metadata → **Kodi (XBMC) / Emby** writes those files, and
refreshes them on its daily scan, so this stays true for new series without
anyone doing anything. Radarr does the same for movies. Enabling it and
running System → Tasks → Refresh Series backfilled 833/836 anime folders;
Jellyfin's realtime monitor then re-read them on its own and **46 series whose
stored id disagreed with their NFO dropped to 0**, correcting shows that had
been matched to entirely the wrong series (`Demon Lord 2099` → *How Not to
Summon a Demon Lord*, a long `The 100 Girlfriends…` folder → *The Mentalist*)
and identifying ones it had given up on. No folder renaming, no watched state
touched in either server.

Folder-name id tags are a red herring here, but the syntax is worth knowing
because the two servers disagree: **Plex** reads `{tvdb-12345}` (curly, no
`id`) plus `.plexmatch` files, which is what has kept Plex's matching accurate
— it has one in 835/836 folders. **Jellyfin** reads `[tvdbid-12345]` (square,
with `id`) and ignores `.plexmatch` entirely. This library's folders mostly
carry `[tvdb-12345]`, which matches *neither*, so those tags do nothing on
either server.

**When measuring any of this, compare ids, not names, and scope to the seasons
the app shows.** Comparing folder names to titles gives a false all-clear (it
cannot see a folder whose tag says one show and whose stored id says another).
And a library-wide count is misleading: 59 tag/id disagreements across the
whole library was 7 within the two-year window the app actually queries, of
which 2 mattered. `tools/check_match_corpus.py` measures the thing that counts
— how a real season resolves end to end. Such a tool must mirror the shipping
logic exactly, fallbacks included; one that measures a simplified version of
the code reports on a program you don't ship.

### Rate limiting

A 120 req/min per-IP `generalLimiter` covers all routes. `/api/translate/*`
mounts before `compression()` (SSE can't be buffered), so the limiter is
applied explicitly on that mount — `app.use('/api/translate', generalLimiter,
translateRouter)` — rather than relying on the later global `app.use`.
`/api/auth/*` has a stricter 20 req/min limiter. The 4 unauthenticated
`/api/list/*` endpoints above additionally sit behind a 60 req/min
`publicListLimiter`. `/api/jellyfin` also mounts before `compression()` and so
carries its own limiters: 120 req/min for the JSON endpoints and a separate
**600 req/min** for `/api/jellyfin/stream/*`, `/subtitles` and `/attachments`
(HLS playback is a playlist refresh + a segment every few seconds plus seek
bursts — it must not eat the general budget).

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

**Player startup** (suite `player_startup`, `tools/bench_player.py`): times every
stage between pressing Watch and a decoding video, through the SaltyChart proxy
**and** directly against Jellyfin so the proxy's own cost is separable. Findings
over 4 cold runs against the real library:

| stage | median | range |
|---|---|---|
| `/playback` metadata | 0.03 s | 0.03–3.20 |
| `/subtitles` (ASS) | 0.01 s | — |
| fonts (the 3 the script names) | 0.03 s | 0.7 MB |
| master.m3u8 / main.m3u8 | 0.02 s | — |
| **first HLS segment** | **19.9 s** | **1.3–30.0 s** |
| segment 1 (steady state) | 0.06 s | — |

So **everything except the first segment is under 0.25 s**, our proxy adds
nothing measurable (0.02 s proxied vs 0.05 s direct), and client-side work —
libass canvas up at 80 ms — is entirely off the critical path. From the click,
the first stream request leaves the browser at **~65 ms**; that is the whole of
what the app contributes. Pre-loading more, including a pre-built JASSUB
instance, cannot help. Two things the bench found that were *not* inherent are
fixed: a 30 s proxy idle-timeout that aborted slow-but-working streams (Jellyfin
needs up to 50.5 s for a cold first segment), and an `await` on Google's Cast
SDK sitting between the click and the manifest.

Two methodology notes, both learned by getting them wrong first: **stop each
run's encodings before timing the next** (Jellyfin's ffmpeg races ahead writing
the whole file, so leaving them running turns a startup benchmark into a
measurement of the load the benchmark itself created — the giveaway was a median
sitting near the max), and **measure the fonts the app actually sends**, not the
first N attachments, or the number includes the 23 MB Arial Unicode that
`fontsFor` deliberately excludes.

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
  Holds `jellyfinUrl` / `jellyfinApiKey`, written by the admin `/admin` page
  via `PUT /api/jellyfin/config`, plus `anilistTvdbMap` / `anilistTvdbMapAt`
  (the cached AniList→TVDB id map, refreshed weekly at boot).
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

`ensureDatabaseSchema()` also drops the retired `PlexSubtitle` table (it
cached WebVTT extracted from Plex media parts; Jellyfin serves subtitle
tracks directly, so nothing extracts any more).

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
- Pages (lazy-loaded in `App.svelte`): Home, Login, SignUp, ResetPassword, Randomize, Compare, Admin (header link + page gated to the admin user via the `isAdmin` flag on `/api/jellyfin/status` — `stores/jellyfin.ts`)
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
  unwatched column also has **Hide All / Show All / Hide Not in Library** —
  the last hides every visible unwatched entry the library doesn't have, so
  the wheel only lands on something watchable (shown only when Jellyfin is
  configured; uses the prefetched availability cache). It never acts on an
  `unknown` verdict, and title-only matches report `available: true`, so it
  only ever *keeps* an unconfirmed match rather than hiding it.
- "Nicknames from" panel auto-checks users who have any entry for the
  current season/year. Re-runs whenever season or year changes, via
  `GET /api/list/users-with-ratings`. Manual toggles persist only within
  the current season view (they reset on season change).
- When Jellyfin is configured (see `/api/jellyfin` routes), the show pop-up
  gains a **▶ Watch here — SxEy** button (`JellyfinPlayerModal.svelte`, a
  lazy-loaded video.js chunk — HLS comes from video.js's bundled VHS, there
  is no separate hls.js — streaming through the backend proxy) plus a
  "Library: <matched title>" caption so a bad match is visible; a title-only
  match is additionally marked **⚠ unconfirmed match**. When the series (or
  the entry's specific season) isn't in the library a muted "Not in library"
  note shows instead. **Season-aware**: a "2nd Season" / 「第2期」 entry
  resolves to that season's episode 1 and is honestly unavailable if the
  library lacks that season. Availability is prefetched for all wheel items
  when the list loads, so the button appears instantly.
- `JellyfinPlayerModal.svelte` is a **thin wrapper around video.js 8**
  (Apache-2.0), lazy-loaded in its own chunk — keep it that way. video.js
  owns the control bar, menus, fullscreen, hotkeys and error handling.
  The wrapper adds only: the HLS source URL, the play-session lifecycle, the
  JWT on every request (VHS `xhr.onRequest` hook), ASS rendering (below), and
  the **`]` / `[` keys that step playback speed by 0.10× across 0.2×–4.0×**
  with a corner flash — every media server's own player is locked to coarser
  steps, which is the entire reason this player exists. `playbackRates` feeds
  video.js's speed menu the same steps so the two can't disagree. The speed
  keys deliberately don't count as user activity: `player.reportUserActivity`
  is wrapped and gated for ~600ms after a speed change — every activity path
  in video.js funnels through it, so clearing `userActive` afterwards just
  loses the race. Only applies when the bar was already hidden, so mouse
  users are unaffected.
- Enabled video.js options: `skipButtons` (±10s), `enableSmoothSeeking`,
  `experimentalSvgIcons`, `persistTextTrackSettings` (video.js stores the
  viewer's caption styling in localStorage; SaltyChart only seeds defaults —
  transparent background, white text, uniform edge — when nothing is stored
  yet), plus a small `:global` style to un-hide the elapsed/duration
  readouts the default skin suppresses.
- **Seeking is the browser's job.** Jellyfin's `main.m3u8` is a complete VOD
  playlist (`#EXT-X-PLAYLIST-TYPE:VOD` + `#EXT-X-ENDLIST`, generated from
  runtime metadata in ~40ms without waiting on ffmpeg), and the *server*
  repositions its own transcoder when an out-of-range segment is requested.
  So there is no client-side reposition machinery — verified by seeking to
  400s and back to 30s, both resuming unaided. (The previous Plex integration
  needed ~115 lines here because Plex only produced segments forward from where
  a session started; that is gone.)
  What remains is **recovery, not repositioning**. That server-side
  repositioning races Jellyfin's own segment cleanup on remux/direct-stream
  jobs (jellyfin#16608), and a burst of scrubbing can leave a session serving
  nothing at any offset — permanently, because VHS retries a sole playlist
  forever. So the player rebuilds the stream around a **fresh `playSessionId`**
  at the viewer's position, at most twice, logging
  `[player] <reason> — restarting stream at …`.
  **Two different failures, and they need two different detectors:**
  - *The clock stops* — nothing arrives at all. 10s without `currentTime`
    moving.
  - *The picture stops while audio keeps going.* Reported from the field
    (pause → seek a few minutes → resume): the video goes black but
    `currentTime` advances normally, so a clock-watching watchdog sees a
    healthy stream and never fires. Decoded frames are what actually stop, so
    this is caught with `getVideoPlaybackQuality().totalVideoFrames` standing
    still for 8s. Only armed once frames have been decoded at least once, so
    audio-only sources and the pre-roll can't trip it.

  Four details are load-bearing, three of them learned by getting them wrong:
  - It must ask `playbackInfo(..., { fresh: true })`. The cached entry holds
    the very session being escaped, so a cached restart rebuilds the stream
    around the dead session.
  - It only arms **after playback has progressed once**. `paused` goes false
    the moment `play()` is called, so without that guard a legitimately slow
    first segment (measured up to 50s on a cold disk) reads as a stall and gets
    restarted — discarding the ffmpeg that was about to deliver, then doing it
    again on the retry.
  - **`recoveries` resets on decoded frames, never on `timeupdate`.** In the
    picture-stall case the moving clock *is* the symptom, so resetting the
    retry counter there defeats the cap and restarts forever.
  - **After a restart, re-baseline the frame count to what the element reports
    now, not to zero.** A fresh source reports 0 and climbs; a still-wedged one
    keeps reporting its old total. Zeroing made any stuck non-zero count look
    like a recovery and reset the cap again.

  Simulating the signature (pinning the frame counter while the clock runs) is
  how both of those were found — the real failure is intermittent and was not
  reproducible on demand, and an uncapped restart loop is worse than the black
  screen it was meant to fix.
- Picture-in-picture is deliberately disabled. Chromecast is wired up via
  `@silvermine/videojs-chromecast` (MIT) but **cannot work as deployed**:
  Google's Cast sender SDK only initialises in a secure context (HTTPS or
  localhost), and SaltyChart is served over plain HTTP on the LAN, so
  `window.chrome.cast` never exists and the button never renders. Serving the
  app over HTTPS lights it up with no code change.
  **The SDK is never waited on.** It is fetched from gstatic.com — the one
  asset here whose latency is someone else's internet rather than the LAN — and
  the player used to `await` it before constructing itself, putting a third
  party between the Watch click and the first byte of video. It is warmed on
  the Randomize page (`loadCastSdk()`) and the player only offers casting if
  `castReady()` is already true.
- **Subtitles are rendered by libass** (`jassub`, lazy-loaded), fed the raw
  `.ass` from `/api/jellyfin/subtitles` plus the file's embedded fonts from
  `/api/jellyfin/attachments`. That preserves positioning, styling and
  karaoke — WebVTT structurally cannot: converting ASS drops all positioning
  and, on karaoke-heavy releases, leaves ~95% of cues as literal override
  code on screen. Non-ASS tracks use video.js's own text tracks, and if
  libass fails to start the player falls back to server-converted WebVTT so
  subtitles never simply vanish. (That fallback is a genuine safety net, but a
  silent one — it fired for *every* ASS release once, because a double-unwrapped
  `.default` handed jassub `workerUrl: undefined`. `test_player.py` step 8 now
  fails on the fallback warning, so it can't happen quietly again.)
  This is the same architecture jellyfin-web uses — and on a newer renderer:
  `jassub` is maintained, while jellyfin-web still ships SubtitlesOctopus (last
  published 2022). No browser renders ASS natively, so a client-side renderer
  is the only way to keep it without forcing a server-side burn-in transcode.
  Three things cost real time and are worth keeping written down:
  - The worker entry is **`jassub/dist/worker/worker.js`**. jassub's own
    README still documents `dist/wasm/jassub-worker.js`, which is the
    emscripten glue — point `workerUrl` at that and the worker loads but
    never completes its handshake, so `ready` hangs forever and `renderer`
    stays undefined. The visible symptom is a 300×150 canvas parked below
    the video, which looks like a layout bug and is not one.
  - Vite needs **`worker: { format: 'es' }`**; it bundles workers as `iife`
    by default, which cannot code-split, and the build fails outright.
  - **COOP/COEP are not required.** jassub uses SharedArrayBuffer only for
    multi-threading and falls back to single-threaded on its own, so the
    page does not need cross-origin isolation — which matters, because those
    headers would block the YouTube trailer iframes on Home.
  - **`defaultFont` must be set, or a missing font renders nothing.** Scripts
    routinely name a font their own MKV doesn't attach (*The Elusive Samurai*
    asks for "Arial Unicode MS" and ships only plain Arial). jassub registers
    its bundled fallback into `availableFonts` by itself but never nominates it
    as the substitute family, so libass had no face to fall back to and drew
    **empty frames** — worker healthy, canvas correctly sized, `ready` resolved,
    no error anywhere, and the FPS debug counter happily reporting renders.
    Pass both `availableFonts: { 'liberation sans': url }` **and**
    `defaultFont: 'liberation sans'`. Pass the URL explicitly too: jassub
    resolves its own copy via `new URL('./default.woff2', import.meta.url)`,
    which under Vite points into `node_modules/.vite/deps/` where the file
    isn't.
  - **`canvas.width` on the main thread is meaningless.** libass transfers the
    canvas to its worker, so the attribute keeps whatever it last saw (often
    300×150) while `resize()` sets the **CSS** box. Measure with
    `getBoundingClientRect()` against the video's; reading the attribute
    produces convincing nonsense and cost real time twice.
- Because libass paints its own canvas it bypasses video.js's captions menu,
  which can only list text tracks the player owns. So the player **registers
  its own control-bar `MenuButton` and removes video.js's `subsCapsButton`** —
  leaving both gives two subtitle menus that disagree, since the built-in one
  is blind to ASS. The custom menu drives `showSubtitle` for every track type,
  and carries "Caption settings…" as its last item so video.js's caption
  styling dialog stays reachable. Track selection prefers a plain English
  dialogue track: labels matching `sdh|dubtitle|sign|song` are set aside, ASS
  is preferred over SRT of the same content, and the file's own `default` flag
  breaks the tie *within* that set rather than deciding on its own — releases
  do ship with a signs-only track marked default, and some name their tracks
  uselessly (`1`, `2`, `final`), so codec and flags are what can be trusted.
- **Every font the MKV carries is sent to libass**, deliberately. Subsetting
  to just the fonts a script names was built and then removed: it cut a
  measured 250.9 MB of attachments to 5.4 MB, but A/B'd on one episode that
  only moved libass's `ready` from 529ms to 200ms — both invisible behind a
  video that takes 5–13s. It bought ~2% of a ~1.4 GB episode and paid for it
  in correctness: filenames need not resemble the family inside them
  (`f1.ttf` may hold "Helvetica Neue"), so matching was a guess, and it
  guessed wrong on 5 of 28 named fonts across the corpus. Guessing about
  typefaces to save 2% of a stream is a bad trade. jellyfin-web sends them
  all too.
- **Player assets are warmed in two stages**, because they divide cleanly by
  what they depend on (all in `lib/jellyfinPrewarm.ts`):
  - *Nothing show-specific* — the video.js chunk (0.66 MB built, **1.6 MB
    unminified from the dev server**) and libass's wasm worker (~2 MB). Warmed
    on **landing on `/random`**, on `requestIdleCallback` so it never competes
    with the page's own images, gated on Jellyfin being configured and skipped
    on `saveData`/2G. Not warmed app-wide: someone browsing trailers on Home
    should not pay 2.7 MB for a player they never open. **`loadVideoJs()` must
    be shared** — the component's own `import('video.js')` inside `onMount`
    would not be covered by preloading its chunk, since the bulk is the
    dependency, not the component.
  - *Per episode* — playback metadata, the chosen subtitle track and its fonts,
    warmed by `prewarm()` when the **show pop-up opens** (the earliest point an
    itemId exists), cached by itemId so repeated wheel spins reuse them.
  Together, pressing Watch costs only the stream start.
- **The Watch button shows an "Opening…" spinner while the chunk loads.**
  Obvious on localhost that it isn't needed, and wrong everywhere else: over a
  LAN or the web there is a real gap between the click and the modal, and with
  no feedback the button reads as broken. Test on something other than
  localhost before judging player latency. Results are cached by itemId, so repeated wheel spins
  reuse them. **It deliberately never touches the HLS manifest** — Jellyfin's
  transcode throttling is deprecated and off by default and its ffmpeg writes
  segments until the file is done regardless of the playhead, so a pre-started
  stream would remux a whole ~1 GB episode to disk for a pop-up nobody plays.
  With that split, a Watch click is ~2.4s, of which ~1.7s is Jellyfin producing
  segment 0; the manifest itself answers in ~30ms.
- **Playback waits for subtitles**, but that is almost never the wait. Measured
  on a normal open: subtitles are ready at ~240ms while the video needs 3.3s+,
  because the video is waiting on Jellyfin to build the first HLS segment. So
  the "Loading subtitles…" chip is shown **only once the video can play** —
  i.e. only when subtitles genuinely are the thing holding playback. Otherwise
  video.js's own loading spinner is left visible, which is the honest indicator
  for a stream that has not arrived yet. Starting an anime episode before its
  subtitles arrive means missing the opening dialogue, so `autoplay` is off
  and playback begins once the track is registered. The chip carries a
  **Play anyway** button, a 20s cap starts
  playback regardless, and a file with no subtitles doesn't wait at all.
- **video.js's big play button is hidden**, because `autoplay: false` leaves the
  player in its not-yet-started state for the 1–30s Jellyfin spends building the
  first segment, putting a large play button over a video that is already being
  started for the viewer. It reappears (via a `sc-autoplay-blocked` class) only
  if `player.play()` is *rejected* — browsers refuse programmatic playback when
  the gesture that opened the modal is too far in the past, and that is the one
  case where clicking is genuinely required. That rejection used to be swallowed
  silently.
- While the player is open `handleModalKey` is suppressed so Enter can't
  mark-watched underneath. Caveat: playback runs under the server account
  (the admin's API key), so progress doesn't sync to viewers' Jellyfin
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
  server-wide `AppConfig` key/value table (Jellyfin URL/API key + the
  cached AniList→TVDB map).
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
