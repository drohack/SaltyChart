################  Backend – multi-stage build ################

# 1) builder  – installs dev deps, generates Prisma client, compiles TS
# 2) runtime  – Alpine + production node_modules copied from builder

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
FROM node:20-slim AS runtime
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
     curl openssl libssl-dev \
  && rm -rf /var/lib/apt/lists/*

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

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/api/health || exit 1

CMD ["node", "dist/index.js"]
