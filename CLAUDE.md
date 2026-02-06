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
4. **Streaming Pattern**: Server functions → `useServerStream` → `StreamingTable`. Never use raw `useEffect` + `for await`.
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
- **Streaming:** Server functions via `createServerFn()` with async generators
- **Clients:** Dockerode (Docker API), ssh2 (SSH), pg (PostgreSQL)
- **Database:** PostgreSQL 16 (generic EAV time-series schema with progressive downsampling)
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
bun run test:coverage:check # Run tests and enforce 90% coverage threshold
```

### Background Worker & Database
```bash
bun worker                  # Run background collector (Docker + ZFS stats)
bun cleanup                 # Run daily downsampling/cleanup job
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
docker compose -f docker-compose.dev.yml up -d    # Start with HMR + volume mounts
docker compose -f docker-compose.dev.yml down      # Stop dev services
docker compose -f docker-compose.dev.yml logs -f web  # View dev web logs
```

## File Organization

```
src/
├── components/
│   ├── shared-table/        # StreamingTable, MetricCell (shared infrastructure)
│   ├── docker/              # Docker-specific components
│   ├── zfs/                 # ZFS-specific components
│   └── [AppShell, Header, ModeToggle, ThemeProvider]
├── hooks/                   # Custom hooks (useServerStream, etc.)
├── data/                    # Server functions (*.functions.tsx) - DB-backed streaming
├── middleware/              # Connection injection (Docker, SSH, Database)
├── lib/
│   ├── __tests__/           # Unit tests (*.test.ts)
│   ├── cache/               # Stats cache singleton (shared across connections)
│   ├── clients/             # Connection managers (Docker, SSH, Database)
│   ├── config/              # Configuration loaders (database, worker)
│   ├── database/
│   │   ├── repositories/    # Data access layer (generic StatsRepository)
│   │   ├── subscription-service.ts  # PostgreSQL LISTEN/NOTIFY handler
│   │   └── migrate.ts       # Database migration runner
│   ├── parsers/             # Stream parsers
│   ├── test/                # Test utilities (NOT in __tests__)
│   ├── transformers/        # DB rows → domain objects (Docker, ZFS)
│   ├── utils/               # Rate calculators, hierarchy builders
│   ├── streaming/types.ts   # Core interfaces
│   └── server-init.ts       # Server-side shutdown handlers
├── worker/
│   ├── collectors/          # Background collectors (Docker, ZFS)
│   ├── collector.ts         # Worker entry point
│   └── cleanup.ts           # Daily downsampling script
├── types/                   # Domain types (docker.ts, zfs.ts)
├── formatters/              # Display formatting (metrics, numbers)
└── routes/                  # TanStack Router pages

migrations/                  # SQL migrations (001_initial_schema.sql, etc.)
```

## Architecture Patterns

### Routing
- **Never edit** `routeTree.gen.ts` (auto-generated by TanStack Router).
- Root route (`__root.tsx`) has ONLY `shellComponent` (plain HTML). NO `component` prop — SSR breaks MUI Joy.
- Client-side layout lives in `AppShell.tsx`. Each route wraps content with `<AppShell>`.
- All routes: `ssr: false` (SPA mode).

### Server Functions & Streaming
- All server logic: `createServerFn()` from `@tanstack/react-start`.
- Streaming: async generator functions (`async function*`).
- Data flow: Server function → `useServerStream` hook → `StreamingTable` component.
- **Frontend reads from database** (not direct API/SSH connections):
  - Worker collects stats → writes to PostgreSQL → sends `NOTIFY stats_update`
  - Server maintains LISTEN connection → updates shared cache on notification
  - Server functions yield from cache when notified
  - Multiple browser tabs share the same server-side cache
- **IMPORTANT: Use dynamic imports for server-only modules** in server functions:
  ```typescript
  // BAD - gets bundled into client, causes "Buffer is not defined"
  import { subscriptionService } from '@/lib/database/subscription-service';

  // GOOD - only loaded on server at runtime
  export const myServerFn = createServerFn().handler(async () => {
    const { subscriptionService } = await import('@/lib/database/subscription-service');
  });
  ```

### Streaming Data Sources (Factory Pattern)
When adding a new streaming data source:
1. Create server function (async generator)
2. Define column config
3. Create `onData` reducer (how to merge new data)
4. Create row renderer component
5. Pass all to `StreamingTable`

Rate calculators:
- Must implement `RateCalculator<TInput, TOutput>` interface (`src/lib/streaming/types.ts`)
- Use class-based calculators (not module-level functions)

### PostgreSQL Persistence & Background Workers
The frontend reads stats from the database via PostgreSQL LISTEN/NOTIFY:
```
Worker → Docker/ZFS APIs → stats_raw INSERT → NOTIFY stats_update
                                                      ↓
