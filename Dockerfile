# ---------- Builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json ./
COPY package-lock.json* ./
# Install all dependencies with install scripts enabled.  SvelteKit's CLI relies on
# its postinstall script; skipping scripts would remove the `build`, `dev`, and
# `preview` commands.
RUN npm ci

# Copy sources & build
COPY . ./
RUN npm run build

# ---------- Runner ----------
FROM node:20-alpine

WORKDIR /app

ENV NODE_ENV=production

# Install only production deps
COPY package.json ./
COPY package-lock.json* ./
# Production install in the runtime image.  Scripts can remain disabled because the
# built output has already been generated in the builder stage.
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/build ./build

EXPOSE 3000

CMD ["node", "build/index.js"]
