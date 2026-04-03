# Toolchain stage — downloads Docker CLI + Compose (cached independently)
FROM oven/bun:1 AS toolchain

# Pin versions for reproducible builds
ARG DOCKER_CLI_VERSION=27.5.1
ARG DOCKER_COMPOSE_VERSION=2.32.4

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    # Docker CLI static binary
    # TODO: download.docker.com does not publish checksums for static binaries.
    # Consider pinning by content-hash when upstream signatures become available.
    curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-${DOCKER_CLI_VERSION}.tgz" | \
    tar xz --strip-components=1 -C /usr/local/bin docker/docker && \
    docker --version && \
    # Docker Compose v2 plugin (with SHA-256 integrity verification)
    mkdir -p /usr/local/lib/docker/cli-plugins && \
    COMPOSE_ARCH="$(uname -m)" && \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-${COMPOSE_ARCH}.sha256" \
    -o /tmp/docker-compose.sha256 && \
    sed -i "s|docker-compose-linux-${COMPOSE_ARCH}|/usr/local/lib/docker/cli-plugins/docker-compose|" /tmp/docker-compose.sha256 && \
    grep -q '/usr/local/lib/docker/cli-plugins/docker-compose$' /tmp/docker-compose.sha256 || \
      { echo "ERROR: sha256 file rewrite failed — expected absolute path in checksum file"; exit 1; } && \
    sha256sum -c /tmp/docker-compose.sha256 && \
    rm /tmp/docker-compose.sha256 && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose && \
    # Cleanup
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

# Application stage
FROM oven/bun:1 AS base

COPY --from=toolchain /usr/local/bin/docker /usr/local/bin/docker
COPY --from=toolchain /usr/local/lib/docker /usr/local/lib/docker

WORKDIR /app

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json package.json ./

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
