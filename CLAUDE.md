# Project Guidelines for Claude

## Workflow

**End of every task:**
- Run `bun run typecheck` and `bun test` after code changes.
- Check if `README.md` and `CLAUDE.md` need updates.

## Commands

```bash
# Development (local web + Docker services)
bun run dev:local:up          # Start postgres + worker in Docker
bun dev                       # Start web server on port 3000 with HMR
bun run dev:local:down        # Stop Docker services
bun run dev:local:rebuild     # Rebuild and restart Docker services

# Testing & Build
bun run typecheck             # TypeScript type checking
bun test                      # Run all tests (enforces 95%/99% coverage)
bun build                     # Production build (runs typecheck first)
bun run build:demo            # Demo build (no server required, mock data)
bun worker                    # Run background collector locally
bun icons:download            # Download dashboard icons from homarr-labs/dashboard-icons
```

## Critical Rules

1. **Styling**: TailwindCSS ONLY. Never use MUI `sx` props or create `.css` files (exceptions: `App.css`, `theme.ts`). Inline `style` only when Tailwind cannot express the value (virtualizer positioning, dynamic indent, computed transforms). Never use hardcoded hex colors - use theme CSS variables. To override MUI defaults, use Tailwind's `!` prefix: `!bg-[var(--mui-palette-background-chartBg)]`.
2. **Imports**: Always use `@/` for src files. Relative paths only within `__tests__/`. Never mix both in one file (except tests).
3. **Server Functions**: All server logic via `createServerFn()` + middleware injection. Never create clients directly in server functions.
4. **Dynamic Imports**: ALWAYS use `await import()` for server-only modules (pg, subscription-service, database-client) inside SSE handlers and server functions. Static imports leak into the client bundle and break the app with `node:async_hooks` errors.
5. **SSE Pattern**: TanStack Router server routes (`src/routes/api/`) → `useTimeSeriesStream` hook → CSS Grid + `useWindowVirtualizer`. Use div-based rows (not `<table>/<tr>/<td>`). Server handles client disconnect via `request.signal`. Never use TanStack Start streaming server functions for real-time data.
6. **File Creation**: PREFER editing existing files over creating new ones.
7. **Testing**: Tests in `__tests__/` folders co-located with source. Test utilities in `src/lib/test/` (NOT in `__tests__/`). Use `bun:test` imports. 95% functions / 99% lines coverage enforced. Avoid `mock.module()` on React or broadly-used modules - it pollutes globally across concurrent tests. Use `renderHook`, dependency injection, or narrow-scope mocks instead.
8. **Logging**: Be purposeful with console methods. Use `console.error` for actual errors, `console.info` for operational messages (startup, shutdown), and `console.log` sparingly for temporary debugging only (do not commit). No drive-by `console.log` statements in committed code.
9. **Routing**: Never edit `routeTree.gen.ts` (auto-generated). `AppShell` renders in root layout (`__root.tsx`) - never wrap individual routes with it. All routes use `ssr: false`. QueryClient is a singleton in `AppShell.tsx` - never create per-route.
10. **Entity IDs**: Always use entity IDs with host prefix (e.g., `server1/tank`, `192.168.1.10/abc123`) for state keys and uniqueness checks. Never use display names - they collide across hosts.

## Tech Stack

- **Framework:** TanStack Start (SPA mode, SSR disabled) + React 19
- **Runtime:** Bun (pinned in `.bun-version`; package manager, test runner, runtime)
- **Language:** TypeScript (strict mode, `noUnusedLocals`, `noUnusedParameters`)
- **UI:** MUI Material UI v7 (components) + TailwindCSS v4 (styling, via `@tailwindcss/vite` plugin - no config file)
- **State:** Jotai (settings atoms) + TanStack Query
- **Streaming:** SSE via TanStack Router server routes
- **Charts:** Apache ECharts
- **Clients:** Dockerode (Docker), ssh2 (SSH), pg (PostgreSQL), native fetch (Proxmox)
- **Database:** TimescaleDB (PostgreSQL 16, wide hypertables, auto-compression after 7 days)
- **Worker:** Standalone Bun process for continuous data collection
- **Testing:** `bun:test` with Happy-DOM + Testing Library

## Architecture

### Data Flow

