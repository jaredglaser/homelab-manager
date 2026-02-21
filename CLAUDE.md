# Project Guidelines for Claude

## Workflow

**Start of every conversation:**
- ALWAYS read this file (`CLAUDE.md`) first to get up-to-date project context and guidelines.

**End of every task:**
- Check if `README.md` and `CLAUDE.md` need updates (architecture changes, file organization, commands, testing, tech stack).
- Run `bun run typecheck` to verify TypeScript types are correct.
- Run tests with `bun test` after code changes.
- Update documentation immediately if changes affect project structure or conventions.

## Critical Rules (Most Important)

1. **Styling**: TailwindCSS ONLY. Never use `sx` props, inline `style`, or create `.css` files (exception: `theme.ts`).
2. **Imports**: Always use `@/` for src files (e.g., `@/components/Header`). Use relative paths only within `__tests__/` for test imports.
3. **Server Functions**: All server logic via `createServerFn()` + middleware injection. Never create clients directly.
4. **SSE Pattern**: TanStack Router server routes (`src/routes/api/`) → `useTimeSeriesStream` hook → CSS Grid + `useWindowVirtualizer`. Server handles client disconnect via `request.signal`.
5. **File Creation**: PREFER editing existing files over creating new ones. Only create files when genuinely necessary.
6. **Testing**: Tests in `__tests__/` folders co-located with source. Use `bun:test` imports.
7. **No Logging**: No `console.log` in committed code. Only `console.error` for actual errors.

## Tech Stack

- **Framework:** TanStack Start (SPA mode, SSR disabled)
- **Runtime:** Bun (package manager, test runner, runtime)
- **Language:** TypeScript (strict mode) + React 19
- **UI:** MUI Joy UI (components) + TailwindCSS (styling)
- **Routing:** TanStack Router (file-based, auto-generated `routeTree.gen.ts`)
- **State:** TanStack Query (QueryClient singleton in `__root.tsx`)
- **Streaming:** Server-Sent Events (SSE) via TanStack Router server routes (`src/routes/api/`)
- **Clients:** Dockerode (Docker API), ssh2 (SSH), pg (PostgreSQL)
- **Database:** TimescaleDB (PostgreSQL 16 with wide hypertables, automatic compression & retention)
- **Background Worker:** Standalone Bun process for continuous data collection
- **Validation:** Zod
- **Testing:** Bun test (`bun:test`)
- **Deployment:** Docker Compose (multi-container setup)

## Commands

### Development
```bash
bun dev                     # Dev server (port 3000)
bun run typecheck           # Run TypeScript type checking
bun build                   # Production build (runs typecheck first)
bun test                    # Run all tests
bun test --watch            # Watch mode
bun run test:coverage       # Run tests with coverage report
bun run test:coverage:check # Run tests and enforce 93% coverage threshold
```

### Background Worker
```bash
bun worker                  # Run background collector (Docker + ZFS stats)
```

### Docker Compose (Production)
```bash
docker compose up -d          # Start all services
docker compose down && docker compose up -d  # Restart with fresh database
docker compose logs -f web    # View web server logs
docker compose logs -f worker # View background worker logs
docker compose ps             # View service status
```

### Docker Compose (Development - HMR)
```bash
bun dev:docker:up             # Start with HMR + volume mounts
bun dev:docker:down           # Stop dev services
bun dev:docker:restart        # Restart dev services (down && up)
docker compose -f docker-compose.dev.yml logs -f web  # View dev web logs
```

## File Organization

