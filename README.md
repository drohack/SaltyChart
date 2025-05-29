# SaltyChart

SaltyChart is a season-based anime calendar inspired by [AniChart](https://anichart.net/).  
It shows every TV anime airing in a given season (Winter, Spring, Summer, Fall) together with

* Title & cover image
* Sequel tag (if the show continues another entry)
* Short description
* Embedded YouTube trailer

The data is fetched on-demand from the public [AniList GraphQL API](https://docs.anilist.co/).

---

## Project layout

```
SaltyChart/
├── backend/          # Node.js(Express) API – TypeScript
│   ├── src/
│   │   ├── index.ts  # app entry, registers routes
│   │   ├── routes/
│   │   │   ├── anime.ts   # /api/anime
│   │   │   └── auth.ts    # /api/register • /api/login
│   ├── package.json
│   ├── tsconfig.json
│   └── Dockerfile
├── frontend/         # SvelteKit SPA – TypeScript + Tailwind (daisyUI)
│   ├── src/
│   ├── svelte.config.js
│   ├── vite.config.ts
│   ├── package.json
│   └── Dockerfile
├── docker-compose.yml # dev & production orchestration
└── README.md          # this file
```

### Why two containers?

* **frontend** – purely static web bundle + SSR capabilities.
* **backend** – hides your AniList token (if ever needed) and stores future per-user data.

---

## Quick start (development)

```bash
# 1) Start both services with hot reload:
docker compose up --build

# 2) Visit the web UI
open http://localhost:5173  # Vite dev server
# Backend should be on http://localhost:3000
```

The first run installs all dependencies, so it may take a minute.

---

## Production build

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up --build -d
```

---

## Authentication note

AniList **does** offer OAuth – you can let users sign-in with their existing AniList
accounts.  For the moment the backend contains a minimal username/password
implementation with hashed credentials stored in SQLite (via Prisma).

Replacing it with the official AniList OAuth flow later will be straightforward – we would
only need to swap the `auth.ts` route handlers.

---

Happy hacking!  
*Created with the help of OpenAI codex*
