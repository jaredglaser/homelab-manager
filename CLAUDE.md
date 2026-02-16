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
4. **SSE Pattern**: TanStack Router server routes (`src/routes/api/`) → `useStreamingData` hook → CSS Grid + `useWindowVirtualizer`. Server handles client disconnect via `request.signal`.
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
- **Clients:** Dockerode (Docker API), ssh2 (SSH), pg (PostgreSQL), @influxdata/influxdb-client (InfluxDB)
- **Time-Series Database:** InfluxDB 2.x (stats storage with native retention policies)
- **Relational Database:** PostgreSQL 16 (settings + entity metadata only)
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
│   └── [AppShell, Header, ModeToggle, ThemeProvider]
├── hooks/                   # Custom hooks (useSSE, useStreamingData, etc.)
├── data/                    # Server functions (*.functions.tsx) - non-streaming DB queries
├── middleware/              # Connection injection (Docker, SSH, Database)
├── lib/
│   ├── __tests__/           # Unit tests (*.test.ts)
│   ├── cache/               # Stats cache singleton (shared across connections)
│   ├── clients/             # Connection managers (Docker, SSH, Database, InfluxDB)
│   ├── config/              # Configuration loaders (database, worker, influxdb)
│   ├── database/
│   │   ├── repositories/    # Data access layer (InfluxStatsRepository, EntityMetadataRepository)
│   │   ├── subscription-service.ts  # InfluxDB polling + PG LISTEN for settings
│   │   └── migrate.ts       # Database migration runner
│   ├── parsers/             # Stream parsers
│   ├── test/                # Test utilities (NOT in __tests__)
│   ├── transformers/        # DB rows → domain objects (Docker, ZFS)
│   ├── utils/               # Rate calculators, hierarchy builders
│   ├── streaming/types.ts   # Core interfaces
│   └── server-init.ts       # Server-side shutdown handlers
├── worker/
│   ├── collectors/          # Background collectors (Docker, ZFS)
│   └── collector.ts         # Worker entry point
├── types/                   # Domain types (docker.ts, zfs.ts)
├── formatters/              # Display formatting (metrics, numbers)
└── routes/
    ├── api/                 # SSE endpoints (docker-stats.ts, zfs-stats.ts)
    └── [index, zfs, settings].tsx  # Page routes

migrations/                  # SQL migrations (settings + entity metadata only)
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
- Data flow: SSE endpoint → `useStreamingData` hook → CSS Grid + `useWindowVirtualizer`
- **Note**: SSE is a workaround because TanStack Start's streaming server functions don't close quickly enough when rapidly switching between tabs — the abort signal doesn't propagate reliably. Once this is fixed upstream, I plan to migrate back to native streaming (see roadmap).
- **Frontend reads from database** (not direct API/SSH connections):
  - Worker collects stats → writes to InfluxDB
  - Server polls InfluxDB every 1s → updates shared cache on change
  - SSE endpoints stream from cache when updated
  - Multiple browser tabs share the same server-side cache
- **SSE endpoints use `createFileRoute` with `server.handlers`**:
  ```typescript
  // src/routes/api/docker-stats.ts
  import { createFileRoute } from '@tanstack/react-router';

  export const Route = createFileRoute('/api/docker-stats')({
    server: {
      handlers: {
        GET: async ({ request }) => {
          const { subscriptionService } = await import('@/lib/database/subscription-service');
          const { statsCache } = await import('@/lib/cache/stats-cache');

          await subscriptionService.start();

          let closed = false;
          const stream = new ReadableStream({
            start(controller) {
              const handler = (source: string) => {
                if (source === 'docker' && !closed) {
                  sendData(statsCache.getDocker());
                }
              };
              subscriptionService.on('stats_update', handler);

              // Clean up on client disconnect via abort signal
              request.signal.addEventListener('abort', () => {
                closed = true;
                subscriptionService.removeListener('stats_update', handler);
                controller.close();
              });
            },
          });

          return new Response(stream, {
            headers: {
              'Content-Type': 'text/event-stream',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
            },
          });
        },
      },
    },
  });
  ```
