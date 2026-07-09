# SaltyChart automated deployment — design spec

Date: 2026-07-09
Status: approved (brainstormed + user-approved in session)

## Problem

Deploys are fully manual: build two Docker images locally, `docker save` a
3.4 GB tar, scp to the Unraid share, SSH in, `docker load`, hand-edit image
tags in `/mnt/user/appdata/saltychart/docker-compose.yml`, Compose Down/Up in
the Unraid GUI. Error-prone, slow, and every deploy moves the ~3 GB of baked
Whisper models even when only app code changed.

Goals:
- Push to `master` → deployed, hands-off.
- Never transfer the AI-model layers on a routine deploy.
- Zero risk to existing data (SQLite DB in the `saltychart_db` volume).

## Architecture

```text
dev PC ──git push──▶ GitHub master
                        │ (Actions: deploy.yml)
                        ▼
              gate: tsc --noEmit + vite build
                        │
                        ▼
              buildx build backend + frontend
              (backend FROM pinned base image)
                        │ push :latest + :YYYYMMDD-sha
                        ▼
                   ghcr.io/drohack/*
                        ▲                     ┌────────────────────────┐
                        │ pull (only changed  │ Unraid User Script cron │
                        │ app layers, ~100MB) │ */10: compose pull;     │
                        └─────────────────────│ if new → backup DB →    │
                                              │ compose up -d → prune   │
                                              └────────────────────────┘
```

## Components

### Base image (`backend/Dockerfile.base` → `saltychart-backend-base:vN`)

Holds everything heavy and slow-changing: `node:20-slim` + apt
(curl/openssl/python3/ffmpeg) + pip (faster-whisper, yt-dlp,
youtube-transcript-api) + pre-downloaded Whisper `small` and `medium` (int8)
models. ~3.3 GB.

Built **only** by the manually-dispatched `build-base.yml` workflow with an
explicit `version` input. The app Dockerfile pins `FROM
ghcr.io/drohack/saltychart-backend-base:v1`, so the heavy layer digests
cannot drift — a routine deploy is guaranteed to transfer only the app
layers (~50–150 MB), independent of CI cache state. Updating yt-dlp or a
model = edit `Dockerfile.base`, dispatch `build-base` with `v2`, bump the
`FROM` line. That one deploy pulls big; then it's stable again.

### App images (built every push by `deploy.yml`)

- `saltychart-backend:latest` + `:YYYYMMDD-<shortsha>` — builder stage
  (npm ci, prisma generate, tsc, prune) unchanged; runtime = pinned base +
  COPY node_modules/dist/prisma/scripts.
- `saltychart-frontend:latest` + `:YYYYMMDD-<shortsha>` — unchanged
  Dockerfile (vite build → nginx:alpine, ~60 MB).

`deploy.yml` runs as a single job: gate → build both (no push) → push all
tags only after both builds succeed, so the `:latest` pair updates
atomically (no frontend-only deploys on a backend build failure).
`paths-ignore` skips builds for `**.md`, `docs/**`, `tools/**`.

### Pull side (Unraid User Script `update_saltychart`, cron `*/10 * * * *`)

Reference copy in repo: `tools/unraid/update_saltychart.sh`.

1. `docker compose pull` in `/mnt/user/appdata/saltychart`.
2. Compare `:latest` image IDs before/after. Unchanged → exit silently.
3. Changed → run the existing `backup_saltychart_db` user script (fresh
   restore point before every swap), `docker compose up -d` (recreates only
   changed containers), `docker image prune -f`, append a timestamped line
   to `update.log`.

### Compose changes

Images become `ghcr.io/drohack/saltychart-{backend,frontend}:latest`.
Everything else — external `saltychart_db` volume, `salty-net` network,
port 8085, `JWT_SECRET` from untracked `.env` — is unchanged. The stale
`./frontend:/app:ro` dev bind mount is removed.

## Data safety

- The DB lives in the external named volume `saltychart_db`; `compose pull`
  / `up -d` replace containers, never volumes.
- Every applied update triggers the existing backup script first.
- Monthly backup + restore user scripts continue unchanged.

## Error handling & failure modes

- Gate or build fails in CI → nothing is pushed; production untouched.
- Backend build fails after frontend succeeded → nothing pushed (atomic
  push step).
- GHCR/network down during cron pull → `compose pull` fails, script exits;
  running containers unaffected; next cron retries.
- Bad deploy reaches prod → rollback: pin compose to the previous
  `:YYYYMMDD-sha` tag, `docker compose up -d`; restore DB from the
  pre-update backup if needed.
- GitHub outage → offline fallback: the old tar/scp/`docker load` procedure
  (kept in README as appendix) still works.

## Testing

- CI gate: backend `tsc --noEmit` (after `prisma generate`), frontend
  `vite build`.
- The full pre-deploy suite (`tools/tests/run_all.py` — Playwright + GPU
  burned-in test) cannot run on hosted runners; it remains the required
  **local** step before pushing to master.

## One-time setup

1. Dispatch `build-base.yml` with `version=v1` after first push.
2. Set the three GHCR packages to **public** (GHCR defaults new packages to
   private; Unraid pulls unauthenticated).
3. On Unraid: snapshot DB, point compose at the ghcr images, first pull
   (full ~3.5 GB, once), `up -d`, verify site + login + data, install the
   `update_saltychart` User Script.

## Out of scope

- Watchtower, LAN registry, moving models to a runtime volume (base-image
  pinning already guarantees small deploys).
- GHCR old-tag pruning (optional later via `actions/delete-package-versions`).
