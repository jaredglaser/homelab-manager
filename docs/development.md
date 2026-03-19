# Development Guide

## Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) v2+
- *(Optional)* A host running ZFS with SSH access for pool monitoring
- *(Optional)* A Proxmox VE cluster with an API token for monitoring

## Quick Start (Monitoring Only)

If you just want to run the dashboard with Docker monitoring:

```bash
bun install
cp .env.example .env
```

Edit `.env` with minimal settings:

```env
POSTGRES_DB="homelab"
POSTGRES_USER="homelab"
POSTGRES_PASSWORD="changeme"
POSTGRES_PORT="5432"

WORKER_ENABLED="true"
WORKER_DOCKER_ENABLED="true"

# Point at your Docker socket proxy (see "Socket Proxy Setup" below)
DOCKER_HOST_1="host.docker.internal"
DOCKER_HOST_PORT_1="2375"
DOCKER_HOST_NAME_1="dev-machine"
```

Then start:

```bash
# Terminal 1: Start postgres + worker in Docker
bun run dev:local:up

# Terminal 2: Run web app locally with HMR
bun dev
```

Open http://localhost:3000. You should see the Docker monitoring page with container stats.

---

## Full Feature Development

To test all features (Docker stack management, secrets, agent provisioning), you need:

1. A Docker socket proxy on your dev machine
2. Sample containers to monitor
3. OpenBao for secrets management
4. The management feature flag enabled

### Step 1: Set Up the Docker Socket Proxy

