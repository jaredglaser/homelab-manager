# Toolchain stage: provides Docker CLI + Compose via pre-built image (no runtime downloads)
FROM docker:27.5.1-cli AS toolchain

# Application stage
FROM oven/bun:1.3.13 AS base

COPY --from=toolchain /usr/local/bin/docker /usr/local/bin/docker
COPY --from=toolchain /usr/local/libexec/docker/cli-plugins /usr/local/lib/docker/cli-plugins

WORKDIR /app

COPY package.json ./package.json
COPY agent/package.json ./agent/package.json
COPY bun.lock ./bun.lock
# --ignore-scripts skips cpu-features' install script (node-gyp rebuild),
# which would fail because oven/bun ships no node binary. cpu-features is an
# optional transitive dep (dockerode > docker-modem > ssh2); ssh2 uses a JS fallback.
RUN --mount=type=cache,target=/root/.bun/install/cache,id=bun-agent-1.3.13 \
    bun install --frozen-lockfile --production --ignore-scripts

COPY agent/src ./src
COPY agent/tsconfig.json ./tsconfig.json

ENV AGENT_PORT=9090
ENV STACKS_DIR=/opt/homelab-manager/stacks
# DOCKER_HOST must be set at runtime (e.g., tcp://socket-proxy:2375).
# Required by both the agent server and docker compose subprocesses.
# The agent validates this at startup and exits if missing.

EXPOSE 9090

RUN useradd --create-home --shell /bin/sh agent && \
    mkdir -p /opt/homelab-manager/stacks && \
    chown -R agent:agent /opt/homelab-manager/stacks /app

USER agent

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD bun -e "fetch('http://localhost:' + (process.env.AGENT_PORT || 9090) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bun", "src/index.ts"]