```text
Worker → Docker/ZFS/Proxmox APIs → INSERT wide rows → TimescaleDB
                                                            ↓
Browser → Server (SSE) ← StatsPollService (1s poll) → Query DB → Broadcast
```

- Frontend reads from database, not direct API/SSH connections.
- All three sources (Docker, ZFS, Proxmox) use identical architecture: worker → TimescaleDB → StatsPollService → SSE → `useTimeSeriesStream`.
- Frontend preloads history via REST server function, then merges SSE updates.

### SSE Endpoints (`src/routes/api/`)

Pattern: `createFileRoute` with `server.handlers.GET` → dynamic import server-init + poll service → `ReadableStream` + subscribe → cleanup on `request.signal` abort. Track `closed` flag to prevent enqueue-after-close.

```typescript
// ALWAYS dynamic import - static imports break the client bundle:
const { statsPollService } = await import('@/lib/database/subscription-service');
```

### Key Patterns

- **Styling**: TailwindCSS v4 configured in `App.css` with `@import "tailwindcss"`. MUI theme in `src/theme.ts` uses `cssVariables` mode. Custom backgrounds: `chartBg`, `level1-3`, `popup`. Chart CSS vars (`--chart-cpu`, `--chart-memory`, etc.) in `App.css`.
- **Settings**: Jotai atoms synced via SSE (`/api/settings`). `useSettings()` provides optimistic setters. Keys in `src/lib/constants/settings-keys.ts`. PostgreSQL `NOTIFY settings_change` broadcasts to all clients.
- **Multi-host**: Docker/ZFS use numbered env vars (`DOCKER_HOST_1`, `ZFS_HOST_1`, etc.). Host rows shown only when multiple hosts configured.
- **Demo mode**: `VITE_DEMO_MODE=true` swaps server functions via Vite aliases and patches `EventSource`. Zero changes to routes/hooks/components. Mock entities defined in `src/lib/mock/entities.ts`.
- **Worker**: Collectors extend `BaseCollector` (AsyncDisposable, exponential backoff). Entry point uses `AsyncDisposableStack` for cleanup.
- **Entity IDs**: Docker=`host/container_id`, ZFS=`host/pool/vdev/disk` (hierarchy via indent: 0=pool, 2=vdev, 4+=disk), Proxmox=varies by type.

### Database Tables

Hypertables: `docker_stats`, `zfs_stats`, `proxmox_stats`. Plus `entity_metadata` (icons/labels) and `settings` (KV with NOTIFY trigger). Schema details in `migrations/`.

## Gotchas

Non-obvious pitfalls from past sessions (not restated from rules above):

1. **BIGINT string coercion**: PostgreSQL `BIGINT` returns strings via node-postgres. Always wrap with `Number()` in row converters or arithmetic becomes string concatenation.
2. **Never add framework packages to `optimizeDeps.include`**: Adding `@tanstack/react-start` pulls `node:async_hooks` into the client bundle.
3. **Stable ordering from Maps**: Map iteration is insertion-order, not sorted. Always sort data from Maps before rendering to prevent layout shift.
4. **PostgreSQL extended query protocol**: Parameterized queries use extended protocol which doesn't support multi-statement. INSERT and NOTIFY must be separate `client.query()` calls.
5. **React.memo with streaming data**: Incorrect memoization freezes streaming updates. Be cautious with `React.memo` on components receiving `latestByEntity` or `rows`.
6. **Layout shift in metric columns**: Dynamic number formatting (KB→MB, varying decimals) causes width instability. Use minimum widths with `ch` units in MetricValue.
7. **Fix root causes, not symptoms**: Investigate actual bugs rather than adding caching/memoization workarounds. Past band-aid fixes were frequently reverted.
8. **Icon attribution**: Dashboard icons from `homarr-labs/dashboard-icons` (NOT the old `walkxcode` name).
9. **Hook tests in CI**: Some skip due to React 19 + Happy-DOM issues (guarded by `process.env.CI`).

## CI/CD

All changes to `main` via PR. CI runs build, test, coverage, license check. Docker images published to GHCR.
Env vars documented in `.env.example`. `.env` sets `POSTGRES_HOST=localhost` for local dev; Docker overrides to `postgres`.