The dashboard connects to Docker hosts through a [socket proxy](https://github.com/linuxserver/docker-socket-proxy) — never directly to the Docker socket. You need one running on your dev machine.

Create a file called `docker-compose.socket-proxy.yml` somewhere outside this repo (e.g., `~/docker/socket-proxy/`):

```yaml
services:
  socket-proxy:
    image: lscr.io/linuxserver/socket-proxy:latest
    container_name: socket-proxy
    ports:
      - "127.0.0.1:2375:2375"
    environment:
      - ALLOW_START=1
      - ALLOW_STOP=1
      - ALLOW_RESTARTS=1
      - CONTAINERS=1
      - EVENTS=1
      - IMAGES=1
      - INFO=1
      - NETWORKS=1
      - PING=1
      - POST=1
      - VERSION=1
      - VOLUMES=1
      - TZ=America/New_York
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    restart: unless-stopped
    read_only: true
    tmpfs:
      - /run
```

Start it:

```bash
docker compose -f docker-compose.socket-proxy.yml up -d
```

Verify it works:

```bash
curl http://127.0.0.1:2375/version
```

You should see a JSON response with Docker version info. This proxy will stay running across reboots (`restart: unless-stopped`).

> **Note:** The proxy binds to `127.0.0.1:2375` — only accessible from your local machine. Never bind to `0.0.0.0`.

### Step 2: Start Some Sample Containers

You need a few containers running so the dashboard has data to display. Create a `docker-compose.sample.yml` alongside the socket proxy:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    container_name: sample-caddy
    ports:
      - "8080:80"
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    container_name: sample-redis
    restart: unless-stopped

  whoami:
    image: traefik/whoami
    container_name: sample-whoami
    ports:
      - "8081:80"
    restart: unless-stopped
```

```bash
docker compose -f docker-compose.sample.yml up -d
```

These are small Alpine-based images that use minimal resources.

### Step 3: Configure Your `.env`

Copy `.env.example` and fill in these values:

```env
# PostgreSQL
POSTGRES_DB="homelab"
POSTGRES_USER="homelab"
POSTGRES_PASSWORD="changeme"
POSTGRES_PORT="5432"
POSTGRES_POOL_SIZE="10"

# Worker — enable Docker collection
WORKER_ENABLED="true"
WORKER_DOCKER_ENABLED="true"
WORKER_COLLECTION_INTERVAL_MS="1000"

# Docker host — point at your socket proxy
# Use "host.docker.internal" so the worker container can reach
# the socket proxy running on your host machine
DOCKER_HOST_1="host.docker.internal"
DOCKER_HOST_PORT_1="2375"
DOCKER_HOST_NAME_1="dev-machine"

# Web server
WEB_PORT="3000"

# --- Docker Management (full feature set) ---
DOCKER_MANAGEMENT_FEATURE_FLAG="true"

# OpenBao — the dev server uses a fixed root token
OPENBAO_URL="http://openbao:8200"
OPENBAO_TOKEN="dev-root-token"

# Compose profiles — tells Docker Compose to start OpenBao
COMPOSE_PROFILES="management"
```

> **`host.docker.internal`** is a special DNS name that Docker Desktop and Docker Engine (with the `extra_hosts` config in our compose files) resolve to your host machine's IP. This lets the worker container reach the socket proxy running on port 2375 of your host.

### Step 4: Start the Dev Stack

```bash
bun install

# Terminal 1: Start postgres + worker + OpenBao + socket-proxy + agent
docker compose -f docker-compose.local.yml -f docker-compose.agent.yml up -d --build

# Terminal 2: Run web app locally
bun dev
```

This starts:
- **PostgreSQL** — database
- **Worker** — background stats collector, reads agent tokens from OpenBao
- **OpenBao** — secrets manager (dev server with `dev-root-token`)
- **Socket proxy** — safe Docker API access for the agent
- **Agent** — sidecar that streams container stats and handles deploys

### Step 5: Verify Everything Works

1. Open http://localhost:3000
2. The **Docker** page should show your sample containers (caddy, redis, whoami) with live CPU/memory stats
3. The **Docker > Stacks** link should appear in the sidebar (feature flag is on)
4. OpenBao should be accessible at http://localhost:8200 (token: `dev-root-token`)

Check the worker logs if stats aren't flowing:

```bash
docker compose -f docker-compose.local.yml -f docker-compose.agent.yml logs -f worker
```

### Stopping

```bash
# Stop the dev stack
docker compose -f docker-compose.local.yml -f docker-compose.agent.yml down

# Stop sample containers (optional, they're independent)
docker compose -f ~/docker/socket-proxy/docker-compose.sample.yml down
```

To wipe all data and start fresh:

```bash
docker compose -f docker-compose.local.yml -f docker-compose.agent.yml down -v
```

---

## Running Locally (Options)

### Option 1: Local Dev with Docker Services (Recommended)

Run the web server locally with HMR, while Docker handles the database and worker:

```bash
bun install

# Terminal 1: Start Docker services (postgres + worker)
bun run dev:local:up

# Terminal 2: Run web app locally
bun dev

# Management
bun run dev:local:down         # Stop Docker services
bun run dev:local:restart      # Restart Docker services
bun run dev:local:rebuild      # Rebuild and restart Docker services
bun run dev:local:wipe         # Remove all data (fresh database)
bun run dev:local:logs         # View all Docker logs
bun run dev:local:logs:worker  # View worker logs only
bun run dev:local:logs:db      # View database logs only
```

To include the management services (OpenBao, agent, socket proxy):

```bash
docker compose -f docker-compose.local.yml -f docker-compose.agent.yml up -d --build
```

### Option 2: Full Docker Development

All services in Docker, with HMR for the web server:

```bash
bun install
bun dev:docker:up       # Start all services in Docker
bun dev:docker:down     # Stop all Docker services
bun dev:docker:rebuild  # Full rebuild of all containers
bun dev:docker:wipe     # Remove all data (fresh database)
```

### Option 3: Manual (No Docker)

Requires an external TimescaleDB instance:

```bash
bun install
bun dev                 # Start dev server (port 3000)
bun worker              # Start background worker (separate terminal)
```

---

## Testing

Tests use [Bun's built-in test runner](https://bun.sh/docs/cli/test), organized in `__tests__/` folders alongside source code.

```bash
bun test                    # Run all tests (enforces coverage thresholds)
bun test --watch            # Watch mode (no coverage enforcement)
bun run test:coverage       # Coverage report only
bun run test:coverage:check # Coverage check without re-running tests
```

### Coverage Requirements

- Minimum **96% function coverage**
- Minimum **99% line coverage**
- Automatically enforced by `bun test` and CI

Test files use `*.test.ts` naming in `__tests__/` directories co-located with source (e.g., `src/lib/__tests__/stream-utils.test.ts`).

## Type Checking

```bash
bun run typecheck       # Run TypeScript type checking
```

## Production Build

```bash
bun build               # Production build (runs typecheck first)
```
