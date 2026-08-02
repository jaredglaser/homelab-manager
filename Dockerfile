# Dockerfile for homelab-manager
# Multi-stage build: deps (dev), base (worker/cleanup), production (web)

# Dependencies only - used for dev containers (source mounted via volume)
FROM oven/bun:1.3.14 AS deps
WORKDIR /app
COPY package.json bun.lock ./
# --ignore-scripts skips cpu-features' install script (node-gyp rebuild),
# which would fail because oven/bun ships no node binary. cpu-features is an
# optional transitive dep (dockerode > docker-modem > ssh2); ssh2 uses a JS fallback.
RUN --mount=type=cache,target=/root/.bun/install/cache,id=bun-1.3.14 \
    bun install --frozen-lockfile --ignore-scripts
EXPOSE 3000

# Source stage - includes source code (worker/cleanup in production)
FROM deps AS base
COPY . .

# Production stage - builds the web app for serving
FROM base AS production

ENV NODE_ENV=production

# git is needed at runtime for git-upload-pack and git-receive-pack (Git HTTP smart protocol)
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Tag the Add Host wizard pins new agents to. Baked into the client bundle, so the
# :dev dashboard image enrolls :dev agents; CI sets it per channel. Declared after
# apt so a channel switch does not invalidate that layer. It survives into the
# runtime image, where it means nothing: Vite inlines the value at build, so
# setting it on a running container has no effect.
ARG VITE_AGENT_IMAGE_TAG=latest
ENV VITE_AGENT_IMAGE_TAG=${VITE_AGENT_IMAGE_TAG}

RUN bun run build

CMD ["bun", ".output/server/index.mjs"]
