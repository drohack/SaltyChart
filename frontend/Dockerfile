# ---------- frontend Dockerfile ----------
FROM node:18-alpine AS deps

WORKDIR /app
COPY package.json ./
RUN npm install

FROM deps AS builder
COPY . .
RUN npm run build

# --- Runtime image --------------------------------------------------------
FROM nginx:alpine

# Copy custom Nginx config with SPA fallback and /api proxy
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static assets
COPY --from=builder /app/dist /usr/share/nginx/html
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