Browser → Server (SSE) ← LISTEN stats_update → Cache Update → yield stats
```

**Database schema** (generic EAV model):
- `stat_source` — dimension table (e.g., 'docker', 'zfs')
- `stat_type` — metric types scoped to source (e.g., 'cpu_percent', 'read_ops_per_sec')
- `stats_raw` — raw measurements (timestamp, source_id, type_id, entity, value)
- `stats_agg` — aggregated measurements (period_start, period_end, min/avg/max, sample_count, granularity)

Adding a new data source requires only a new collector — no schema changes needed.

**Architecture**:
- **Background worker**: Standalone Bun process (`bun worker`)
- **Collectors**: Class-based, extend `BaseCollector` (implements `AsyncDisposable`)
  - `BaseCollector` handles: collection loop, batch management, exponential backoff, graceful shutdown
  - Subclasses implement: `name`, `collectOnce()`, `isConfigured()`
  - Uses `AbortController` for cancellable sleeps and instant shutdown
  - Worker entry point uses `AsyncDisposableStack` + `await using` for deterministic cleanup
- **Persistent rate calculators**: Never cleared (unlike request-scoped calculators)
- **Batch writes**: Accumulate stats then write to DB via `StatsRepository`
- **Collectors convert** domain objects into `RawStatRow[]` (source, type, entity, value)
- **Shutdown**: Single `AbortController` in worker entry point, SIGTERM aborts all collectors instantly
- **Progressive downsampling**: 4-tier retention strategy
  - 0-7 days: Raw data (1-second granularity)
  - 7-14 days: Minute aggregates (min/avg/max)
  - 14-30 days: Hour aggregates (min/avg/max)
  - 30+ days: Daily aggregates (min/avg/max) - infinite retention
- **Database is ephemeral** in dev: no persistent volume, `docker compose down && up` starts fresh
- **ZFS hierarchical entity paths**: Entity names encode hierarchy for filtering
  - Pool: `"tank"` (indent 0)
  - Vdev: `"tank/mirror-0"` (indent 2)
  - Disk: `"tank/mirror-0/sda"` (indent 4+)
  - Enables visibility filtering: collapsed pool skips `tank/*` entities
- **Stale data warning**: If no NOTIFY received for 30+ seconds, UI shows warning (TanStack Query with refetchInterval)

**Key files**:
- Connection: `src/lib/clients/database-client.ts` (follows Docker/SSH pattern)
- Repository: `src/lib/database/repositories/stats-repository.ts` (generic, caches dimension IDs, NOTIFY after insert)
- Base collector: `src/worker/collectors/base-collector.ts` (AsyncDisposable, batch management, backoff)
- Collectors: `src/worker/collectors/` (Docker, ZFS — extend `BaseCollector`)
- Abortable sleep: `src/lib/utils/abortable-sleep.ts` (cancellable sleep utility)
- Migrations: `migrations/*.sql` (generic schema + downsampling functions)
- Cleanup: `src/worker/cleanup.ts` (daily downsampling job)
- **Stats cache**: `src/lib/cache/stats-cache.ts` (singleton, shared across frontend connections)
- **Subscription service**: `src/lib/database/subscription-service.ts` (LISTEN handler, updates cache on NOTIFY)
- **Transformers**: `src/lib/transformers/` (convert DB rows to domain objects)
- **Server init**: `src/lib/server-init.ts` (graceful shutdown handlers)

**Environment variables**:
- `POSTGRES_*`: Database connection config
- `WORKER_*`: Worker behavior config (enabled, batch size, intervals)

### Components
- Shared table infrastructure: `src/components/shared-table/` (MetricCell, StreamingTable)
- Domain components: own directories (`docker/`, `zfs/`)
- Extract repeated patterns into reusable components (e.g., `ZFSMetricCells`)
- NO dashboard wrapper components — `StreamingTable` handles title + sheet + table + loading/error

### Styling
- **TailwindCSS only** for all layout and styling
- Never use MUI `sx` props (use Tailwind: `p-3` not `sx={{ p: 3 }}`)
- Never use inline `style` attribute
- Never create `.css` files (exception: Joy UI theme in `theme.ts`)

### State Management
- `QueryClient` is a singleton in `__root.tsx` — never create per-route
- Use `useServerStream` for consuming streaming server functions
- Never duplicate streaming logic with raw `useEffect` + `for await`

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
- PRs by `jaredglaser` or `claude[bot]` receive an automatic Claude code review via the `claude-code-review.yml` workflow.

### GitHub Actions Workflows
| Workflow | File | Triggers |
|----------|------|----------|
| **CI** | `.github/workflows/ci.yml` | Push to `main`, PRs targeting `main` |
| **Claude PR Review** | `.github/workflows/claude-code-review.yml` | PRs targeting `main` (opened, synchronize, ready_for_review, reopened) |
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
- Raw `useEffect` + `for await` (use `useServerStream`)
- Dashboard wrapper components (use `StreamingTable`)
- Test files outside `__tests__/` folders
- `console.log` in committed code
- Logging sensitive data
- Static imports of server-only modules (pg, subscription-service, stats-cache) in server function files — use dynamic `await import()` inside handlers

## Quick Reference

| Need | Solution |
|------|----------|
| Style component | TailwindCSS classes |
| Server logic | `createServerFn()` + middleware |
| Consume stream | `useServerStream` hook |
| New streaming table | `StreamingTable` factory |
| Import from src | `@/path/to/file` |
| Test file location | `__tests__/filename.test.ts` |
| Run tests | `bun test` |
| Check TypeScript types | `bun run typecheck` |
| Type validation | Zod schema |
