# Dockerfile for homelab-manager
# Multi-stage build: deps (dev), base (worker/cleanup), production (web)

# Dependencies only — used for dev containers (source mounted via volume)
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
EXPOSE 3000

# Source stage — includes source code (worker/cleanup in production)
FROM deps AS base
COPY . .

# Production stage — builds the web app for serving
FROM base AS production

ENV NODE_ENV=production

RUN bun run build

CMD ["bun", ".output/server/index.mjs"]
