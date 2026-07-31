# SaltyChart – Monorepo Overview

This repository contains the _two_ production images that make up the
SaltyChart deployment:

1. **`backend/`** – Express + TypeScript REST API
2. **`frontend/`** – Svelte + Vite **SPA** that consumes the API

Both are built and orchestrated locally with **Docker Compose**.  Each package
is fully independent ‑ it ships its own `package.json`, lock-file and
configuration.  Keeping them isolated avoids the usual confusion that comes
with "mega" root‐level configuration files while still allowing a single
Git repository.

```
.
├── backend         # Express API & Prisma SQLite database
│   ├── Dockerfile
│   ├── package.json
│   └── src/ …
├── frontend        # Svelte + Tailwind single-page app
│   ├── Dockerfile  # multi-stage – dev & prod
│   ├── package.json
│   └── src/ …
├── docker-compose.yml  # `docker compose up --build`
└── README.md       # you are here
```

---

## Quick start (developer machine)

### Docker (production-like)

```bash
docker compose up --build
open http://localhost:8085
```

### Local dev (no Docker, Windows)

```bash
# One-time setup
cp backend/.env.example backend/.env   # provides DATABASE_URL for ts-node-dev
pip install youtube-transcript-api     # enables YouTube English CC detection

# Terminal 1 — backend (port 3000)
cd backend && npm install && npm run dev

# Terminal 2 — frontend (port 5173)
cd frontend && npm install && npm run dev
```

`DATABASE_URL` is required — the server exits with `[FATAL]` on startup without
it. The `.env` file keeps it in place across ts-node-dev hot-reloads. SQLite DB
lives at `backend/prisma/prisma/data.db`.

If port 3000 is already in use: `netstat -ano | grep ':3000'` then `taskkill /PID <pid> /F`.

---

## Feature highlights

SaltyChart is under active development. The list below summarises key
additions so new contributors are not caught off-guard. Group is rough
chronological order; all features listed are live.

**Progressive Home loading**
- The season toolbar and section headers render immediately; each section
  (current season vs. Leftovers) pops in as soon as its own fetch lands, with
  shimmer skeleton cards holding the layout in the meantime — no more
  all-or-nothing spinner on a cold cache.
- Cover images blur-up: a tiny low-res cover shows instantly and the full
  quality image fades in when downloaded.
- The backend now fetches AniList pages in parallel on a cold load, cutting
  multi-page season fetches to a fraction of the previous latency.

**Jellyfin integration (optional)**
- The site admin points SaltyChart at a Jellyfin server on the **/admin**
  page (URL + API key, tested with one click). The key is stored server-side
  and never sent to browsers. Viewers never need a Jellyfin account or login.
