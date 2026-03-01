# Project Guidelines for Claude

## Workflow

**Start of every conversation:**
- ALWAYS read this file (`CLAUDE.md`) first to get up-to-date project context and guidelines.

**End of every task:**
- Check if `README.md` and `CLAUDE.md` need updates (architecture changes, file organization, commands, testing, tech stack).
- Run `bun run typecheck` to verify TypeScript types are correct.
- Run tests with `bun test` after code changes.

## Critical Rules

1. **Styling**: TailwindCSS ONLY. Never use MUI `sx` props or create `.css` files (exceptions: `App.css` for chart colors/animations, `theme.ts` for MUI theme). Inline `style` only when Tailwind cannot express the value (virtualizer positioning, dynamic indent, computed transforms). Never use hardcoded hex colors — use theme CSS variables.
2. **Imports**: Always use `@/` for src files (e.g., `@/components/Header`). Relative paths only within `__tests__/`. Never mix both in one file (except tests).
3. **Server Functions**: All server logic via `createServerFn()` + middleware injection. Never create clients directly.
4. **Dynamic Imports**: ALWAYS use `await import()` for server-only modules (pg, subscription-service, database-client) inside SSE handlers and server functions. Static imports leak into the client bundle and break the app.
5. **SSE Pattern**: TanStack Router server routes (`src/routes/api/`) → `useTimeSeriesStream` hook → CSS Grid + `useWindowVirtualizer`. Server handles client disconnect via `request.signal`.
6. **File Creation**: PREFER editing existing files over creating new ones. Only create files when genuinely necessary.
7. **Testing**: Tests in `__tests__/` folders co-located with source. Use `bun:test` imports. 95% functions / 99% lines coverage threshold enforced.
8. **No Logging**: No `console.log` in committed code. Only `console.error` for actual errors. Remove all debug logging before completing a task.

## Tech Stack

- **Framework:** TanStack Start (SPA mode, SSR disabled)
- **Runtime:** Bun 1.3.6 (pinned in `.bun-version`; package manager, test runner, runtime)
- **Language:** TypeScript (strict mode, `noUnusedLocals`, `noUnusedParameters`) + React 19
- **UI:** MUI Material UI v7 (components) + TailwindCSS v4 (styling, via `@tailwindcss/vite` plugin — no config file)
- **Routing:** TanStack Router (file-based, auto-generated `routeTree.gen.ts`)
- **State:** Jotai (settings atoms) + TanStack Query (QueryClient singleton in `AppShell.tsx`)
- **Streaming:** Server-Sent Events (SSE) via TanStack Router server routes (`src/routes/api/`)
- **Charts:** Apache ECharts
- **Clients:** Dockerode (Docker API), ssh2 (SSH), pg (PostgreSQL), native fetch (Proxmox)
- **Database:** TimescaleDB (PostgreSQL 16 with wide hypertables, automatic compression)
- **Background Worker:** Standalone Bun process for continuous data collection
- **Validation:** Zod
- **Testing:** Bun test (`bun:test`) with Happy-DOM + Testing Library
- **Deployment:** Docker Compose (multi-container) → GHCR images via CI

## Commands

### Development (Local - Recommended)
```bash
# Terminal 1: Start Docker services (postgres + worker)
bun run dev:local:up        # Start database and worker in Docker

# Terminal 2: Run web app locally
bun dev                     # Start web server on port 3000 with HMR

# Management
bun run dev:local:down      # Stop Docker services
bun run dev:local:restart   # Restart Docker services
bun run dev:local:rebuild   # Rebuild and restart Docker services
bun run dev:local:wipe      # Remove all data (fresh database)
bun run dev:local:logs      # View all Docker logs
bun run dev:local:logs:worker   # View worker logs only
bun run dev:local:logs:db   # View database logs only
```

