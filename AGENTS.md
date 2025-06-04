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
 - Database schema is auto-created/updated at startup via raw SQL in `ensureDatabaseSchema()`.

 ## Frontend Service
 Path: `frontend/`
 - Tech: Svelte 4, Vite, TypeScript, TailwindCSS (DaisyUI)
 - Entry: `src/main.ts` → `App.svelte` (client-side router)
 - Dev: `npm install && npm run dev` (Vite dev server on port 5173)
 - Build: `npm run build` (produces static assets)
 - Preview: `npm run preview`
 - Pages (lazy-loaded in `App.svelte`): Home, Login, SignUp, Randomize, Compare
 - State: simple Svelte stores in `src/stores/` (e.g. `authToken`, `userName`)

 ## Prisma
 Path: `prisma/schema.prisma`
 - Defines `User` model
 - SQLite datasource via `DATABASE_URL`
 - Run `npx prisma generate` after schema changes

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