- **IMPORTANT: Use dynamic imports for server-only modules** in SSE endpoints:
  ```typescript
  // BAD - gets bundled into client
  import { subscriptionService } from '@/lib/database/subscription-service';

  // GOOD - only loaded on server at runtime
  const { subscriptionService } = await import('@/lib/database/subscription-service');
  ```

### SSE Data Sources (Virtualized Tables)
Both Docker and ZFS tables use the same pattern:
1. Create SSE route in `src/routes/api/` using `createFileRoute` with `server.handlers`
2. Use `useStreamingData` hook with a `transform` function to convert raw SSE data to hierarchy state
3. Flatten the hierarchy into a `FlatRow[]` discriminated union (respecting expansion state)
4. Render with CSS Grid columns + `useWindowVirtualizer` (page-scroll virtualization)
5. Row components are div-based (not `<table>/<tr>/<td>`) for virtualizer compatibility

Rate calculators:
- Must implement `RateCalculator<TInput, TOutput>` interface (`src/lib/streaming/types.ts`)
- Use class-based calculators (not module-level functions)

### Data Storage & Background Workers
Time-series stats are stored in **InfluxDB 2.x**. Settings and entity metadata remain in **PostgreSQL**.

The frontend reads stats via polling-based subscription:
```
Worker → Docker/ZFS APIs → InfluxDB write (via InfluxStatsRepository)
                                                      ↓
Browser → Server (SSE) ← Poll InfluxDB (1s) → Cache Update → yield stats
```

**InfluxDB data model**:
- Measurement: `stats`
- Tags: `source` (docker/zfs), `type` (cpu_percent, read_ops_per_sec, etc.), `entity`
- Fields: `value` (float)
- Timestamp: millisecond precision
- Retention handled natively by InfluxDB bucket retention policies

**PostgreSQL tables** (settings + metadata only):
- `settings` — key-value store for application settings
- `entity_metadata` — per-entity key-value metadata (display names, icons, labels)

Adding a new data source requires only a new collector — no schema changes needed.

**Architecture**:
- **Background worker**: Standalone Bun process (`bun worker`)
- **Collectors**: Class-based, extend `BaseCollector` (implements `AsyncDisposable`)
  - `BaseCollector` handles: collection loop, batch management, exponential backoff, graceful shutdown
  - Constructor: `(db, influxRepo, config, abortController?)`
  - Subclasses implement: `name`, `collectOnce()`, `isConfigured()`
  - Uses `AbortController` for cancellable sleeps and instant shutdown
  - Worker entry point uses `AsyncDisposableStack` + `await using` for deterministic cleanup
- **Dual repositories**: `InfluxStatsRepository` (time-series writes/queries) + `EntityMetadataRepository` (PG metadata)
- **Persistent rate calculators**: Never cleared (unlike request-scoped calculators)
- **Batch writes**: Accumulate stats then write to InfluxDB via `InfluxStatsRepository`
- **Collectors convert** domain objects into `RawStatRow[]` (source, type, entity, value)
- **Shutdown**: Single `AbortController` in worker entry point, SIGTERM aborts all collectors instantly
- **Subscription service**: Polls InfluxDB every 1s for latest stats, compares timestamps to detect changes, emits `stats_update` events. PostgreSQL LISTEN used only for `settings_change` notifications.
- **Database is ephemeral** in dev: no persistent volume, `docker compose down && up` starts fresh
- **ZFS hierarchical entity paths**: Entity names encode hierarchy for filtering
  - Pool: `"tank"` (indent 0)
  - Vdev: `"tank/mirror-0"` (indent 2)
  - Disk: `"tank/mirror-0/sda"` (indent 4+)
  - Enables visibility filtering: collapsed pool skips `tank/*` entities
- **Stale data warning**: If no poll update received for 30+ seconds, UI shows warning (TanStack Query with refetchInterval)

