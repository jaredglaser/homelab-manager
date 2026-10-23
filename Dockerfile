# Dockerfile for homelab-manager
# Multi-stage build: deps (dev), base (worker/cleanup), production (web)

# Must match .bun-version; scripts/__tests__/bun-version.test.ts fails CI on drift.
ARG BUN_VERSION=1.4.2

# Dependencies only - used for dev containers (source mounted via volume)
FROM oven/bun:${BUN_VERSION} AS deps
# Global ARGs do not carry into stages; re-declared for the cache mount id below.
ARG BUN_VERSION
WORKDIR /app
COPY package.json bun.lock ./
# --ignore-scripts skips cpu-features' install script (node-gyp rebuild),
# which would fail because oven/bun ships no node binary. cpu-features is an
# optional transitive dep (dockerode > docker-modem > ssh2); ssh2 uses a JS fallback.
RUN --mount=type=cache,target=/root/.bun/install/cache,id=bun-${BUN_VERSION} \
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

# Tag the Add Host wizard pins new agents to. Declared after apt so a channel switch
# does not invalidate that layer. Vite inlines it at build, so the copy that survives
# into the runtime image does nothing.
ARG VITE_AGENT_IMAGE_TAG=latest
ENV VITE_AGENT_IMAGE_TAG=${VITE_AGENT_IMAGE_TAG}

RUN bun run build

CMD ["bun", ".output/server/index.mjs"]
