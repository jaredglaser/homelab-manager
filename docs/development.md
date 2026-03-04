# Development Guide

## Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- A Docker host with the Docker API exposed (default port `2375`)
  > **Security warning:** Port 2375 is the **unauthenticated** Docker API. Never expose it on a public network. Bind the API to `localhost` or a trusted subnet, or secure it with [TLS](https://docs.docker.com/engine/security/protect-access/#use-tls-https-to-protect-the-docker-daemon-socket) / SSH tunneling.
- *(Optional)* A host running ZFS with SSH access for pool monitoring

## Environment Setup

A `.env` file is **required** in the project root. Create one based on `.env.example`:

```env
# Docker Configuration
DOCKER_HOST_1="192.168.1.100"        # Docker host IP or hostname
DOCKER_HOST_PORT_1="2375"            # Docker API port

# ZFS Configuration (supports multiple hosts)
ZFS_HOST_1="192.168.1.101"          # ZFS host IP or hostname
ZFS_HOST_PORT_1="22"                # SSH port
ZFS_HOST_USER_1="root"              # SSH username

# Authentication - use ONE of the following:
ZFS_HOST_PASSWORD_1="your-password" # Password-based auth

# OR use key-based auth (recommended):
# ZFS_HOST_KEY_PATH_1="/path/to/private/key"
# ZFS_HOST_KEY_PASSPHRASE_1="optional-passphrase"
```

## Running Locally

### Option 1: Docker Compose (Recommended)

```bash
# Start the full stack (TimescaleDB, web server, background worker)
docker compose up -d

# View logs
docker compose logs -f

# Stop everything
docker compose down
```

Access the UI at http://localhost:3000

### Option 2: Local Development

**With Docker Compose (recommended)** - includes TimescaleDB, worker, and hot reload:

```bash
bun install             # Install dependencies
bun dev:docker:up       # Start TimescaleDB + worker with HMR
bun dev:docker:down     # Stop dev services
bun dev:docker:restart  # Restart dev services
```

**Without Docker Compose** - requires external TimescaleDB:

```bash
bun install             # Install dependencies
bun dev                 # Start dev server (port 3000)
bun worker              # Start background worker (separate terminal)
```

## Testing

Tests are written using [Bun's built-in test runner](https://bun.sh/docs/cli/test) and are organized in `__tests__/` folders alongside the source code they test.

```bash
# Run all tests (automatically enforces 93% coverage threshold)
bun test

# Run tests in watch mode (no coverage enforcement)
bun test --watch

# Run tests with coverage report only (no enforcement)
bun run test:coverage
```

### Coverage Requirements

- Minimum **93% line coverage**
- Minimum **93% function coverage**
- Coverage is **automatically enforced** when running `bun test`
- Coverage is enforced in CI pipeline

Test files follow the `*.test.ts` naming convention and are located in `__tests__/` directories within the same folder as the code they're testing (e.g., `src/lib/__tests__/stream-utils.test.ts` tests `src/lib/stream-utils.ts`).

## Type Checking

```bash
bun run typecheck       # Run TypeScript type checking
```

## Production Build

```bash
bun build               # Production build (runs typecheck first)
```
