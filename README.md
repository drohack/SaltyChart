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

```bash
# 1  Build & start both services (hot-reload enabled)
docker compose up --build

# 2  Browse the app
open http://localhost:5173
```

---

## Recent Feature Highlights (July 2025)

SaltyChart is under active development.  The list below summarises key
additions made after the first publication of this document so new
contributors are not caught off-guard:

• **Hide from Wheel** – right-click a show in *My List* ➜ **Hide from Randomize**.
  Persists the new `WatchList.hidden` boolean and is toggled via
  `PATCH /api/list/hidden`.

• **Bulk list replace** – `PUT /api/list` can now replace an entire season’s
  list in one request.  This powers the upcoming CSV importer and also allows
  third-party integrations.

• **Nickname sharing** – pop-ups on Randomize/Compare now show friends’ custom
  nicknames + ranks.  New helper endpoints:
  `GET /api/list/users-with-nicknames` and `GET /api/list/nicknames?mediaId=`.

• **Nickname user filter** – the global *Options* modal gained a **Nickname
  User Picker** so you decide whose nicknames are displayed.

• **Real-time subtitle translation** – click a Japanese trailer and get live
  English subtitles streamed via SSE.  Translations are cached in the database
  so repeat plays are instant (~50ms).  A persistent Python daemon keeps the
  Whisper model in RAM, and concurrent requests for the same video are
  deduplicated.  Subtitles sync to YouTube's playback position, supporting
  pause and scrub.  (`/api/translate/stream`, powered by `faster-whisper` +
  `yt-dlp`).

These features are fully documented in `AGENTS.md`; remember to update that
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
   scp saltychart_20250718.tar \
       <user>@<unraid-ip>:/mnt/user/SHARE/user/drohackfiles/
   ```

2. **Load the images** (inside an SSH session on the server)

   ```bash
   cd /mnt/user/SHARE/user/drohackfiles
   docker load -i saltychart_20250718.tar
   ```

   Docker will spit out something like:

   ```text
   Loaded image: saltychart-backend:20250718
   Loaded image: saltychart-frontend:20250718
   ```

3. **Update Compose to reference today’s tags**

   ```bash
   vi /mnt/user/appdata/saltychart/docker-compose.yml
   # change the image lines
   #   backend:  image: saltychart-backend:20250718
   #   frontend: image: saltychart-frontend:20250718
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