### Development (Full Docker with HMR)
```bash
bun dev:docker:up           # Start all services in Docker
bun dev:docker:down         # Stop all Docker services
bun dev:docker:rebuild      # Full rebuild of all containers
bun dev:docker:wipe         # Remove all data (fresh database)
```

### Testing & Build
```bash
bun run typecheck           # TypeScript type checking
bun test                    # Run all tests (enforces 95%/99% coverage)
bun test --watch            # Watch mode
bun run test:coverage       # Run tests with coverage report
bun run test:coverage:check # Run tests and enforce 95%/99% coverage threshold
```

### Production Build
```bash
bun build                   # Production build (runs typecheck first)
bun worker                  # Run background collector locally
bun icons:download          # Download dashboard icons from homarr-labs/dashboard-icons
```

### Docker Compose (Production)
```bash
docker compose up -d        # Start all services
docker compose down         # Stop all services
docker compose logs -f web  # View web server logs
```

## File Organization

```text
src/
├── components/
│   ├── shared-table/        # MetricValue, MetricHeader (shared column infrastructure)
│   ├── docker/              # ContainerTable, ContainerRow, ContainerHistoryPage, charts
│   ├── zfs/                 # ZFSPoolsTable, ZFSPoolSpeedCharts
│   ├── proxmox/             # ClusterSummaryCards, ProxmoxHostView, GuestSection, StorageSection
│   └── [AppShell, Header, ModeToggle, ThemeProvider]
├── hooks/                   # useSSE, useTimeSeriesStream, useSettings, settingsAtom, useSettingsSync, toastAtom
├── data/                    # Server functions (*.functions.tsx) - non-streaming DB queries
├── middleware/              # Connection injection factories (Docker, SSH — env-based + config-based)
├── lib/
│   ├── clients/             # Singleton connection managers (Docker, SSH, Database, Proxmox)
│   ├── config/              # Zod-validated config loaders (database, docker, worker, zfs, proxmox)
│   ├── constants/           # SETTINGS_KEYS (canonical DB key definitions used across frontend + backend)
│   ├── charts/              # Chart utilities (css-vars.ts color resolution, y-axis.ts scaling)
│   ├── database/
│   │   ├── repositories/    # StatsRepository (wide table CRUD), SettingsRepository (KV + NOTIFY)
│   │   ├── subscription-service.ts  # StatsPollService (shared 1s poll, broadcast to SSE clients)
│   │   └── migrate.ts       # Sequential SQL migration runner
│   ├── parsers/             # ZFSIOStatParser (indentation-based hierarchy detection)
│   ├── settings/            # SettingsBroadcastService (PostgreSQL LISTEN/NOTIFY → SSE)
│   ├── streaming/types.ts   # Core interfaces (StreamingClient, StreamParser, RateCalculator)
│   ├── test/                # Test utilities: Happy-DOM setup, Testing Library setup, stream helpers
│   ├── utils/               # Hierarchy builders, rate calculators, row converters, Proxmox overview converter/builder, abortable-sleep
│   └── server-init.ts       # Idempotent server startup + graceful shutdown handlers
├── worker/
│   ├── collectors/          # BaseCollector (AsyncDisposable, backoff) + Docker/ZFS/Proxmox collectors
│   └── collector.ts         # Worker entry point (AsyncDisposableStack, AbortController)
├── types/                   # Domain types (docker.ts, zfs.ts, proxmox.ts, settings.ts)
├── formatters/              # Display formatting (binary units, SI units, percent — dual output: string + parts)
└── routes/
    ├── api/                 # SSE endpoints (docker-stats, zfs-stats, proxmox-stats, settings)
    └── [index, docker.$containerId, zfs, proxmox, settings].tsx

migrations/                  # Sequential SQL migrations (TimescaleDB hypertables, settings, compression)
scripts/                     # check-coverage.js (95%/99% enforcer), download-icons.ts
```

## Architecture Patterns