- The same page picks a **playback account** — Jellyfin applies its policy per
  account, so streaming needs one. Use a dedicated account (library access, no
  bitrate or rating limit; it needn't be an administrator) rather than a real
  person's: it keeps playback off their profile, and tightening their policy
  later can't quietly degrade playback for everyone. Nothing is written to its
  watch history either way — SaltyChart never reports progress. If left unset,
  an administrator is used.
- On the Randomize page, the show pop-up gains **▶ Watch here** with the
  season and episode it will start on, playing in-page through the backend —
  when the series is found in your library (matched by English *and* Japanese
  titles, season-aware; the matched library title is shown under the button,
  and a "Not in library" note appears otherwise).
- Matches confirmed by an AniList→TVDB id chain are shown plainly; ones found
  only by title similarity are marked **⚠ unconfirmed match**, so a
  same-name-different-show mix-up is visible before you press play.
- The in-page player is **video.js**, so it comes with a proper control bar,
  speed menu, fullscreen and the usual hotkeys. The one thing added on top is
  what the media servers' own players can't do: `]` / `[` step playback speed
  by **±0.10×** (they're locked to 0.25× steps), shown as a VLC-style corner
  flash.
- **Subtitles are drawn into the video by Jellyfin**, using libass and the
  episode's own fonts, so signs, songs and karaoke appear where the release put
  them rather than being flattened to plain text at the bottom of the screen.
  They are part of the picture, so they can't fail to appear on their own, and
  playback no longer has to wait for them. Tracks are chosen from a menu in the
  control bar, defaulting to plain English dialogue rather than an SDH or
  signs-only track.
- **A quality menu** sits next to it: *Auto* (the file's own quality), 1080p,
  720p or 480p — for when the connection can't keep up. Changing either the
  track or the quality restarts the stream where you left off, which takes a
  second or so; that's how every Jellyfin client works, because the choice is
  baked into what the server sends.
- The player loads itself ahead of time: the video code is fetched quietly when
  you open the Randomize page, and a show's playback details when you open its
  pop-up — so pressing **Watch** only has to start the stream. Skipped entirely
  on metered or 2G connections.

**Version badge in header**
- A small `?` at the top-right of the SaltyChart logo shows the deployed
  version (the `YYYYMMDD-<sha>` image tag) in a tooltip on hover — `dev`
  when running outside a CI-built image.

**Compare redesign (card layout, mobile-first)**
- Cards replace the old 4-column grid — one anime per row with cover, title,
  and a `[your rank | diff badge | other rank]` strip.
- Sticky username bar pins to viewport top while cards scroll.
- Unified controls block: season header + 2-column user grid (you + 2nd user)
  with pre/post-watch selectors and combobox in one place.
- Default sort is now your ranking (`rankA`) instead of difference.
- Mobile layout matches desktop aesthetically; desktop shares ~75% of
  Home's grid width (`calc(100vw - 40rem)` at 2cols breakpoint).
- Custom nicknames take visual priority over canonical titles (primary
  weight, up to 2-line clamp).

**Randomize enhancements**
- "Nicknames from" auto-checks users who have rankings for the current
  season/year (via `GET /api/list/users-with-ratings`), re-running whenever
  season or year changes.
- Season row left-aligned to match Home and Compare.

**Hide from Wheel** – right-click a show in *My List* ➜ **Hide from Randomize**.
Persists the `WatchList.hidden` boolean and is toggled via
`PATCH /api/list/hidden`.

**Bulk list replace** – `PUT /api/list` can replace an entire season's list
in one request. Powers the CSV importer and third-party integrations.

**Nickname sharing** – pop-ups on Randomize/Compare show friends' custom
nicknames + ranks. Endpoints:
`GET /api/list/users-with-nicknames`, `GET /api/list/nicknames?mediaId=`,
`GET /api/list/users-with-ratings?season=&year=`, `GET /api/list/user-ratings?username=&season=&year=`.

**Nickname user filter** – the global *Options* modal's **Nickname User Picker**
lets you choose whose nicknames are displayed.

**Real-time subtitle translation** – click a Japanese trailer and get live
English subtitles streamed via SSE. If the video has YouTube English CC
(manual or auto-generated), those are shown instead — they're higher quality.
When no English CC exists, the app suppresses YouTube's Japanese CC and
streams Whisper-translated subtitles. Translations cached in the database so
repeat plays are instant (~50ms). On page load the app batch-checks all
trailers against the cache (`/api/translate/check-batch`) so the CC decision
is instant when the user clicks play. Persistent Python daemon (`small` model,
chunked) handles on-demand requests. Short videos (≤30s) skip chunking. 
Concurrent requests are deduplicated and limited to 2. Subtitles sync to YouTube's playback position (pause, scrub). All transcription
uses `word_timestamps=True` so segment start/end times align to actual word
boundaries rather than Whisper's coarser segment estimates — eliminates the
"subtitle appears before speech" issue. Users can dismiss subtitles via the CC
toggle and the preference persists for all users.

**Pre-translation pipeline** — two-tier system covering the previous, current,
and next seasons on every run:
- **Local GPU** (`tools/local_translate.py`): runs every Sunday at 5am via
  Windows Scheduled Task ("SaltyChart Translate"). No window gate — always runs
  and caches new trailers for all 3 seasons. Uses the **split pipeline**:
  Demucs vocal isolation → `large-v3` Japanese transcription → LLM translation
  (`qwen3.5:9b` via Ollama), tagged `large-v3-split`.
- **Server batch** (`backend/scripts/batch_translate.py`, `medium` int8 CPU):
  runs automatically on Wednesdays 2–4am when within 50 days of a season start.
  Fallback only — skips anything already cached at higher quality. Stops at 10am.

Both scripts detect model rank and never downgrade a higher-quality translation.

**Local GPU translation** (`tools/local_translate.py`) — the highest-quality
tier, benchmarked as the bake-off winner. Pipeline: best-quality audio → Demucs
vocal separation (removes music/SFX so Whisper hallucinates less) → `large-v3`
Japanese transcription → natural English translation by a local LLM
(`qwen3.5:9b` via Ollama, started and stopped automatically). Falls back to
end-to-end Whisper translate if Ollama is unavailable. Automatic burned-in
subtitle detection: OCR frames compared to the translated segments via hybrid
fuzzy + semantic matching (sentence-transformers); burned-in videos are flagged
so the frontend defaults subtitles off.

**Per-user subtitle settings** — font size, family, position, text/bg color,
opacity, text outline. Settings popup via gear icon next to the CC button.
Stored per-user in the Settings table.

**Auth improvements**
- Login page links directly to Sign Up and Password Reset.
- Sign Up page links back to Login.
- Password reset (`POST /api/auth/reset-password`) — username-only, no email
  required. Three-step page: enter username → confirm → set new password.

**Season default look-ahead**
- On first load the app now defaults to the *upcoming* season if it starts
  within 76 days (~2 weeks after the current season's first episode airs),
  so users land on next-season trailers rather than what's already airing.
- Fixed the "X days until next season" countdown which was miscalculating
  season start dates (was using Mar/Jun/Sep/Dec instead of Apr/Jul/Oct/Jan).

**Performance & hardening**
- DB indexes on `WatchList(userId)`, `WatchList(season, year)`,
  `Settings(hideFromCompare)` — created idempotently at startup in
  `ensureDatabaseSchema()`.
- Rate limit (60 req/min per IP) on the four unauthenticated
  `/api/list/*` endpoints (`users-with-nicknames`, `users-with-ratings`,
  `user-ratings`, `nicknames`); global 120 req/min limiter covers the rest;
  20 req/min on `/api/auth`.
- All error responses use a unified shape: `{ error: 'message', code: 'CODE_NAME' }`.
  Codes include `BAD_REQUEST`, `UNAUTHORIZED`, `INVALID_CREDENTIALS`,
  `INVALID_TOKEN`, `USER_NOT_FOUND`, `USER_EXISTS`, `ADMIN_REQUIRED`,
  `BATCH_RUNNING`, `RATE_LIMITED`, `UPSTREAM_ERROR`, `SERVER_ERROR`.
- `dom-to-image-more` is bundled as a lazy chunk (previously a CDN import).

These features are fully documented in `CLAUDE.md`; remember to update that
guide when expanding the API or database schema.

The **frontend** Vite dev-server proxies all `/api/*` requests to the **backend**
container, so no additional environment configuration is required.

---

## Deployment (automatic — push to master)

Deploys are handled by CI + an Unraid pull script. **Pushing to `master` is
deploying**; there is no manual build/transfer step.

1. **Run the pre-deploy suite locally** (CI can't run Playwright/GPU tests):

   ```bash
   # 0. Kill stale ts-node-dev / vite processes from prior sessions
   py -3.13 tools/tests/kill_stale.py

   # 1. Backend + frontend dev servers must be running (npm run dev in each)
   # Backend on :3000, Vite frontend strictly on :5173 (strictPort=true)
   py -3.13 -u tools/tests/run_all.py

   # Expect: "Pre-deploy: 13/13 passed — ready to build"
   # Skip the GPU test with --skip-burned-in if no CUDA
   ```

2. **Push to `master`.** The `deploy` workflow
   (`.github/workflows/deploy.yml`) typechecks the backend, builds the
   frontend, then builds & pushes both images to GHCR:
   `ghcr.io/drohack/saltychart-{backend,frontend}`, tagged `latest` plus an
   immutable `YYYYMMDD-<shortsha>` for rollback. The push is atomic — a
   failed backend build never publishes a frontend-only update.

3. **The server updates itself.** The `update_saltychart` User Script on
   Unraid (cron, every 10 min; reference copy at
   `tools/unraid/update_saltychart.sh`) runs `docker compose pull` and, only
   when a new image arrived, backs up the DB (existing
   `backup_saltychart_db` script), runs `docker compose up -d`, prunes old
   images, and logs to `/mnt/user/appdata/saltychart/update.log`.

A code change is typically live ~15 minutes after the push (CI ~5 min + poll
interval). The SQLite DB is bind-mounted from
`/mnt/user/appdata/saltychart/prisma`, which deploys never touch.

### The base image (why deploys are small)

The backend's heavy layers — python3, ffmpeg, pip deps, and the ~2 GB of
pre-downloaded Whisper models — live in a separate **pinned base image**,
`ghcr.io/drohack/saltychart-backend-base:vN`, built from
`backend/Dockerfile.base`. `backend/Dockerfile` builds `FROM` that pinned
tag, so a routine deploy only transfers ~100 MB of app layers.

To update the base (new yt-dlp, model change, etc.):

1. Edit `backend/Dockerfile.base`.
2. Run the **build-base** workflow (GitHub → Actions → build-base → Run
   workflow) with the next version, e.g. `v2`.
3. Bump the `FROM ...saltychart-backend-base:v2` line in
   `backend/Dockerfile` and push — that one deploy pulls the full base once,
   then deploys are small again.

### Rollback

Every deploy leaves an immutable tag and a fresh DB backup:

```bash
# On the server: pin compose to the previous tag…
vi /mnt/user/appdata/saltychart/docker-compose.yml
#   image: ghcr.io/drohack/saltychart-backend:YYYYMMDD-abc1234  (and frontend)
docker compose up -d
# …and if data must rewind, run the restore_saltychart_db User Script.
```

(Return to `:latest` afterwards or the auto-updater won't pick up new
deploys for the pinned service.)

---

### Offline fallback (manual tar deploy)

If GitHub/GHCR is unavailable, the old manual path still works:

```bash
# Build locally (backend needs the base image present or pullable)
docker build -t saltychart-backend:$(date +%Y%m%d) ./backend
docker build -t saltychart-frontend:$(date +%Y%m%d) ./frontend
docker save -o saltychart_$(date +%Y%m%d).tar \
  saltychart-backend:$(date +%Y%m%d) saltychart-frontend:$(date +%Y%m%d)

# Transfer + load
scp saltychart_YYYYMMDD.tar <user>@<unraid-ip>:/mnt/user/SHARE/user/drohackfiles/
ssh <user>@<unraid-ip> docker load -i /mnt/user/SHARE/user/drohackfiles/saltychart_YYYYMMDD.tar

# Point /mnt/user/appdata/saltychart/docker-compose.yml at the loaded tags,
# then Docker ➜ Compose ➜ Compose Down / Compose Up in the Unraid GUI.
```

---

## Backup and Restore database

On the Unraid server there's some user scripts to backup the database.
Reference copies live in `tools/unraid/` — if you edit them, update the
server's User Scripts to match. The live DB is the bind mount at
`/mnt/user/appdata/saltychart/prisma/data.db` (**not** the legacy
`saltychart_db` docker volume, which went stale in April 2026 and whose
backups silently contained April data until this was caught in July).

Backup - every month, save 3 (also runs before every auto-deploy swap):
   In the Unraid WebUI go to Settings -> User Scripts
   "backup_saltychart_db" snapshots the live DB via the SQLite online-backup
   API (through the backend container) to /mnt/user/backup/saltychart/

Restore - run from a terminal when needed (it prompts for confirmation):
   "restore_saltychart_db" restores the most recent backup into the live
   data dir, stopping/starting the backend around the swap. The replaced DB
   is kept as data.db.pre-restore.
   For a specific backup: `bash ./restore_saltychart_db/script saltychart_db_2026-07-09_22-53-41.tar.gz`
