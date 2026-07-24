# Development Guide

## Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- [Docker](https://docs.docker.com/get-docker/) and [Docker Compose](https://docs.docker.com/compose/install/) v2+
- *(Optional)* A host running ZFS for pool monitoring (via agent sidecar)
- *(Optional)* A Proxmox VE cluster with an API token for monitoring

## Environment Setup

A `.env` file is required. To protect it from being lost during `git clean` or worktree operations, store the real file outside the repo at `~/.config/homelab-manager/.env` and link it into the project root:

```bash
mkdir -p ~/.config/homelab-manager
cp .env.example ~/.config/homelab-manager/.env
ln ~/.config/homelab-manager/.env .env   # hardlink (same filesystem only)
# or: ln -s ~/.config/homelab-manager/.env .env
```

The `dev:local:*` scripts also pass `--env-file ~/.config/homelab-manager/.env` to compose so interpolation works even if the repo-side link is missing. Host-side `bun dev` still reads `.env` from the project root, so keep the link in place.

Edit `~/.config/homelab-manager/.env` with your values.

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

# Worker: enable Docker collection
WORKER_DOCKER_ENABLED="true"
WORKER_COLLECTION_INTERVAL_MS="1000"

# Web server
WEB_PORT="3000"

# Docker Stack Management / Git stacks repo
GIT_REPOS_DIR="./data/repos"

# Master encryption key for stack secrets and per-agent keypairs.
# Generate with: openssl rand -base64 32
MASTER_KEY="<generated>"

# Local-dev-only seeder: provisions a "localhost" managed host and dev keypair on first run.
HOMELAB_DEV_SEED="true"

# Compose profiles for direct `docker compose` invocations only. The dev:local:*
# scripts pass --profile management --profile oidc explicitly, which overrides
# this variable, so it cannot be used to opt out of Pocket ID (see docs/dev-oidc.md).
COMPOSE_PROFILES="management"
```

### Step 2: Start the Dev Stack

```bash
bun run setup              # Installs homelab-manager and agent

# Terminal 1: Start all Docker services
bun run dev:local:up

# Terminal 2: Run web app locally with HMR
bun dev
```

This starts:
- **PostgreSQL**: database
- **Worker**: background stats collector (generates a dev Ed25519 keypair for `localhost` on first run via `HOMELAB_DEV_SEED=true`)
- **Socket proxy**: safe Docker API access
- **Agent**: sidecar that streams container stats and handles deploys (reads the public JWK from `data/dev-agent-pubkey.json`)
- **Pocket ID + seeder**: local OIDC provider with dev users and one-time login URLs (always started; the `dev:local:*` scripts pass `--profile oidc` explicitly, see [docs/dev-oidc.md](dev-oidc.md))

### Step 3: Add Sample Containers via the Stacks Repo

The stacks feature uses an in-app git repo to store Docker Compose files. Clone it and add some sample containers so the dashboard has data to display:

**Docker monitoring:** The local compose file seeds a localhost agent (via `HOMELAB_DEV_SEED=true`, which generates a dev Ed25519 keypair and writes the public JWK to `data/dev-agent-pubkey.json` for the agent to read) that reaches Docker through a socket proxy on the internal `agent-internal` network. The worker subscribes to the agent's SSE streams; it does not connect to Docker directly. No host port is needed for the Docker socket.

Cloning requires a per-user git token. Log in as `dev-admin` using a one-time URL from `data/dev-oidc-logins.txt` (see [docs/dev-oidc.md](dev-oidc.md)), then generate a token under **Settings → Auth Management → Generate Git Token**. When git prompts for credentials, enter any username and the token as the password (keeping the token out of shell history and `.git/config`):

```bash
git clone http://localhost:3000/api/git/stacks ~/stacks
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
    host: localhost
    autoDeploy: false
EOF
git add -A
git commit -m "Add sample containers stack"
git push
```

The stack should now appear on the **Stacks** tab. To actually start the sample containers, deploy the stack from the UI or run the compose file directly:

```bash
docker compose -f ~/stacks/samples/docker-compose.yml up -d
```

### Step 4: Verify Everything Works

1. Open http://localhost:3000
2. The **Docker** page should show running containers with live CPU/memory stats
3. The **Stacks** tab should appear in the top navigation (between Docker and ZFS)
4. The **Stacks** page should list the `samples` stack

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

To wipe all data and start fresh (includes database and all persisted volumes):

```bash
bun run dev:local:wipe
```

---

## Git Stacks Repository

Stack compose files are stored in an in-app bare git repo served at `http://localhost:3000/api/git/stacks`. See [docs/git-stacks-repo.md](git-stacks-repo.md) for full details on the repo format, manifest schema, and how pushes trigger deploys.

---

## Alternative Setup Options

### Manual (No Docker)

Requires an external TimescaleDB instance:

```bash
bun run setup           # Installs homelab-manager and agent
bun dev                 # Start dev server (port 3000)
bun worker              # Start background worker (separate terminal)
```

---

## Testing

Tests use [Bun's built-in test runner](https://bun.sh/docs/cli/test), organized in `__tests__/` folders alongside source code.

```bash
# homelab-manager only
bun test --isolate          # Run homelab-manager tests (no coverage enforcement)
bun test --isolate --watch  # Watch mode (no coverage enforcement)
bun run test                # Tests + coverage enforcement (94% functions / 98% lines)
bun run test:coverage       # Coverage report only (no enforcement)

# Agent only
bun run test:agent          # Run agent tests
bun run test:coverage:agent # Agent tests with coverage thresholds

# Combined
bun run test:all            # Run tests in both
bun run test:coverage:all   # Run tests in both with coverage thresholds
```

### Coverage Requirements

- Minimum **94% function coverage** (the floor accounts for V8 counting Zod callback definitions as uncovered functions; see `scripts/check-coverage.js`)
- Minimum **98% line coverage**
- Enforced by `bun run test` (which pipes `--coverage` to `scripts/check-coverage.js`) and CI. Bare `bun test --isolate` does NOT enforce the thresholds.

Test files use `*.test.ts` naming in `__tests__/` directories co-located with source (e.g., `src/lib/__tests__/stream-utils.test.ts`).

## Type Checking

```bash
bun run typecheck           # homelab-manager only
bun run typecheck:agent     # Agent only
bun run typecheck:all       # Both
```

## Production Build

```bash
bun build               # Production build (runs typecheck first)
```

## TLS Setup (Agent Communication)

Agent sidecars can optionally serve over HTTPS. This is not required for local network use; agents work over plain HTTP by default.

For production or untrusted networks, provision a certificate from your own CA (e.g., step-ca, Let's Encrypt, or a corporate PKI):

- Set `TLS_CERT_PATH` and `TLS_KEY_PATH` on the agent container to point at the certificate and private key.
- Set `NODE_EXTRA_CA_CERTS` on the web server and worker containers to trust your internal CA.