```
src/
├── components/
│   ├── shared-table/        # MetricValue (shared infrastructure)
│   ├── docker/              # Docker-specific components (CSS Grid + useWindowVirtualizer)
│   ├── zfs/                 # ZFS-specific components (CSS Grid + useWindowVirtualizer)
│   ├── proxmox/             # Proxmox components (ClusterSummaryCards, NodeTable, GuestTable, StorageTable)
│   └── [AppShell, Header, ModeToggle, ThemeProvider]
├── hooks/                   # Custom hooks (useSSE, useTimeSeriesStream, useSettings, etc.)
├── data/                    # Server functions (*.functions.tsx) - non-streaming DB queries
├── middleware/              # Connection injection (Docker, SSH, Database)
├── lib/
│   ├── __tests__/           # Unit tests (*.test.ts)
│   ├── clients/             # Connection managers (Docker, SSH, Database)
│   ├── config/              # Configuration loaders (database, worker, zfs)
│   ├── database/
│   │   ├── repositories/    # Data access layer (StatsRepository for wide tables)
│   │   ├── subscription-service.ts  # Shared poll broadcast service (StatsPollService)
│   │   └── migrate.ts       # Database migration runner
│   ├── parsers/             # Stream parsers
│   ├── test/                # Test utilities (NOT in __tests__)
│   ├── utils/               # Rate calculators, hierarchy builders, row converters
│   ├── proxmox/             # Proxmox poll service (ProxmoxPollService)
│   ├── streaming/types.ts   # Core interfaces
│   └── server-init.ts       # Server-side shutdown handlers
├── worker/
│   ├── collectors/          # Background collectors (Docker, ZFS)
│   └── collector.ts         # Worker entry point
├── types/                   # Domain types (docker.ts, zfs.ts, proxmox.ts)
├── formatters/              # Display formatting (metrics, numbers)
└── routes/
    ├── api/                 # SSE endpoints (docker-stats.ts, zfs-stats.ts)
    └── [index, zfs, proxmox, settings].tsx  # Page routes

migrations/                  # SQL migrations (001_initial_schema.sql, etc.)
```

## Architecture Patterns

### Routing
- **Never edit** `routeTree.gen.ts` (auto-generated by TanStack Router).
- Root route (`__root.tsx`) has ONLY `shellComponent` (plain HTML). NO `component` prop — SSR breaks MUI Joy.
- Client-side layout lives in `AppShell.tsx`. Each route wraps content with `<AppShell>`.
- All routes: `ssr: false` (SPA mode).

### Server Functions & SSE Streaming
- Non-streaming server logic: `createServerFn()` from `@tanstack/react-start`
- **Real-time streaming**: SSE via TanStack Router server routes in `src/routes/api/`
- Data flow: SSE endpoint → `useTimeSeriesStream` hook → CSS Grid + `useWindowVirtualizer`
- **Note**: SSE is a workaround because TanStack Start's streaming server functions don't close quickly enough when rapidly switching between tabs — the abort signal doesn't propagate reliably. Once this is fixed upstream, I plan to migrate back to native streaming (see roadmap).
- **Frontend reads from database** (not direct API/SSH connections):
  - Worker collects stats → INSERT wide rows into TimescaleDB
  - Server runs a shared `StatsPollService` that polls DB every 1s per source (docker, zfs)
  - Multiple SSE clients subscribe to the same poll — only 1 query/sec per source regardless of client count
  - Frontend preloads 60s of history via REST, then merges SSE updates
- **SSE endpoints use `createFileRoute` with `server.handlers`**:
  ```typescript
  // src/routes/api/docker-stats.ts — shared poll broadcast
  GET handler:
    1. Import server-init + statsPollService (dynamic imports)
    2. Create ReadableStream
    3. Subscribe to statsPollService('docker', callback)
    4. Callback sends rows as SSE data
    5. On request.signal abort: unsubscribe, close controller
  ```
- **IMPORTANT: Use dynamic imports for server-only modules** in SSE endpoints:
  ```typescript
  // BAD - gets bundled into client
  import { statsPollService } from '@/lib/database/subscription-service';

  // GOOD - only loaded on server at runtime
  const { statsPollService } = await import('@/lib/database/subscription-service');
  ```

### SSE Data Sources (Virtualized Tables)
Both Docker and ZFS tables use the same pattern:
1. Create SSE route in `src/routes/api/` using `createFileRoute` with `server.handlers`
2. Page route uses `useTimeSeriesStream` hook (preload + SSE merge + time-windowed buffer)
3. Pass `latestByEntity` (Map) and `rows` (sorted array) as props to table/chart components
4. Table component converts wide rows to domain objects, flattens to `FlatRow[]` discriminated union
5. Render with CSS Grid columns + `useWindowVirtualizer` (page-scroll virtualization)
6. Row components are div-based (not `<table>/<tr>/<td>`) for virtualizer compatibility

Rate calculators:
- Must implement `RateCalculator<TInput, TOutput>` interface (`src/lib/streaming/types.ts`)
- Use class-based calculators (not module-level functions)

