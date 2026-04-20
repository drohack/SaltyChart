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
# Terminal 1 — backend (port 3000)
cd backend
export DATABASE_URL="file:C:/Users/droha/Workspace/SaltyChart/backend/prisma/prisma/data.db"
npx ts-node-dev --respawn --transpile-only src/index.ts

# Terminal 2 — frontend (port 5173)
cd frontend
npm run dev
```

The `DATABASE_URL` is required — without it Prisma defaults to `/app/prisma/data.db`
(Docker path) which doesn't exist locally. The SQLite DB lives at
`backend/prisma/prisma/data.db`.

If port 3000 is already in use: `netstat -ano | grep ':3000'` then `taskkill /PID <pid> /F`.

---

## Feature highlights

SaltyChart is under active development. The list below summarises key
additions so new contributors are not caught off-guard. Group is rough
chronological order; all features listed are live.

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
English subtitles streamed via SSE. Translations cached in the database so
repeat plays are instant (~50ms). Persistent Python daemon (`small` model,
chunked) handles on-demand requests; batch script (`medium` model, full-audio)
pre-translates an entire season's trailers overnight as a safety net. Short
videos (≤30s) skip chunking for the small model too. Concurrent requests are
deduplicated and limited to 2. Subtitles sync to YouTube's playback position
(pause, scrub). Users can dismiss subtitles via the CC toggle and the
preference persists for all users.

**Local GPU translation** (`tools/local_translate.py`) — translates trailers
using Whisper large-v3 on your GPU for highest quality. Medium and large
models use full-audio transcription (no chunking). Automatic burned-in
subtitle detection: OCR frames compared to Whisper translations via hybrid
fuzzy + semantic matching (sentence-transformers). Burned-in videos flagged
so the frontend defaults subtitles off.

**Per-user subtitle settings** — font size, family, position, text/bg color,
opacity, text outline. Settings popup via gear icon next to the CC button.
Stored per-user in the Settings table.

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

## Production build

Each sub-directory ships a **multi-stage Dockerfile** that produces a minimal
runtime image.

```bash
# Back-end – Express (listens on 3000 inside)
docker build -t saltychart-backend:$(date +%Y%m%d) ./backend

# Front-end – Static assets served by Nginx (listens on 80 inside)
docker build -t saltychart-frontend:$(date +%Y%m%d) ./frontend

# Optional: bundle into a single archive for off-line transfer
docker save -o saltychart_$(date +%Y%m%d).tar \
  saltychart-backend:$(date +%Y%m%d)            \
  saltychart-frontend:$(date +%Y%m%d)
```

> The image tags use the build date, but a Git commit SHA works just as well.

---

### Deploying the bundle to Unraid

The resulting **`.tar`** archive contains both the backend and frontend images
and can be moved to the server completely off-line.  The high-level flow is:

1. Copy the archive to a shared folder on the Unraid box
2. Load the images into Docker
3. Point `docker-compose.yml` at the new tags
4. Bounce the compose stack from the GUI

Detailed walkthrough:

1. **Transfer the file** (from your workstation)

   ```bash
   scp saltychart_YYYYMMDD.tar \
       <user>@<unraid-ip>:/mnt/user/SHARE/user/drohackfiles/
   ```

2. **Load the images** (inside an SSH session on the server)

   ```bash
   cd /mnt/user/SHARE/user/drohackfiles
   docker load -i saltychart_YYYYMMDD.tar
   ```

   Docker will spit out something like:

   ```text
   Loaded image: saltychart-backend:YYYYMMDD
   Loaded image: saltychart-frontend:YYYYMMDD
   ```

3. **Update Compose to reference today’s tags**

   ```bash
   vi /mnt/user/appdata/saltychart/docker-compose.yml
   # change the image lines
   #   backend:  image: saltychart-backend:YYYYMMDD
   #   frontend: image: saltychart-frontend:YYYYMMDD
   :wq
   ```

4. **Redeploy from the Unraid GUI**

   • Navigate to **Docker ➜ Compose** in the Unraid web UI.  
   • Select the *saltychart* project, click **Compose Down**, wait a moment, then **Compose Up**.

That’s it—the stack will come back online using the freshly imported images.

---

## House-keeping

Old development artefacts from an **earlier SvelteKit prototype** were removed
(`src/`, `build/`, root-level `Dockerfile`, etc.).  All user-facing
functionality lives exclusively in the two folders listed above which should
make day-to-day navigation and onboarding much simpler.

Happy charting 🚀


## Backup and Restore database

On the Unraid server there's some user scripts to backup the database.

Backup - every month, save 3:
   In the Unraid WebUI go to Settings -> User Scripts
   "backup_saltychart_db" script runs monthly to backup the database to /mnt/user/backup/

Restore - run when needed:
   "restore_saltychart_db" When ran restores the most recent backup
   Can be run manually for a specific backup: `./restore_saltychart_db/script saltychart_db_2025-07-28_02-00-00.tar.gz`
