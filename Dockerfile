# Dockerfile for homelab-manager
# Multi-stage build: base (worker/cleanup/dev) and production (web)

# Base stage - shared dependencies and source
FROM oven/bun:1 AS base

WORKDIR /app

# Copy dependency files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code
COPY . .

EXPOSE 3000

# Production stage - builds the web app for serving
FROM base AS production

ENV NODE_ENV=production

RUN bun run build

CMD ["bun", ".output/server/index.mjs"]
