# Development Guide

## Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) v2+
- *(Optional)* A host running ZFS with SSH access for pool monitoring
- *(Optional)* A Proxmox VE cluster with an API token for monitoring

## Environment Setup

A `.env` file is required in the project root. To protect it from being lost during `git clean` or worktree operations, store the real file outside the repo and symlink it:

```bash
mkdir -p ~/.config/homelab-manager
cp .env.example ~/.config/homelab-manager/.env
ln -s ~/.config/homelab-manager/.env .env
```

If the symlink ever gets deleted (e.g., by `git clean`), recreate it:

```bash
ln -s ~/.config/homelab-manager/.env .env
```

Edit `~/.config/homelab-manager/.env` (or equivalently `.env` — they're the same file) with your values.

## Full Development Setup

This sets up everything: Docker monitoring, stack management, secrets, and sample containers to monitor.

### Step 1: Configure `.env`

Edit your `.env` with these values:

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

# Docker host — "socket-proxy" is the service from docker-compose.agent.yml
# The worker container resolves it via Docker's internal DNS
DOCKER_HOST_1="socket-proxy"
DOCKER_HOST_PORT_1="2375"
DOCKER_HOST_NAME_1="dev-machine"

# Web server
WEB_PORT="3000"

# Docker Stack Management / Git stacks repo
GIT_REPOS_DIR="./data/repos"
GIT_SERVER_TOKEN="dev-git-token"

# OpenBao (dev server with fixed root token)
# Use localhost because the web server runs locally via `bun dev`,
# outside Docker. The worker (inside Docker) overrides this to
# "http://openbao:8200" via docker-compose environment.
OPENBAO_URL="http://localhost:8200"
OPENBAO_TOKEN="dev-root-token"

# Start OpenBao with the management profile
COMPOSE_PROFILES="management"
```

### Step 2: Start the Dev Stack

```bash
bun install

# Terminal 1: Start all Docker services
bun run dev:local:up

# Terminal 2: Run web app locally with HMR
bun dev
```

This starts:
- **PostgreSQL** — database
- **Worker** — background stats collector
- **OpenBao** — secrets manager (file backend, auto-initializes on first start with root token `dev-root-token`, data persists across restarts)
- **Socket proxy** — safe Docker API access
- **Agent** — sidecar that streams container stats and handles deploys

### Step 3: Add Sample Containers via the Stacks Repo

The stacks feature uses an in-app git repo to store Docker Compose files. Clone it and add some sample containers so the dashboard has data to display:

**Docker monitoring:** The local compose file includes a socket proxy service that gives the worker read-only access to your Docker API. Set `DOCKER_HOST_1=socket-proxy` in `.env` — the worker resolves it by service name on the shared Docker network. No need to expose the Docker socket on a host port.

```bash
git clone http://x:dev-git-token@localhost:3000/api/git/stacks ~/stacks
cd ~/stacks
```

Create a sample stack with lightweight containers:

```bash
mkdir samples
cat > samples/docker-compose.yml << 'EOF'
services:
  caddy:
    image: caddy:2-alpine
    container_name: sample-caddy
    ports:
      - "8082:80"
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    container_name: sample-redis
    restart: unless-stopped

  whoami:
    image: traefik/whoami
    container_name: sample-whoami
    ports:
      - "8083:80"
    restart: unless-stopped
EOF
```

Update the manifest and push:

```bash
cat > manifest.yaml << 'EOF'
stacks:
  samples:
    host: dev-machine
    autoDeploy: false
EOF
git add -A
git commit -m "Add sample containers stack"
git push
```

The stack should now appear on the **Docker > Stacks** page. To actually start the sample containers, deploy the stack from the UI or run the compose file directly:

```bash
docker compose -f ~/stacks/samples/docker-compose.yml up -d
```

### Step 4: Verify Everything Works

1. Open http://localhost:3000
2. The **Docker** page should show running containers with live CPU/memory stats
3. The **Stacks** tab should appear in the top navigation (between Docker and ZFS)
4. The **Stacks** page should list the `samples` stack
5. OpenBao should be accessible at http://localhost:8200 (token: `dev-root-token`)

If stats aren't flowing, check the worker logs:

```bash
bun run dev:local:logs:worker
```

### Management Commands

```bash
bun run dev:local:up           # Start all services
bun run dev:local:down         # Stop all services
bun run dev:local:restart      # Recreate containers (picks up .env changes)
bun run dev:local:rebuild      # Full rebuild (no cache) and restart
bun run dev:local:wipe         # Stop and delete all volumes (fresh database)
bun run dev:local:logs         # Tail all service logs
bun run dev:local:logs:worker  # Worker logs only
bun run dev:local:logs:agent   # Agent logs only
```

### Stopping

```bash
bun run dev:local:down

# Stop sample containers if running standalone
docker compose -f ~/stacks/samples/docker-compose.yml down
```

To wipe all data and start fresh (includes database AND OpenBao secrets):

```bash
bun run dev:local:wipe
```

---

## Git Stacks Repository

Stack compose files are stored in an in-app bare git repo served at `http://localhost:3000/api/git/stacks`. See [docs/git-stacks-repo.md](git-stacks-repo.md) for full details on the repo format, manifest schema, and how pushes trigger deploys.

---

## Alternative Setup Options

### Full Docker Development

All services in Docker, with HMR for the web server:

```bash
bun install
bun dev:docker:up       # Start all services in Docker
bun dev:docker:down     # Stop all Docker services
bun dev:docker:rebuild  # Full rebuild of all containers
bun dev:docker:wipe     # Remove all data (fresh database)
```

### Manual (No Docker)

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

## TLS Setup (Agent Communication)

Agent sidecars can optionally serve over HTTPS. This is not required for local network use — agents work over plain HTTP by default. For production or untrusted networks, use OpenBao's PKI secrets engine to issue short-lived certificates.

### Enable the PKI secrets engine

```bash
bao secrets enable pki
```

### Configure the internal CA (10-year TTL)

```bash
bao write pki/root/generate/internal \
  common_name="homelab-manager-ca" \
  ttl=87600h
```

### Create a role for agent certificates (30-day max TTL)

```bash
bao write pki/roles/agent \
  allowed_domains="*.homelab.local" \
  allow_subdomains=true \
  max_ttl=720h
```

### Issue a certificate for an agent

```bash
bao write pki/issue/agent \
  common_name="agent.homelab.local" \
  ttl=720h
```

### Usage

- The agent reads the certificate and key from `TLS_CERT_PATH` and `TLS_KEY_PATH` env vars.
- Set `NODE_EXTRA_CA_CERTS` on the web server and worker to trust the internal CA.
- Certificates have short TTLs (30 days) and should be renewed before expiry.
- The PKI engine acts as an internal CA — no external certificate authority is required.
