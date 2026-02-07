# Homelab Manager

[![CI](https://github.com/jaredglaser/homelab-manager/actions/workflows/ci.yml/badge.svg)](https://github.com/jaredglaser/homelab-manager/actions/workflows/ci.yml)

> A real-time monitoring dashboard for homelab infrastructure, built on TanStack Start.

> [!WARNING]
> This project is a **work in progress**. Features are incomplete, APIs may change, and the codebase is under active development. See [Roadmap](#roadmap) for planned features.

## Overview

Homelab Manager aims to be a **one-stop-shop dashboard** for managing Docker hosts, Proxmox clusters, and any other homelab service — all from a single interface. The architecture is designed to be extensible: new data sources can be added through SSH or HTTP connections using a consistent streaming pipeline.

### Current Features

- **Docker Dashboard** (`/`) — Real-time streaming metrics for all running containers including CPU utilization, memory usage, block I/O (read/write), and network I/O (RX/TX)
- **ZFS Dashboard** (`/zfs`) — Hierarchical view of ZFS pools, vdevs (mirror/raidz), and disks with capacity, IOPS, and bandwidth metrics collected via SSH and streamed from the database
- **PostgreSQL Persistence** — Background worker continuously collects stats with progressive downsampling (raw → minute → hour → day aggregates) for infinite retention
- **Docker Compose Deployment** — Full stack with PostgreSQL, web server, background worker, and daily cleanup job (builds from source, no pre-built image)
- **Live-Updating UI** — Server-Sent Events (SSE) stream data continuously to the client with no polling
- **Factory-Based Table Architecture** — Adding a new streaming data source requires only an SSE endpoint, column definitions, and a row renderer

## Built With

This project is built on the **TanStack ecosystem** as its core framework:

| Layer | Technology | Role |
|-------|-----------|------|
| **Framework** | [TanStack Start](https://tanstack.com/start) | Full-stack React framework — server functions, SSR, and file-based routing |
| **Routing** | [TanStack Router](https://tanstack.com/router) | Type-safe, file-based routing with built-in devtools |
| **Async State** | [TanStack Query](https://tanstack.com/query) | Server state management — caching, refetching, and stale data detection |
| **Runtime** | [Bun](https://bun.sh) | Package manager, test runner, and JavaScript runtime |
| **Build** | [Vite](https://vite.dev) | Dev server and production bundler |
| **UI** | [MUI Joy UI](https://mui.com/joy-ui/getting-started/) + [TailwindCSS](https://tailwindcss.com) | Component library and utility-first styling |
| **Docker** | [Dockerode](https://github.com/apocas/dockerode) | Docker Engine API client |
| **SSH** | [ssh2](https://github.com/mscdex/ssh2) | SSH client for remote command execution |
| **Validation** | [Zod](https://zod.dev) | Schema validation |
| **Language** | TypeScript + React 19 | Type-safe UI development |

## Architecture

### System Overview

```mermaid
graph TD
    Browser["Browser<br/>(multiple tabs)"]

    subgraph TanStack_Start["TanStack Start Server"]
        SSE["SSE Endpoints<br/>(server routes)"]
        SubSvc["Subscription Service<br/>(LISTEN handler)"]
        Cache["Stats Cache<br/>(shared singleton)"]
    end

    subgraph Database["PostgreSQL"]
        StatsRaw["stats_raw table"]
        Notify["NOTIFY stats_update"]
    end

    subgraph Worker["Background Worker"]
        Collectors["Collectors<br/>(Docker, ZFS)"]
    end

    subgraph Hosts["Homelab Hosts"]
        DockerHost["Docker Host<br/>Container Stats"]
        ZFSHost["ZFS Host<br/>zpool iostat"]
    end

    Browser <-->|"SSE streaming"| SSE
    SSE --> Cache
    SubSvc -->|"On NOTIFY"| Cache
    Notify --> SubSvc
    StatsRaw --> Notify
    Collectors -->|"Batch INSERT"| StatsRaw
    Collectors --> DockerHost
    Collectors --> ZFSHost
```

The frontend reads stats from the database, not directly from Docker/ZFS APIs. This enables:
- **Multiple browser tabs** share the same server-side cache
- **Real-time updates** via PostgreSQL LISTEN/NOTIFY (no polling)
- **Visibility filtering** for ZFS (only stream data for expanded pools/vdevs)
- **Stale data detection** when background worker stops (30+ second warning)

### Data Streaming Pipeline

The application uses a two-stage pipeline: background collection and real-time streaming.

**Stage 1: Background Collection (Worker)**

```mermaid
flowchart LR
    CL["Client<br/>(Docker / SSH)"]
    RS["Raw Stream<br/>(JSON / text)"]
    PA["Parser<br/>(structured data)"]
    RC["Rate Calculator<br/>(deltas & metrics)"]
    Batch["Batch Writer"]
    DB["PostgreSQL<br/>+ NOTIFY"]

    CL --> RS --> PA --> RC --> Batch --> DB
```

**Stage 2: Real-Time Streaming (Server → Browser)**

```mermaid
flowchart LR
    DB["PostgreSQL<br/>LISTEN"]
    SubSvc["Subscription Service"]
    Cache["Stats Cache"]
    SSE["SSE Endpoint<br/>(server route)"]
    Hook["useSSE<br/>(hook)"]
    ST["StreamingTable<br/>(factory component)"]

    DB -->|"NOTIFY"| SubSvc --> Cache --> SSE --> Hook --> ST
```

**How it works:**

1. **Background worker** continuously collects stats from Docker/ZFS APIs
2. Stats are **batch inserted** into PostgreSQL with `NOTIFY stats_update`
3. **Subscription service** maintains a `LISTEN` connection, updates the **shared cache** on each notification
4. **SSE endpoints** stream stats from the cache when notified (filtered by visibility for ZFS)
5. The **`useSSE` hook** consumes the SSE stream via EventSource, managing connection lifecycle and error state
6. The **`StreamingTable` factory component** renders the UI with automatic stale data detection

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) (package manager and runtime)
- A Docker host with the Docker API exposed (default port `2375`)
- *(Optional)* A host running ZFS with SSH access for pool monitoring

### Environment Setup

A `.env` file is **required** in the project root. Create one based on `.env.example`:

```env
# Docker Configuration
DOCKER_HOST_1="192.168.1.100"        # Docker host IP or hostname
DOCKER_HOST_PORT_1="2375"            # Docker API port

# ZFS SSH Configuration
ZFS_SSH_HOST="192.168.1.101"         # ZFS host IP or hostname
ZFS_SSH_PORT="22"                    # SSH port
ZFS_SSH_USER="root"                  # SSH username

# Authentication — use ONE of the following:
ZFS_SSH_PASSWORD="your-password"     # Password-based auth

# OR use key-based auth (recommended):
# ZFS_SSH_KEY_PATH="/path/to/private/key"
# ZFS_SSH_KEY_PASSPHRASE="optional-passphrase"
```

### Run Locally

#### Option 1: Docker Compose (Recommended)

```bash
# Start the full stack (PostgreSQL, web server, background worker)
docker compose up -d

# View logs
docker compose logs -f

# Stop everything
docker compose down
```

Access the UI at http://localhost:3000

#### Option 2: Local Development

```bash
# Install dependencies
bun install

# Start the dev server (port 3000)
bun dev

# In another terminal, start the background worker (optional)
bun worker
```

**Note:** For local development without Docker Compose, you'll need to run PostgreSQL separately if you want background data collection.

### Testing

Tests are written using [Bun's built-in test runner](https://bun.sh/docs/cli/test) and are organized in `__tests__/` folders alongside the source code they test:

```bash
# Run all tests (automatically enforces 93% coverage threshold)
bun test

# Run tests in watch mode (no coverage enforcement)
bun test --watch

# Run tests with coverage report only (no enforcement)
bun run test:coverage
```

**Coverage Requirements:**
- Minimum **93% line coverage**
- Minimum **93% function coverage**
- Coverage is **automatically enforced** when running `bun test`
- Coverage is enforced in CI pipeline

Test files follow the `*.test.ts` naming convention and are located in `__tests__/` directories within the same folder as the code they're testing (e.g., `src/lib/__tests__/stream-utils.test.ts` tests `src/lib/stream-utils.ts`).

## Project Structure

```
src/
├── components/
│   ├── AppShell.tsx                 # Shared layout (ThemeProvider, QueryClient, Header)
│   ├── Header.tsx                   # Navigation header
│   ├── ModeToggle.tsx               # Dark/light theme toggle
│   ├── ThemeProvider.tsx            # MUI Joy theme wrapper
│   ├── docker/
│   │   ├── ContainerTable.tsx       # Docker StreamingTable config
│   │   └── ContainerRow.tsx         # Docker container row renderer
│   ├── zfs/
│   │   ├── ZFSPoolsTable.tsx        # ZFS StreamingTable config
│   │   ├── ZFSPoolAccordion.tsx     # Expandable pool row
│   │   ├── ZFSVdevAccordion.tsx     # Expandable vdev row
│   │   ├── ZFSDiskRow.tsx           # Disk row renderer
│   │   └── ZFSMetricCells.tsx       # Shared ZFS metric columns
│   └── shared-table/
│       ├── MetricCell.tsx           # Right-aligned table cell
│       └── StreamingTable.tsx       # Factory component (with stale detection)
├── hooks/
│   └── useSSE.ts                    # EventSource-based SSE consumer
├── data/
│   ├── docker.functions.tsx         # Docker server functions (active containers, stale check)
│   ├── settings.functions.tsx       # Settings server functions (get/update)
│   └── zfs.functions.tsx            # ZFS server functions (active pools, stale check)
├── middleware/
│   ├── docker-middleware.ts         # Docker client injection
│   └── ssh-middleware.ts            # SSH client injection
├── lib/
│   ├── __tests__/                   # Unit tests
│   ├── cache/
│   │   └── stats-cache.ts           # Singleton stats cache (shared across connections)
│   ├── clients/                     # Connection managers (Docker, SSH, Database)
│   ├── config/                      # Configuration loaders (database, worker)
│   ├── database/
│   │   ├── repositories/            # Data access layer (StatsRepository)
│   │   ├── subscription-service.ts  # PostgreSQL LISTEN/NOTIFY handler
│   │   └── migrate.ts               # Database migration runner
│   ├── parsers/                     # Stream parsers (ZFS iostat, text lines)
│   ├── test/                        # Test utilities and helpers
│   ├── transformers/                # DB rows → domain objects
│   │   ├── docker-transformer.ts    # DB rows → Docker stats
│   │   └── zfs-transformer.ts       # DB rows → ZFS stats (with hierarchy)
│   ├── utils/                       # Rate calculators, hierarchy builders
│   ├── streaming/types.ts           # Core interfaces (StreamingClient, RateCalculator)
│   └── server-init.ts               # Server-side shutdown handlers
├── worker/
│   ├── collectors/                  # Background collectors (Docker, ZFS)
│   ├── collector.ts                 # Worker entry point
│   └── cleanup.ts                   # Daily downsampling script
├── types/                           # Domain types (Docker, ZFS)
├── formatters/metrics.ts            # Number formatting (%, bytes, bits)
├── routes/
│   ├── __root.tsx                   # HTML shell (SSR-safe, no MUI)
│   ├── api/
│   │   ├── docker-stats.ts          # Docker SSE endpoint
│   │   └── zfs-stats.ts             # ZFS SSE endpoint
│   ├── index.tsx                    # Docker page (/)
│   ├── settings.tsx                 # Settings page (/settings)
│   └── zfs.tsx                      # ZFS page (/zfs)
└── theme.ts                         # MUI Joy theme config

migrations/                          # SQL migrations (schema + downsampling functions)
```

## Roadmap

- [x] **PostgreSQL persistence** — background worker collects stats with progressive downsampling (second → minute → hour → day aggregates)
- [x] **Docker Compose deployment** — multi-container setup with PostgreSQL, web server, and background worker
- [x] **Database-backed streaming** — frontend reads from PostgreSQL via LISTEN/NOTIFY instead of direct API/SSH connections; shared cache across browser tabs
- [ ] **Return to TanStack Start streaming server functions** — currently using SSE as a workaround because streaming server functions don't close quickly enough when rapidly switching between tabs; once TanStack Start's abort signal propagation is more reliable, migrate back to the native streaming pattern
- [ ] **Historical data UI** — charts and graphs for historical metrics with time-range selection
- [ ] **Proxmox API integration** — VM and LXC container management and statistics
- [ ] **Authentication** — user login and access control using OIDC with first class Pocket ID support
- [ ] **Pre-built Docker image** — publish to a container registry for one-step deployment without building from source
- [ ] **Extensible service architecture** — plugin-like system for adding any service over SSH or HTTP

## AI Disclosure

AI tools are used during development, particularly in early-stage prototyping and testing. **All code is fully human-reviewed** before being merged. The codebase is under active refactoring to ensure it is readable, well-structured, and efficient.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

All dependencies use permissive licenses compatible with Apache 2.0. License compliance is verified automatically in CI using [license-checker-rseidelsohn](https://github.com/RSeidelsohn/license-checker-rseidelsohn).
