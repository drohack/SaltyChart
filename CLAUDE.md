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
3. Skim `README.md` and this file for stale mentions of the old behaviour
   and update them.
4. If you touched `shareCompare()` in `Compare.svelte` or `shareMyList()`
   in `WatchListSidebar.svelte`, manually verify the share button still
   exports a reasonable image — both functions are DOM-clone-heavy and
   brittle to layout changes.
5. **Clean up Playwright screenshots** at the repo root:
   `rm compare-*.png randomize-*.png home-*.png home-desktop-after-gap-fix.png 2>/dev/null`

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
├── tools/            # Python helper scripts (local_translate.py etc.)
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
  - `JWT_SECRET` (required for auth token signing)
  - `DATABASE_URL` (defaults to `file:./prisma/data.db` in production)

### API routes mounted under `/api/*`

- `/api/health`          (health check)
- `/api/anime`           (AniList GraphQL proxy + cache)
- `/api/auth`            (login, signup, password reset, JWT issuance)
- `/api/list`            (user watchlist CRUD)
- `/api/public-list`     (public watchlist read-only)
- `/api/users`           (user management)
- `/api/options`         (per-user UI preferences)

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

### Rate limiting

A 120 req/min per-IP `generalLimiter` covers all routes by default.
`/api/auth/*` has a stricter 20 req/min limiter. The 4 unauthenticated
`/api/list/*` endpoints above additionally sit behind a 60 req/min
`publicListLimiter`.

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
- `GET /api/translate/stream?videoId=&mediaId=` — SSE subtitle stream; serves from cache on repeat plays
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

The cache (`SubtitleCache.hasEnglishSubs`) only trusts a stored positive (1).
A stored false (0) falls through to re-run Python so old incorrectly-cached
results self-heal. The cache write never downgrades a stored true to false.

`youtube_transcript_api` must be installed locally (`pip install youtube-transcript-api`)
for the English sub detection to work in dev. It is pre-installed in Docker.

On-demand translation uses a persistent Python daemon
(`backend/scripts/translate_daemon.py`) with the `small` Whisper model
(int8) for fast live results. Batch pre-translation
(`backend/scripts/batch_translate.py`) uses the `medium` model (int8) for
higher quality and automatically upgrades videos previously translated with
`small`. The batch also pre-checks English subtitles and caches
`hasEnglishSubs` to avoid a Python spawn on first play.

`local_translate.py` uses `beam_size=10` (benchmarked against 30 settings
on 10 full Summer 2026 trailers; beam_10 captured most of the quality gain
over the default beam_5 with diminishing returns beyond beam_10).

Benchmark data lives in `tools/benchmark_data/` (gitignored) and results in
`tools/benchmark_results.txt`. Script: `tools/benchmark_whisper_settings.py`.
Key findings from the benchmark:
- `beam_size=10` gives ~+7 score improvement over beam_5 baseline
- `repetition_penalty=1.2` gives similar ~+7 improvement individually
- **Combining them doesn't stack** — together scores only +6.6, same as either alone
- `hallucination_silence_threshold`, `log_prob_threshold`, `initial_prompt` all hurt
- `suppress_blank`, `auto_lang`, `best_of` had zero effect (identical to baseline)
- `vad_filter=False` much worse (-37 vs -29 baseline)

The backend includes an auto-scheduler (in `index.ts`) that runs the batch
script automatically on Wednesdays between 2–4am when the next anime season
is within **50 days**. The local large-v3 GPU script runs every Sunday (no
window gate) and handles all 3 seasons first; this medium batch is the
fallback for anything large-v3 missed. Runs once per Wednesday max, with
`--cutoff 10` to stop by 10am. No external cron setup needed.

Each batch run covers **three seasons** automatically (prev, current-displayed,
next) so coverage is complete regardless of which season the app is showing.
Passing `--season`/`--year` explicitly overrides to a single season.

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
- `SubtitleCache` — `videoId` unique, `mediaId`, `modelName`,
  `hasEnglishSubs`, `subtitlesDisabled`, `hasBurnedInSubs`, `segments` JSON,
  `createdAt`. Caches check results, translated segments, and user subtitle
  preferences per YouTube video.

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
- Pages (lazy-loaded in `App.svelte`): Home, Login, SignUp, ResetPassword, Randomize, Compare
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

**Randomize page**
- Wheel spin plays a *tick* sound, shows confetti, and displays a spinner
  overlay while the list loads.
- Supports ranking *post-watch* lists via drag-and-drop; ranks are persisted
  in `WatchList.watchedRank` and exposed in compare/randomize pop-ups.
- Pop-up shows other users' nickname + rank for the selected show (queried
  via the nickname endpoints) as well as your own.
- Individual shows can be *hidden* from the wheel via a context-menu (uses
  the `/api/list/hidden` endpoint and `WatchList.hidden` DB column).
- "Nicknames from" panel auto-checks users who have any entry for the
  current season/year. Re-runs whenever season or year changes, via
  `GET /api/list/users-with-ratings`. Manual toggles persist only within
  the current season view (they reset on season change).

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

- Defines `User`, `WatchList` (with `watchedRank`, `hidden` columns), and
  `Settings` models. `Settings` in the live DB also has `nicknameUserSel`,
  `addWatchedTo`, and `subtitlePrefs` columns that are not in the Prisma
  schema — they're read/written via raw SQL in `/api/options`.
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

Compose file: `docker-compose.yml`

- `backend` service: builds `backend/Dockerfile`, mounts `dev.db` volume,
  exposes 3000, health-checked before frontend startup.
- `frontend` service: builds multi-stage `frontend/Dockerfile`, mounts
  source for hot reload, serves on port 80.
- Usage: `docker compose up --build`

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
