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

If the sample containers were started standalone, stop them with `docker compose -f ~/stacks/samples/docker-compose.yml down`.

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
bun run test                # Tests + coverage enforcement
bun run test:coverage       # Coverage report only (no enforcement)

# Agent only
bun run test:agent          # Run agent tests
bun run test:coverage:agent # Agent tests with coverage thresholds

# Combined
bun run test:all            # Run tests in both
bun run test:coverage:all   # Run tests in both with coverage thresholds
```

### Coverage Requirements

- Function and line minimums live in the `THRESHOLDS` object in `scripts/check-coverage.js`. That file is the single source of truth for all three packages (homelab-manager, agent, agent-updater all pipe into it), so check the values there instead of relying on a number copied into docs.
- Enforced by `bun run test` (which pipes `--coverage` to `scripts/check-coverage.js`) and CI. Bare `bun test --isolate` does NOT enforce the thresholds.

Test files use `*.test.ts` naming in `__tests__/` directories co-located with source (e.g., `src/lib/__tests__/stream-utils.test.ts`).

### End-to-End (Playwright + MSW)

E2e tests cover what unit tests cannot. They run against static production builds
served over [MSW](https://mswjs.io) - the same in-browser mock backend that powers
demo mode - so there is no database or backend to stand up.

Unit tests run in Happy-DOM, so they cannot exercise real layout and overflow, the
service worker, EventSource streaming end to end, canvas charts, the virtualizer's
real measurement, cross-tab broadcast, focus and scroll, or multi-step navigation
with live data. **A flow earns a Playwright test only when it needs one of those**;
anything else belongs in `bun test`, which is faster and easier to debug.

```bash
bun run test:e2e        # Build the demo + app targets, then run Playwright
bun run test:e2e:run    # Run against an already-built e2e-build/ (faster iteration)
bun run e2e:build       # Just build + stage both static targets under e2e-build/
bun run test:e2e:ui     # Playwright UI mode
```

Two targets share the handlers in `src/lib/mock`: `demo` (the `VITE_DEMO_MODE`
build, smoke-tested) and `app` (the real non-demo build with `VITE_ENABLE_MSW`,
deep flows). Specs live in `e2e/`; `*.demo.e2e.ts` run on `demo`, all other
`*.e2e.ts` on `app`. The `.e2e.ts` suffix is deliberate: `bun test` collects
`*.spec.ts`, and Playwright's `test()` throws when bun's runner loads it. Tests
reshape individual responses per scenario with `overrideServerFn` (see
`e2e/fixtures.ts`).

When authoring a spec, prefer role and text queries over test ids, adding
`data-testid` only where the DOM is genuinely ambiguous, and drive scenarios by
overriding the shared mocks rather than adding bespoke demo data, so the demo stays
representative of what the tests assert.

The flow inventory, including what is covered and what is still open, lives in
[issue #384](https://github.com/jaredglaser/homelab-manager/issues/384).

Playwright's browser must be available; in a fresh checkout run
`bunx playwright install chromium` first.

### End-to-End (real server + Pocket ID)

A second, separate lane covers the one thing MSW structurally cannot: the session
cookie the server actually sets. MSW serves a static client bundle and fakes auth
through a `getSession` override, and a service worker cannot emit an `HttpOnly`
`Set-Cookie`; Happy-DOM cannot either, since `Set-Cookie` is a forbidden response
header. So this lane boots the real Nitro build against a real Pocket ID and a
throwaway TimescaleDB.

```bash
bun run test:e2e:auth       # Build the real app, generate certs, seed Pocket ID, run
bun run test:e2e:auth:run   # Run against an already-built/seeded e2e-build/
```

It needs Pocket ID and Postgres reachable (`POCKET_ID_URL`, `POCKET_ID_API_KEY`,
`POSTGRES_*`) before it starts. `playwright.auth.config.ts` is a separate config
from `playwright.config.ts` on purpose: Playwright starts every `webServer` entry
in a config regardless of which project is selected, so a merged config would make
the MSW lane require these containers too. Its two projects run the same app under
`OIDC_REDIRECT_URI=http` (`auth-http`, port 3201, plain `session`) and `=https`
(`auth-https`, port 3202 behind a TLS proxy, `__Host-session` + `Secure`), which is
what the cookie name keys off.

The attribute strings themselves are already covered by
`src/lib/auth/__tests__/session-cookie.test.ts`. What this lane adds is that a real
browser *accepts and stores* the `__Host-` cookie (a malformed one is dropped
silently, so asserting the header string is not proof) and that the full handshake
against a real IdP produces a session that authenticates the next request.

It runs nightly via `.github/workflows/e2e-auth.yml`, not in CI, and gates nothing.
Its realistic failure mode is provider drift rather than an app regression, which
should not block a merge or a release. Both service images are pinned; bump them
deliberately. Run it by hand on a branch that touches `src/lib/auth` or the lane's
own scripts:

```bash
gh workflow run e2e-auth.yml --ref <branch>
```

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
