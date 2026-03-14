FROM oven/bun:1 AS base

# Pin versions for reproducible builds
ARG DOCKER_CLI_VERSION=24.0.9
ARG DOCKER_COMPOSE_VERSION=2.32.4

# Install Docker CLI (static binary — no daemon) and Docker Compose v2 plugin
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

EXPOSE 9090

RUN mkdir -p /opt/homelab-manager/stacks

CMD ["bun", "src/index.ts"]