**Key files**:
- **SSE endpoints**: `src/routes/api/` (docker-stats.ts, zfs-stats.ts — TanStack Router server routes with proper disconnect handling)
- **SSE hooks**: `src/hooks/useSSE.ts` (EventSource consumer), `src/hooks/useStreamingData.ts` (SSE + state + stale detection)
- **Virtualized tables**: `src/components/docker/ContainerTable.tsx`, `src/components/zfs/ZFSPoolsTable.tsx` (CSS Grid + useWindowVirtualizer)
- PG connection: `src/lib/clients/database-client.ts` (follows Docker/SSH pattern)
- InfluxDB connection: `src/lib/clients/influxdb-client.ts` (InfluxDB client wrapper + connection manager)
- InfluxDB config: `src/lib/config/influxdb-config.ts` (env-based config with Zod validation)
- Stats repository: `src/lib/database/repositories/influx-stats-repository.ts` (InfluxDB writes + Flux queries)
- Metadata repository: `src/lib/database/repositories/entity-metadata-repository.ts` (PG entity metadata CRUD)
- Stats types: `src/lib/database/repositories/stats-repository.ts` (shared `RawStatRow` / `LatestStatRow` interfaces)
- Base collector: `src/worker/collectors/base-collector.ts` (AsyncDisposable, batch management, backoff)
- Collectors: `src/worker/collectors/` (Docker, ZFS — extend `BaseCollector`)
- Abortable sleep: `src/lib/utils/abortable-sleep.ts` (cancellable sleep utility)
- Migrations: `migrations/*.sql` (settings + entity metadata tables only)
- **Stats cache**: `src/lib/cache/stats-cache.ts` (singleton, shared across frontend connections)
- **Subscription service**: `src/lib/database/subscription-service.ts` (InfluxDB polling + PG LISTEN for settings)
- **Transformers**: `src/lib/transformers/` (convert DB rows to domain objects)
- **Server init**: `src/lib/server-init.ts` (graceful shutdown handlers)

**Environment variables**:
- `INFLUXDB_*`: InfluxDB connection config (URL, token, org, bucket, retention)
- `POSTGRES_*`: PostgreSQL connection config (settings + metadata)
- `WORKER_*`: Worker behavior config (enabled, batch size, intervals)

### Components
- Shared infrastructure: `src/components/shared-table/` (MetricValue)
- Domain components: own directories (`docker/`, `zfs/`)
- Both Docker and ZFS tables use CSS Grid + `useWindowVirtualizer` with flat row models
- `useStreamingData` hook handles SSE connection + state + stale detection for both tables

### Styling
- **TailwindCSS only** for all layout and styling
- Never use MUI `sx` props (use Tailwind: `p-3` not `sx={{ p: 3 }}`)
  - Exception: MUI Joy Table internal element selectors (e.g., `'& thead th'`) require `sx` for proper CSS specificity
  - Exception: MUI Joy CSS variables (e.g., `'--ModalDialog-minWidth'`) require `sx` since Tailwind can't set them
- Never use inline `style` attribute (exception: virtualizer positioning, dynamic indent padding)
- Never create `.css` files (exception: Joy UI theme in `theme.ts`)

### State Management
- `QueryClient` is a singleton in `__root.tsx` — never create per-route
- Use `useStreamingData` hook for SSE-backed streaming tables (wraps `useSSE` + state + stale detection)
- Use `useSSE` hook directly only for non-table SSE consumers
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
- Static imports of server-only modules (pg, influxdb-client, subscription-service, stats-cache) in server function files — use dynamic `await import()` inside handlers

## Quick Reference

| Need | Solution |
|------|----------|
| Style component | TailwindCSS classes |
| Server logic (non-streaming) | `createServerFn()` + middleware |
| Real-time streaming | SSE route in `src/routes/api/` |
| Consume SSE stream | `useStreamingData` hook (tables) or `useSSE` hook (other) |
| New streaming table | CSS Grid + `useWindowVirtualizer` + `useStreamingData` |
| Import from src | `@/path/to/file` |
| Test file location | `__tests__/filename.test.ts` |
| Run tests | `bun test` |
| Check TypeScript types | `bun run typecheck` |
| Type validation | Zod schema |
