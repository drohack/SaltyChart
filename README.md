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

## House-keeping

Old development artefacts from an **earlier SvelteKit prototype** were removed
(`src/`, `build/`, root-level `Dockerfile`, etc.).  All user-facing
functionality lives exclusively in the two folders listed above which should
make day-to-day navigation and onboarding much simpler.

Happy charting 🚀