### TimescaleDB Persistence & Background Workers
The frontend reads stats from the database via shared server-side polling:
```
Worker → Docker/ZFS APIs → INSERT wide rows → TimescaleDB
                                                    ↓
Browser → Server (SSE) ← StatsPollService (1s poll) → Query DB → Broadcast to all clients
```

**Database schema** (TimescaleDB wide tables):
- `docker_stats` — hypertable: time, host, container_id, container_name, image, cpu_percent, memory_usage, memory_limit, memory_percent, network_rx/tx, block_io_read/write
- `zfs_stats` — hypertable: time, host, pool, entity, entity_type, indent, capacity_alloc/free, read/write_ops_per_sec, read/write_bytes_per_sec, utilization_percent
- `entity_metadata` — key-value metadata per entity (icons, labels)
- `settings` — application settings
- **Compression**: Automatic after 1 hour (segmented by host/container or host/pool/entity)
- **Retention**: Automatic deletion after 7 days (handled by TimescaleDB policies)

**Architecture**:
- **Background worker**: Standalone Bun process (`bun worker`)
- **Collectors**: Class-based, extend `BaseCollector` (implements `AsyncDisposable`)
  - `BaseCollector` handles: collection loop, exponential backoff, graceful shutdown
  - Subclasses implement: `name`, `collect()` (runs continuously until aborted/error), `isConfigured()`
  - Docker collector keeps stats streams open continuously, flushes every 1 second, reconnects only on container changes or errors
  - ZFS collector streams `zpool iostat` continuously, flushes on each cycle boundary
  - Uses `AbortController` for cancellable sleeps and instant shutdown
  - Worker entry point uses `AsyncDisposableStack` + `await using` for deterministic cleanup
- **Collection frequency**: Configured via `WORKER_COLLECTION_INTERVAL_MS` (default 1000ms/1 second)
- **Collectors write directly**: Wide `DockerStatsRow[]`/`ZFSStatsRow[]` → INSERT into TimescaleDB
- **Persistent rate calculators**: Never cleared (unlike request-scoped calculators)
- **Shutdown**: Single `AbortController` in worker entry point, SIGTERM aborts all collectors instantly
- **Database is ephemeral** in dev: no persistent volume, `docker compose down && up` starts fresh
- **ZFS multi-host support**: One ZFS collector per configured host, matching Docker pattern
  - Configuration: numbered env vars (`ZFS_HOST_1`, `ZFS_HOST_USER_1`, etc.)
  - Config loader: `src/lib/config/zfs-config.ts` (Zod-validated)
  - UI hierarchy: hosts → pools → vdevs → disks (host row shown only when multiple hosts configured)
  - Host expansion state persisted to database settings
- **ZFS hierarchical entity paths**: Entity names encode hierarchy for filtering
  - Pool: `"tank"` (indent 0)
  - Vdev: `"tank/mirror-0"` (indent 2)
  - Disk: `"tank/mirror-0/sda"` (indent 4+)
  - Multi-host entity IDs are prefixed with host name: `"server1/tank/mirror-0/sda"`
  - Enables visibility filtering: collapsed pool skips `tank/*` entities
- **Stale data warning**: If no SSE data received for 30+ seconds, UI shows warning via `useTimeSeriesStream`

**Key files**:
- **SSE endpoints**: `src/routes/api/` (docker-stats.ts, zfs-stats.ts — subscribe to StatsPollService; proxmox-overview.ts — subscribe to ProxmoxPollService)
- **SSE hooks**: `src/hooks/useSSE.ts` (EventSource consumer), `src/hooks/useTimeSeriesStream.ts` (preload + SSE merge + stale detection)
- **Virtualized tables**: `src/components/docker/ContainerTable.tsx`, `src/components/zfs/ZFSPoolsTable.tsx` (CSS Grid + useWindowVirtualizer)
- Connection: `src/lib/clients/database-client.ts` (follows Docker/SSH pattern)
- Repository: `src/lib/database/repositories/stats-repository.ts` (wide table inserts/queries, NOTIFY after insert)
- Base collector: `src/worker/collectors/base-collector.ts` (AsyncDisposable, backoff)
- Collectors: `src/worker/collectors/` (Docker, ZFS — extend `BaseCollector`)
- Row converters: `src/lib/utils/docker-hierarchy-builder.ts` (`rowToDockerStats`), `src/lib/utils/zfs-hierarchy-builder.ts` (`rowToZFSStats`, `buildZFSHostHierarchy`)
- ZFS config: `src/lib/config/zfs-config.ts` (multi-host configuration loader)
- Abortable sleep: `src/lib/utils/abortable-sleep.ts` (cancellable sleep utility)
- Migrations: `migrations/*.sql` (settings table + TimescaleDB wide tables)
- **StatsPollService**: `src/lib/database/subscription-service.ts` (shared 1s poll, broadcasts to SSE subscribers)
- **ProxmoxPollService**: `src/lib/proxmox/proxmox-poll-service.ts` (shared 10s API poll, broadcasts snapshot to SSE subscribers)
- **Server init**: `src/lib/server-init.ts` (graceful shutdown handlers)

