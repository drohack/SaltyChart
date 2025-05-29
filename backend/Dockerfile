# ---- SaltyChart backend Dockerfile (Debian base) ----

# Use a Debian-based image instead of Alpine so we get glibc and a recent
# OpenSSL version out-of-the-box, avoiding the missing `libssl.so.1.1` problem
# that Prisma's query engine has on musl.

# ---------- 1. Install dependencies & run prisma generate ----------
FROM node:18-slim AS deps

WORKDIR /app

# Install OpenSSL libraries – Prisma engine links to them at runtime.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --production=false

# Generate Prisma client with engines for the current platform (glibc)
COPY prisma ./prisma
RUN npx prisma generate

# ---------- 2. Build the TypeScript project ----------
FROM node:18-slim AS builder

WORKDIR /app

# OpenSSL again (needed if Prisma runs during build scripts)
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ---------- 3. Create the runtime image ----------
FROM node:18-slim

WORKDIR /app

ENV NODE_ENV production

# Runtime dependencies (OpenSSL for Prisma)
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# Copy compiled app and required files
COPY --from=builder /app/dist ./dist
COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma
COPY package.json ./

# Add prisma & other project binaries to PATH for interactive shells
ENV PATH="/app/node_modules/.bin:${PATH}"

EXPOSE 3000

CMD ["node", "dist/index.js"]
