 # SaltyChart Agents Guide

 This document helps automated agents (e.g., Codex CLI) and new maintainers
 understand the SaltyChart project structure, technologies, and common workflows.

 ## Project Overview
 SaltyChart is a two-service web application for discovering seasonal anime,
 viewing summaries & trailers, and enabling authenticated users to build
 and share custom rankings.

 ## Monorepo Layout
 ```text
 SaltyChart/
 ├── backend/          # Express + TypeScript REST API
 ├── frontend/         # Svelte + Vite single-page app
 ├── prisma/           # Prisma schema (SQLite datasource)
 ├── docker-compose.yml
 └── README.md         # High-level overview & quick-start instructions
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
- API routes mounted under `/api/*`:
  - `/api/health`          (health check)
  - `/api/anime`           (AniList GraphQL proxy + cache)
  - `/api/auth`            (login, signup, JWT issuance)
  - `/api/list`            (user watchlist CRUD)
  - `/api/public-list`     (public watchlist read-only)
  - `/api/users`           (user management)
  - `/api/options`         (per-user UI preferences)

  Recent additions inside existing routers:
  - `PATCH /api/list/watched`   (toggle watched / unwatched and record timestamp)
  - `PATCH /api/list/rank`      (update per-season *watchedRank* ordering)
  - `PATCH /api/list/hidden`    (toggle *hidden* flag – excludes an entry from the Randomize wheel)
  - `GET   /api/list/users-with-nicknames` (list users that have at least one custom nickname)
  - `GET   /api/list/nicknames?mediaId=`   (nicknames & ranks for a given series)
  - `PUT   /api/list`           (replace entire list for a season/year in one shot)

  Translation routes (`/api/translate`):
  - `GET /api/translate/check?videoId=&mediaId=`  (checks English subs + subtitle dismiss state; cached)
  - `GET /api/translate/stream?videoId=&mediaId=` (SSE subtitle stream; serves from cache on repeat plays)
  - `PATCH /api/translate/dismiss?videoId=`        (persist subtitle on/off preference; no auth, all users)
  - `POST /api/translate/upload`                    (upload pre-translated subtitles; admin only, respects model rank)
  - `DELETE /api/translate/cache?videoId=`          (delete a cached translation; admin only)
  - `POST /api/translate/batch`                    (trigger batch pre-translation; admin only, JWT required)
  - `GET /api/translate/batch/status`              (batch job progress/logs; admin only)

  Both check and stream endpoints query `SubtitleCache` first.  On a cache hit, `/stream`
  sends a `{cached: true}` SSE event followed by all segments instantly (~50ms).  On a miss,
  the daemon translates and saves to cache on completion.  Concurrent requests for the same
  uncached video are deduplicated — the second waits for the first to finish.

  The `/check` endpoint returns `{hasEnglish, subtitlesDisabled, hasCachedSegments, modelName}`.
  If `hasEnglish` or `subtitlesDisabled` is true the frontend hides translated subtitles by
  default.  The dismiss state is set via the CC toggle button (calls `PATCH /dismiss`) and
  persists for all users.  `hasCachedSegments` and `modelName` are used by the local
  translation script to decide whether to re-translate.

  On-demand translation uses a persistent Python daemon (`backend/scripts/translate_daemon.py`)
  with the `small` Whisper model (int8) for fast live results.  Batch pre-translation
  (`backend/scripts/batch_translate.py`) uses the `medium` model (int8) for higher quality
  and automatically upgrades videos previously translated with `small`.  The batch also
  pre-checks English subtitles and caches `hasEnglishSubs` to avoid a Python spawn on
  first play.

  The backend includes an auto-scheduler (in `index.ts`) that runs the batch script
  automatically between 2-4am when the next anime season is within 30 days.  Runs once
  per day max, with a `--cutoff 10` to stop by 10am.  No external cron setup needed.

  Audio is chunked with a ramp-up strategy (5s, 5s, 10s, 10s, then 20s) starting from
  second 0.  On-demand uses `beam_size=1` + `condition_on_previous_text=False` for speed;
  batch uses `beam_size=5` + `condition_on_previous_text=True` for quality.
  Subtitle timing syncs to YouTube's iframe API `currentTime` and respects play/pause state.

  Python dependencies: `faster-whisper`, `yt-dlp`, `youtube-transcript-api`, and system-level `ffmpeg`.
  Both `small` and `medium` models are pre-downloaded in the Docker image.

  Local GPU translation: `tools/local_translate.py` runs on your PC with GPU support
  (`large-v3` + `float16` on CUDA) and uploads results via `POST /api/translate/upload`.
  Supports `--video` for single videos, `--no-upload` for local-only testing, `--dry-run`,
  `--season`/`--year`, and `-u`/`-p` for login.  `tools/translate.bat` is a Windows wrapper.
- Database schema is auto-created/updated at startup via raw SQL in `ensureDatabaseSchema()`.
  • New tables/columns since last revision
    - `Settings` (per-user record storing theme, title language, autoplay, hide-from-compare and JSON column `nicknameUserSel`).
    - `WatchList.watchedRank` (integer; 0-based rank assigned after a show is watched and ranked in the Randomize page).
    - `WatchList.hidden` (boolean; when true the show is skipped by the Randomize wheel).
    - `SubtitleCache` (videoId unique, mediaId, modelName, hasEnglishSubs, subtitlesDisabled,
      segments JSON, createdAt).  Caches check results, translated segments, and user subtitle
      preferences per YouTube video.

  The bootstrap logic will automatically create the `Settings` table, add the
  `nicknameUserSel` column if missing, and back-fill default rows for existing
  users.  Make sure to keep `schema.prisma` and the raw SQL in sync when adding
  further preference columns.

 ## Frontend Service
 Path: `frontend/`
 - Tech: Svelte 4, Vite, TypeScript, TailwindCSS (DaisyUI)
 - Entry: `src/main.ts` → `App.svelte` (client-side router)
 - Dev: `npm install && npm run dev` (Vite dev server on port 5173)
 - Build: `npm run build` (produces static assets)
 - Preview: `npm run preview`
- Pages (lazy-loaded in `App.svelte`): Home, Login, SignUp, Randomize, Compare
- The main anime grid (`AnimeGridTranslate.svelte`) includes real-time Japanese subtitle
  translation for trailers via the `/api/translate` endpoints.  Subtitles sync to the
  YouTube iframe API's `currentTime`, support play/pause/scrub, and the spinner is
  deferred until the English-subtitle check completes to avoid UI flash.
- State: simple Svelte stores in `src/stores/` (e.g. `authToken`, `userName`)

 Additional UI features added after 2025-06-04:
 • Global *Options* modal (gear icon in header).  Persists settings in the
   `options` store and syncs with `/api/options` when authenticated, or
   `localStorage` for guests.
   ‑ Theme: `LIGHT`, `NIGHT`, `SYSTEM`, `HIGH_CONTRAST`
   ‑ Title language: English / Romaji / Native
   ‑ Video autoplay toggle
   ‑ Hide-from-Compare toggle (excludes a user’s list from public comparisons)
   ‑ Nickname user picker (choose which users’ custom nicknames show up in pop-ups)

 • Season toolbar (`SeasonSelect.svelte`)
   ‑ Search box (client-side fuzzy filter)
   ‑ Hide 18+ toggle (adult / pornographic tag)
   ‑ Hide sequels & Hide in “My List” toggles

 • Main Anime grid refinements
   ‑ Series already in *My List* are no longer 50 % opaque; instead they get a
     subtle border highlight so images remain readable.
   ‑ Adult shows display a small “18+” badge.

 • Randomize page upgrades
   ‑ Wheel spin now plays a *tick* sound, shows confetti, and displays a spinner
     overlay while the list loads.
   ‑ Supports ranking *post-watch* lists via drag-and-drop; ranks are persisted
     in `WatchList.watchedRank` and exposed in compare/randomize pop-ups.
   ‑ Pop-up now shows other users’ nickname + rank for the selected show
     (queried via the new nickname endpoints) as well as your own.
   ‑ Individual shows can be *hidden* from the wheel via a context-menu (uses the
     new `/api/list/hidden` endpoint and `WatchList.hidden` DB column).

 • Compare page
   ‑ “Share” button copies a deep-link that pre-loads the selected users & season.
   ‑ Can toggle between *pre-watch* order and *post-watch* rank.

 • Misc
   ‑ App auto-detects the current season on first load and shows “X days until
     next season” helper text.
   ‑ The last selected season/year is remembered across navigations.

 ## Prisma
 Path: `prisma/schema.prisma`
 - Defines `User` model
 - Also defines `WatchList` (now with `watchedRank` int column) and `Settings`
   model introduced in July 2025.
 - SQLite datasource via `DATABASE_URL`
 - Run `npx prisma generate` after schema changes and ensure the raw SQL
   migrations in `backend/src/index.ts` are mirrored.

 ## Docker Compose
 Compose file: `docker-compose.yml`
 - `backend` service:
   - Builds `backend/Dockerfile`, mounts `dev.db` volume, exposes 3000
   - Health-checked before frontend startup
 - `frontend` service:
   - Builds multi-stage `frontend/Dockerfile`, mounts source for hot reload, serves on port 80
 - Usage: `docker compose up --build`

 ## Common Workflows
 - Local development:
   ```bash
   cd backend && npm install && npm run dev
   cd frontend && npm install && npm run dev
   ```
 - Full stack via Docker Compose:
   ```bash
   docker compose up --build
   ```
 - Backend codegen (Prisma): `npm run generate`
 - Run production build:
   ```bash
   cd backend && npm run build
   cd frontend && npm run build
   ```

 ## Agent Guidelines
 - Always load environment variables (`dotenv.config()`) before importing the Prisma client.
- When modifying the DB schema, update both `schema.prisma` and raw SQL logic in
  `backend/src/index.ts` (or add Prisma migrations).
   (This is especially important for the `Settings` table, which is created and
   patched via raw SQL, and for new preference columns that the frontend
   expects.)
 - Frontend routing is file-based in `src/pages`; lazy-loading requires updating
   the switch in `App.svelte`.
 - Cache season data in `SeasonCache` table (SQLite) and in-memory LRU (`routes/anime.ts`).
 - Respect rate limits for AniList API (handled via retry/backoff logic).

 ## Troubleshooting
 - If the DB schema is out of sync, inspect console logs from `ensureDatabaseSchema()`.
 - For 429 errors from AniList, check retry headers and backoff code in `anime.ts`.
 - For CORS or proxy issues, verify `vite.config.js` proxy settings (frontend).

 ## References
 - Root README.md: high-level overview & quick start
 - `backend/src` for API logic
 - `frontend/src` for UI components and routing
 - `prisma/` for schema definition