### Routing
- **Never edit** `routeTree.gen.ts` (auto-generated by TanStack Router).
- Root route (`__root.tsx`) has ONLY `shellComponent` (plain HTML). NO `component` prop — adding MUI/React components here breaks SSR.
- Client-side layout lives in `AppShell.tsx`. Each page route wraps content with `<AppShell>`.
- All routes: `ssr: false` (SPA mode).

### Data Flow

```text
Worker → Docker/ZFS/Proxmox APIs → INSERT wide rows → TimescaleDB
                                                            ↓
Browser → Server (SSE) ← StatsPollService (1s poll) → Query DB → Broadcast to all clients
```
- **Frontend reads from database**, not direct API/SSH connections.
- Worker collects stats → INSERT wide rows into TimescaleDB.
- Server runs shared `StatsPollService` that polls DB every 1s per source — only 1 query/sec regardless of client count.
- Frontend preloads history via REST server function, then merges SSE updates.
- **All sources use the same architecture**: Docker, ZFS, and Proxmox all flow through worker → TimescaleDB → StatsPollService → SSE → `useTimeSeriesStream`.

### SSE Endpoints
All SSE endpoints in `src/routes/api/` follow the same pattern:
1. Use `createFileRoute` with `server.handlers.GET`
2. Dynamic import server-init + poll service (prevents client bundling)
3. Create `ReadableStream`, subscribe to poll service
4. On `request.signal` abort: unsubscribe + close controller
5. Track `closed` flag to prevent enqueue-after-close errors

```typescript
// ALWAYS use dynamic imports for server-only modules in SSE endpoints:
// BAD - gets bundled into client
import { statsPollService } from '@/lib/database/subscription-service';
// GOOD - only loaded on server at runtime
const { statsPollService } = await import('@/lib/database/subscription-service');
```

### Virtualized Tables (Docker & ZFS)
1. Page route uses `useTimeSeriesStream` hook (preload + SSE merge + time-windowed buffer)
2. Pass `latestByEntity` (Map) and `rows` (sorted array) to table component
3. Table converts wide rows → domain objects → `FlatRow[]` discriminated union
4. Render with CSS Grid columns + `useWindowVirtualizer` (page-scroll virtualization)
5. Row components are div-based (not `<table>/<tr>/<td>`) for virtualizer compatibility

### Database Schema (TimescaleDB)
- `docker_stats` — hypertable: time, host, container_id, container_name, image, cpu_percent, memory_usage, memory_limit, memory_percent, network_rx/tx, block_io_read/write
- `zfs_stats` — hypertable: time, host, pool, entity, entity_type, indent, capacity_alloc/free, read/write_ops_per_sec, read/write_bytes_per_sec, utilization_percent
- `proxmox_stats` — hypertable: time, host, entity_type (cluster/node/qemu/lxc/storage), node, entity_id, entity_name, status, cpu, max_cpu, mem, max_mem, disk, max_disk, uptime, vmid, netin, netout, storage_type, storage_content, storage_avail, storage_shared, cluster_version
- `entity_metadata` — key-value metadata per entity (icons, labels)
- `settings` — application settings (key-value with `NOTIFY settings_change` trigger)
- **Compression**: Automatic after 7 days (segmented by host/entity identifiers)
- **Retention**: Infinite (compression keeps storage manageable at homelab scale)

### Background Worker
- Standalone Bun process (`bun worker`), independent from web server
- **Collectors** extend `BaseCollector` (implements `AsyncDisposable`): `name`, `collect()`, `isConfigured()`
- `BaseCollector` handles: collection loop, exponential backoff (max 32s), graceful shutdown via `AbortController`
- Worker entry point uses `AsyncDisposableStack` + `await using` for deterministic cleanup
- Docker collector: keeps stats streams open continuously, flushes every 1s, reconnects on container changes
- ZFS collector: streams `zpool iostat` continuously via SSH, flushes on cycle boundary
- Proxmox collector: polls Proxmox REST API at configurable interval (1s/10s), converts overview to flat rows via `overviewToRows()`, inserts into `proxmox_stats`
- Rate calculators are persistent (never cleared, unlike request-scoped ones)