**Environment variables**:
- `POSTGRES_*`: Database connection config
- `WORKER_*`: Worker behavior config (enabled, collection interval)
- `ZFS_HOST_*`: ZFS config (`ZFS_HOST_1`, `ZFS_HOST_PORT_1`, `ZFS_HOST_NAME_1`, `ZFS_HOST_USER_1`, `ZFS_HOST_KEY_PATH_1`, etc.)
- `PROXMOX_*`: Proxmox VE API connection config

### Proxmox VE Integration (REST API + SSE Broadcast)
Unlike Docker/ZFS (which use background workers + TimescaleDB + SSE), Proxmox uses **server-side shared polling** of the Proxmox REST API with SSE broadcast:
- **No background worker** — `ProxmoxPollService` runs server-side, auto-starts on first SSE subscriber
- **No database persistence** — cluster overview is fetched fresh from the API each poll cycle
- **Shared poll** — one `setInterval(10s)` polls the API regardless of how many clients are connected
- **SSE broadcast** — all connected clients receive the same snapshot via Server-Sent Events
- **Native fetch** — thin client using `fetch()` with API token auth (no npm dependency)
- **Self-signed certs** — handled via Bun's `tls.rejectUnauthorized: false` option

**Data flow**: `ProxmoxPollService` (10s poll) → `ProxmoxClient.getClusterOverview()` → Proxmox REST API → SSE broadcast → Browser (`useSSE` hook)

**Key files**:
- Types: `src/types/proxmox.ts` (API response types + cluster overview aggregate)
- Config: `src/lib/config/proxmox-config.ts` (Zod-validated env var loader)
- Client: `src/lib/clients/proxmox-client.ts` (native fetch client + connection manager singleton)
- Poll service: `src/lib/proxmox/proxmox-poll-service.ts` (shared poll + SSE broadcast singleton)
- SSE endpoint: `src/routes/api/proxmox-overview.ts` (SSE server route)
- Server functions: `src/data/proxmox.functions.tsx` (connection test only)
- Dashboard: `src/routes/proxmox.tsx` (page route with `useSSE` hook)
- Components: `src/components/proxmox/` (ClusterSummaryCards, NodeTable, GuestTable, StorageTable)

**Environment variables**:
- `PROXMOX_HOST`: Proxmox VE hostname or IP
- `PROXMOX_PORT`: API port (default: 8006)
- `PROXMOX_TOKEN_ID`: API token ID (format: `USER@REALM!TOKENID`)
- `PROXMOX_TOKEN_SECRET`: API token secret (UUID)
- `PROXMOX_ALLOW_SELF_SIGNED`: Allow self-signed certs (default: true)

### Components
- Shared infrastructure: `src/components/shared-table/` (MetricValue)
- Domain components: own directories (`docker/`, `zfs/`, `proxmox/`)
- Both Docker and ZFS tables use CSS Grid + `useWindowVirtualizer` with flat row models
- Proxmox tables use CSS Grid without virtualization (snapshot data, not streaming)
- Page routes use `useTimeSeriesStream` hook (Docker/ZFS) or `useSSE` hook (Proxmox)
- Table components convert wide rows to domain objects via `rowToDockerStats`/`rowToZFSStats`

### Styling
- **TailwindCSS only** for all layout and styling
- Never use MUI `sx` props (use Tailwind: `p-3` not `sx={{ p: 3 }}`)
  - Exception: MUI Joy Table internal element selectors (e.g., `'& thead th'`) require `sx` for proper CSS specificity
  - Exception: MUI Joy CSS variables (e.g., `'--ModalDialog-minWidth'`) require `sx` since Tailwind can't set them
