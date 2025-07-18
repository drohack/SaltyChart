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
  - `GET   /api/list/users-with-nicknames` (list users that have at least one custom nickname)
  - `GET   /api/list/nicknames?mediaId=`   (nicknames & ranks for a given series)
- Database schema is auto-created/updated at startup via raw SQL in `ensureDatabaseSchema()`.
  • New tables/columns since last revision
    - `Settings` (per-user record storing theme, title language, autoplay, hide-from-compare and JSON column `nicknameUserSel`).
    - `WatchList.watchedRank` (integer; 0-based rank assigned after a show is watched and ranked in the Randomize page).

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
- State: simple Svelte stores in `src/stores/` (e.g. `authToken`, `userName`)

 Additional UI features added after 2025-06-04:
 • Global *Options* modal (gear icon in header).  Persists settings in the
   `options` store and syncs with `/api/options` when authenticated, or
   `localStorage` for guests.
   ‑ Theme: `LIGHT`, `NIGHT`, `SYSTEM`, `HIGH_CONTRAST`
   ‑ Title language: English / Romaji / Native
   ‑ Video autoplay toggle
   ‑ Hide-from-Compare toggle (excludes a user’s list from public comparisons)

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