### Entity ID Convention
- **Docker**: `${host}/${container_id}` (e.g., `192.168.1.10/abc123`)
- **ZFS**: `${host}/${pool}/${vdev}/${disk}` with depth encoding hierarchy (e.g., `server1/tank/mirror-0/sda`)
- **Proxmox**: `entity_id` varies by type: cluster name, node name, vmid (guests), `${node}/${storage}` (storages)
- **Always use entity IDs (with host prefix) for state keys**, never display names. Display names like "tank" are not unique across hosts.
- ZFS hierarchy is encoded by indentation: 0=pool, 2=vdev, 4+=disk

### Multi-Host Configuration
- Docker and ZFS support numbered env vars: `DOCKER_HOST_1`, `DOCKER_HOST_2`, `ZFS_HOST_1`, `ZFS_HOST_2`, etc.
- Config loaders in `src/lib/config/` validate with Zod and parse numbered groups
- Host rows shown in UI only when multiple hosts are configured
- Single-item collections always show expanded (no collapse button if only one host)

### Styling
- **TailwindCSS v4** via `@tailwindcss/vite` plugin (no `tailwind.config` file — configured in `App.css` with `@import "tailwindcss"`)
- **MUI Material UI theme** (`src/theme.ts`): `cssVariables` mode with `colorSchemeSelector: '[data-color-scheme="%s"]'`
- Custom background properties: `chartBg`, `level1`, `level2`, `level3`, `popup` (via TypeScript module augmentation on `TypeBackground`)
- Reference theme colors in Tailwind: `bg-[var(--mui-palette-background-chartBg)]`
- **MUI emotion specificity**: MUI's emotion styles inject after Tailwind at equal specificity. Use Tailwind's `!` prefix to force override: `!bg-[var(--mui-palette-background-chartBg)]`
- Chart CSS variables (`--chart-cpu`, `--chart-memory`, `--chart-read`, `--chart-write` + area gradients) defined in `App.css`
- Glow animations for value-change indicators also in `App.css`

### State Management
- **Settings**: Jotai atoms (`rawSettingsAtom` → derived `settingsAtom`) synced via SSE (`/api/settings`)
  - `useSettings()` hook: settings + optimistic setters (local update → fire-and-forget DB persist → rollback on error + toast)
  - `useSettingsSync()` hook (in AppShell): SSE stream → Jotai atom bridge
  - `SettingsBroadcastService`: PostgreSQL `NOTIFY settings_change` → SSE broadcast to all clients
  - Settings keys defined in `src/lib/constants/settings-keys.ts` (canonical source used across frontend + backend)
  - Expansion state for all dashboards persisted as JSON-serialized `Set<string>` arrays
- **Transient atoms**: `proxmoxLastUpdateAtom` decouples update indicator from data components (avoids prop-drilling re-renders)
- `QueryClient` is a singleton in `AppShell.tsx` — never create per-route

### Testing
- Test files: `__tests__/` folders co-located with source, named `*.test.ts` or `*.test.tsx`
- Test utilities: `src/lib/test/` (Happy-DOM setup, Testing Library setup, stream helpers) — NOT in `__tests__/`
- Use `bun:test` imports: `import { describe, it, expect, mock, beforeEach } from 'bun:test'`
- Test preloads configured in `bunfig.toml`: Happy-DOM + Testing Library matchers
- **Coverage requirements:** 95% functions, 99% lines — enforced by `scripts/check-coverage.js` piped from `bun test --coverage`
- **Avoid `mock.module()` for React or broadly-used modules** — it pollutes globally across concurrent test execution in `bun:test`. Use `renderHook` from Testing Library, dependency injection, or narrow-scope mocks instead.
- Some hook tests skip in CI due to React 19 + Happy-DOM compatibility issues (guarded by `process.env.CI`)

