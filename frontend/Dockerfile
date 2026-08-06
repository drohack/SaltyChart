# -----------------------------------------------------------------------------
#  Front-end - Vite + Svelte build           (multi-stage)
#
# 1. deps     : install JS deps with npm ci (cached by lock-file)
# 2. builder  : run `vite build`
# 3. runtime  : Nginx serving static assets
# -----------------------------------------------------------------------------

# ---------- deps layer -------------------------------------------------------
FROM node:20-slim AS deps
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

# ---------- build layer ------------------------------------------------------
FROM deps AS builder
# Deploy version (YYYYMMDD-<sha> image tag) shown in the header's ? tooltip;
# passed by CI (deploy.yml), stays 'dev' for local builds.
ARG APP_VERSION=dev
ENV VITE_APP_VERSION=$APP_VERSION
COPY . ./
RUN npm run build

# ---------- runtime layer ----------------------------------------------------
FROM nginx:alpine

# Custom Nginx config (includes SPA fallback & /api proxy in dev)
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Copy compiled assets
COPY --from=builder /app/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
