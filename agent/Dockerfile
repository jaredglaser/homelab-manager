FROM oven/bun:1 AS base

# Pin versions for reproducible builds
ARG DOCKER_CLI_VERSION=24.0.9
ARG DOCKER_COMPOSE_VERSION=2.32.4

# Install Docker CLI (static binary — no daemon) and Docker Compose v2 plugin
SHELL ["/bin/bash", "-o", "pipefail", "-c"]
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    # Docker CLI static binary
    curl -fsSL "https://download.docker.com/linux/static/stable/$(uname -m)/docker-${DOCKER_CLI_VERSION}.tgz" | \
    tar xz --strip-components=1 -C /usr/local/bin docker/docker && \
    # Docker Compose v2 plugin
    mkdir -p /usr/local/lib/docker/cli-plugins && \
    curl -fsSL "https://github.com/docker/compose/releases/download/v${DOCKER_COMPOSE_VERSION}/docker-compose-linux-$(uname -m)" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose && \
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose && \
    # Cleanup
    apt-get purge -y curl && \
    apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

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