### Imports
- **Always use `@/` for project imports**: `import { Header } from '@/components/Header'`
- Relative paths OK for test imports in `__tests__/`: `import { foo } from '../foo'`
- Never mix `@/` and relative in the same file (except tests)

## Gotchas (Learned from Past Sessions)

These are non-obvious pitfalls that have caused bugs or reverts in past sessions:

1. **BIGINT string coercion**: PostgreSQL `BIGINT` columns return strings via node-postgres, not numbers. Always wrap with `Number()` in row converters. Without this, arithmetic becomes string concatenation.

2. **Dynamic imports are mandatory**: Static imports of `pg`, `subscription-service`, `database-client`, or any server-only module in SSE endpoints or server function files leak into the client bundle. This breaks the app with `node:async_hooks` errors in the browser. Always use `await import()` inside handler functions.

3. **Never add framework packages to `optimizeDeps.include`**: Adding `@tanstack/react-start` to Vite's `optimizeDeps.include` pulls `@tanstack/start-storage-context` (which uses `node:async_hooks`) into the client bundle.

4. **Stable ordering from Maps**: Map iteration order is insertion-order, not sorted. Always sort data derived from Maps before rendering to prevent layout shift and confusing reordering of containers/pools between updates.

5. **Entity IDs vs display names**: Use entity IDs (which include host prefix, e.g., `server1/tank`) for expansion state keys and all uniqueness checks. Using display names (e.g., `tank`) causes cross-host collisions where expanding a pool on one host expands the same-named pool on another.

6. **PostgreSQL extended query protocol**: Parameterized queries (INSERT with `$1, $2`) use the extended query protocol which doesn't support multi-statement execution. INSERT and NOTIFY must be separate `client.query()` calls.

7. **MUI emotion vs Tailwind specificity**: MUI's emotion-generated styles inject after Tailwind's styles in the DOM. At equal specificity, MUI wins. Use Tailwind's `!` prefix (e.g., `!bg-[var(...)]`) to override MUI defaults like Paper's `background-color`.

8. **React.memo with streaming data**: Incorrect memoization can freeze streaming data updates. Be cautious with `React.memo` on components that receive frequently-changing props like `latestByEntity` or `rows`.

9. **Layout shift in metric columns**: Dynamic number formatting (changing units like KB→MB, varying decimal places) causes column width instability. Use minimum widths with `ch` units in MetricValue to reserve space.

10. **`mock.module()` test pollution**: `bun:test` runs tests concurrently. `mock.module()` on React or widely-imported modules (like component imports) pollutes globally, causing other test files to receive mocked versions. Prefer `renderHook`, spies on specific functions, or dependency injection.

11. **Root route is SSR-only**: Putting MUI components or React hooks in `__root.tsx`'s `component` prop breaks SSR. Only `shellComponent` (plain HTML: `<HeadContent />`, `<Scripts />`) is safe. All client-side layout goes in `AppShell.tsx`.

