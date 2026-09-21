################  Backend - multi-stage build ################

# 1) builder  - installs dev deps, generates Prisma client, compiles TS
# 2) runtime  - pinned base image (Dockerfile.base: python/ffmpeg/Whisper
#               models) + production node_modules copied from builder

# ---------- builder ---------------------------------------------------------
FROM node:20-slim AS builder
WORKDIR /app

# Install OpenSSL to satisfy Prisma client generation requirements
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl libssl-dev \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci                        # includes devDependencies (tsc, prisma)

# Copy source and build
COPY . .
RUN npm run generate && npm run build

# Remove dev dependencies to slim down node_modules we copy later
RUN npm prune --production

# ---------- runtime ---------------------------------------------------------
# The base image (see Dockerfile.base) carries the heavy, slow-changing
# layers: apt packages (python3, ffmpeg, curl, openssl), pip translation
# deps, and the pre-downloaded Whisper models. It is pinned by tag so those
# ~3.3 GB of layers keep identical digests across deploys - the server only
# ever pulls the app layers below. Bump the tag only after dispatching the
# `build-base` workflow with the matching version.
FROM ghcr.io/drohack/saltychart-backend-base:v1 AS runtime
WORKDIR /app

# Always provide DATABASE_URL so Prisma connects even when not passed via
# docker run or compose.
# The Prisma SQLite connection string must use the `file:` URL scheme. Using an
# *absolute* path (e.g. `file:/app/prisma/data.db`) triggers the Rust `url`
# parser inside Prisma to reject the string with "Error parsing connection
# string". Switching to a *relative* path solves the issue while still pointing
# at the same location at runtime (`/app/prisma/data.db`).

ENV NODE_ENV=production \
    DATABASE_URL=file:./prisma/data.db

# copy pruned production deps and compiled JS
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts

# Refresh yt-dlp on every deploy.
#
# The base image pins whatever yt-dlp was current when IT was built, and the
# base is only ever rebuilt by manual dispatch - so that copy silently ages.
# YouTube periodically changes what its media servers will serve, and an aged
# yt-dlp keeps asking the old way: extraction still succeeds, then the download
# 403s. (Measured 2026-09-20: the March build asked for the whole file in one
# request, which YouTube now refuses; the August build fetches it in chunks.)
# That is exactly how trailer subtitles broke site-wide while every test stayed
# green - cached videos kept working, so it looked selective.
#
# This line sits AFTER the COPYs on purpose: those layers change on every code
# deploy, so Docker cannot serve this one from cache. Put it above them and it
# would be cached forever - reintroducing the bug it exists to prevent.
# Caveat: a rebuild of the SAME commit has no changed layer above this one and
# does hit the cache; the daily updater in lib/ytdlpUpdate.ts covers that gap.
RUN python3 -m pip install --no-cache-dir --break-system-packages --upgrade yt-dlp

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "dist/index.js"]