- Never use inline `style` attribute (exception: virtualizer positioning, dynamic indent padding)
- Never create `.css` files (exception: Joy UI theme in `theme.ts`)

### State Management
- `QueryClient` is a singleton in `__root.tsx` — never create per-route
- Use `useTimeSeriesStream` hook for SSE-backed streaming data (preload + SSE merge + time-windowed buffer + stale detection)
- Use `useSSE` hook directly for non-time-series SSE consumers (e.g., Proxmox snapshot data)
- SSE connection management handled automatically by the browser's EventSource API

### Types
- Domain types: `src/types/` (e.g., `docker.ts`, `zfs.ts`)
- Streaming infrastructure: `src/lib/streaming/types.ts`

### Testing
- Test files: `__tests__/` folders co-located with source
- Naming: `*.test.ts` or `*.test.tsx`
- Test utilities: separate directories (e.g., `src/lib/test/`), NOT in `__tests__/`
- Use `bun:test` imports: `import { describe, it, expect } from 'bun:test'`
- **Coverage requirements:** 93% lines, 93% functions (automatically enforced by `bun test`)
- `bun test` automatically checks coverage and fails if below threshold

### Imports
- **Always use `@/` for project imports**: `import { Header } from '@/components/Header'`
- Relative paths OK for test imports in `__tests__/`: `import { foo } from '../foo'`
- Never mix `@/` and relative in the same file (except tests)

## Decision Frameworks

### When to Create a New File
**Create:** New feature/component with distinct responsibility
**Edit:** Modifying or extending existing functionality

### When to Use Middleware
**Use:** Connection injection (Docker, SSH, HTTP clients) and cross-cutting concerns
**Don't:** Business logic (server functions) or component logic (hooks/components)

### When to Extract a Component
**Extract:** Repeated 3+ times OR clear reusable abstraction
**Don't:** One-off use or requires excessive props to function

## CI/CD & Code Review

### Branch Protection
- All changes to `main` must go through a pull request — direct pushes are blocked.
- PRs require passing CI status checks (build, test, coverage, license) before merging.
- PRs by `jaredglaser` or `claude[bot]` receive an automatic Claude code review when marked ready for review; use `@claude` mention for subsequent reviews.

### GitHub Actions Workflows
| Workflow | File | Triggers |
|----------|------|----------|
| **CI** | `.github/workflows/ci.yml` | Push to `main`, PRs targeting `main` |
| **Claude PR Review** | `.github/workflows/claude-code-review.yml` | PRs targeting `main` (ready_for_review only) |
| **Claude Code** | `.github/workflows/claude.yml` | `@claude` mentions in issues, PR comments, and PR reviews |

## Security & Best Practices

- Never log environment variables or sensitive config
- Validate all external input with Zod
- Never commit debugging code (`console.log`)
- Use `console.error` only for actual errors
- Prefer type safety over runtime checks where possible

## Anti-Patterns (DO NOT)

- MUI `sx` props for styling (use Tailwind)
- Inline `style` attributes (use Tailwind)
- Creating `.css` files (use Tailwind)
- Manual edits to `routeTree.gen.ts` (auto-generated)
- Adding `component` to root route (breaks SSR)
- Creating QueryClient per route (singleton only)
- Creating clients in server functions (use middleware)
- Using TanStack Start streaming server functions (use SSE via `src/routes/api/` server routes instead — proper disconnect handling)
- HTML `<table>/<tr>/<td>` for streaming tables (use CSS Grid divs + virtualizer)
- Dashboard wrapper components
- Test files outside `__tests__/` folders
- `console.log` in committed code
- Logging sensitive data
- Static imports of server-only modules (pg, subscription-service, database-client) in server function files — use dynamic `await import()` inside handlers

## Quick Reference

| Need | Solution |
|------|----------|
| Style component | TailwindCSS classes |
| Server logic (non-streaming) | `createServerFn()` + middleware |
| Real-time streaming | SSE route in `src/routes/api/` |
| Consume SSE stream | `useTimeSeriesStream` hook (tables) or `useSSE` hook (other) |
| New streaming table | CSS Grid + `useWindowVirtualizer` + `useTimeSeriesStream` |
| Import from src | `@/path/to/file` |
| Test file location | `__tests__/filename.test.ts` |
| Run tests | `bun test` |
| Check TypeScript types | `bun run typecheck` |
| Type validation | Zod schema |