12. **Icon attribution**: Dashboard icons are from `homarr-labs/dashboard-icons` (NOT `walkxcode/dashboard-icons` — that's the old repo name that redirects).

13. **Fix root causes, not symptoms**: When data appears wrong or the UI misbehaves, investigate the actual source of the bug rather than adding caching, memoization, or frontend workarounds. Past band-aid fixes were frequently reverted.

## Environment Variables

All env vars documented in `.env.example`. Key groups:
- `POSTGRES_*`: Database connection (host, port, db, user, password, ssl, pool_size)
- `DOCKER_HOST_N` / `DOCKER_HOST_PORT_N` / `DOCKER_HOST_NAME_N`: Multi-host Docker (numbered 1-3)
- `ZFS_HOST_N` / `ZFS_HOST_PORT_N` / `ZFS_HOST_USER_N` / `ZFS_HOST_KEY_PATH_N`: Multi-host ZFS via SSH (numbered 1-3)
- `PROXMOX_HOST` / `PROXMOX_PORT` / `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` / `PROXMOX_ALLOW_SELF_SIGNED`: Proxmox VE API
- `WORKER_ENABLED` / `WORKER_DOCKER_ENABLED` / `WORKER_ZFS_ENABLED` / `WORKER_PROXMOX_ENABLED` / `WORKER_COLLECTION_INTERVAL_MS`: Worker config

`.env` sets `POSTGRES_HOST=localhost` for local web dev; Docker services override to `postgres` (internal DNS) in compose files.

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
- All changes to `main` go through a pull request — direct pushes blocked.
- PRs require passing CI (build, test, coverage, license check).
- PRs by `jaredglaser` or `claude[bot]` get automatic Claude code review on `ready_for_review`.

### GitHub Actions Workflows

| Workflow | File | Triggers |
|----------|------|----------|
| **CI** | `.github/workflows/ci.yml` | Push to `main`, PRs targeting `main` |
| **Claude PR Review** | `.github/workflows/claude-code-review.yml` | PRs targeting `main` (ready_for_review) |
| **Claude Code** | `.github/workflows/claude.yml` | `@claude` mentions in issues/PRs |

CI publishes Docker images to GHCR: `ghcr.io/jaredglaser/homelab-manager-web` and `ghcr.io/jaredglaser/homelab-manager-worker`.

## Anti-Patterns (DO NOT)

- MUI `sx` props or hardcoded hex colors for styling (use Tailwind + theme CSS variables)
- Creating `.css` files (use Tailwind; exceptions: `App.css`, `theme.ts`)
- Manual edits to `routeTree.gen.ts` (auto-generated)
- Adding `component` to root route (breaks SSR — use `shellComponent` only)
- Creating QueryClient per route (singleton in `AppShell.tsx` only)
- Creating clients directly in server functions (use middleware injection)
- Static imports of server-only modules in SSE/server function files (use dynamic `await import()`)
- Using TanStack Start streaming server functions for real-time data (use SSE routes — proper disconnect handling)
- HTML `<table>/<tr>/<td>` for streaming tables (use CSS Grid divs + virtualizer)
- `console.log` in committed code (use `console.error` for actual errors only)
- `mock.module()` on React or broadly-used modules in tests (causes global pollution)
- Adding `@tanstack/react-start` or similar framework packages to Vite `optimizeDeps.include`
- Using display names instead of entity IDs for state keys
- Dashboard wrapper components (layout goes in AppShell, content in page routes)

## Quick Reference

| Need | Solution |
|------|----------|
| Style component | TailwindCSS classes (never `sx` props) |
| Override MUI default style | `!` prefix: `!bg-[var(--mui-palette-...)]` |
| Server logic (non-streaming) | `createServerFn()` + middleware |
| Real-time streaming | SSE route in `src/routes/api/` |
| Consume SSE (time-series) | `useTimeSeriesStream` hook (Docker, ZFS, Proxmox) |
| Consume SSE (snapshot) | `useSSE` hook (e.g., settings) |
| New streaming table | CSS Grid + `useWindowVirtualizer` + `useTimeSeriesStream` |
| Settings key constant | `src/lib/constants/settings-keys.ts` |
| Chart color CSS variable | `App.css` (`--chart-cpu`, `--chart-memory`, etc.) |
| Chart axis/color utilities | `src/lib/charts/` (css-vars.ts, y-axis.ts) |
| Import from src | `@/path/to/file` |
| Test file location | `__tests__/filename.test.ts` (co-located) |
| Test utilities | `src/lib/test/` (NOT in `__tests__/`) |
| Run tests | `bun test` (95%/99% coverage enforced) |
| Type check | `bun run typecheck` |
| Type validation | Zod schema |
| BIGINT from PostgreSQL | Wrap with `Number()` in row converters |
