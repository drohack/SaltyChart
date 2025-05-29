# ---------- Builder ----------
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json ./
COPY package-lock.json* ./
RUN npm ci --ignore-scripts

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
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy built files from builder
COPY --from=builder /app/build ./build

EXPOSE 3000

CMD ["node", "build/index.js"]
