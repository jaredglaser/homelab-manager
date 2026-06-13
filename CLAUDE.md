# Project Guidelines for Claude

## Workflow

**End of every task:**
- Run `bun run typecheck:all` and `bun run test:all` after code changes (covers homelab-manager + agent).
- Check if `README.md` and `CLAUDE.md` need updates.

**First-time setup / dependency changes:**
- Run `bun run setup` (installs homelab-manager and agent). The agent is NOT a workspace member; its lockfile is independent so the docker build (`context: ./agent`) stays self-consistent.
- Always pin dependencies to an exact version (no `^` or `~`). All existing entries in `package.json` are pinned; new additions must follow the same pattern.

**After editing files:**
- When `<new-diagnostics>` appear with SonarQube issues on files you just edited, fix them before moving on. Only fix issues on files you modified, do not touch unrelated files.

**PR stacks:**
- Work through stacked PRs linearly (main→PR1→PR2→PR3→…); never skip steps when rebasing; propagate lower-stack changes upward.
- Always target the correct base branch; never target `main` for a mid-stack PR.

**Coverage verification:**
- Coverage percentages differ between local and CI (some tests skip in CI). Use `gh run view` or `gh pr checks` to verify pipeline results, not just local `bun test`.

## Commands

```bash
# Development (local web + Docker services)
bun run dev:local:up          # Start postgres + worker + agent in Docker (requires MASTER_KEY or MASTER_KEY_FILE)
bun dev                       # Start web server on port 3000 with HMR
bun run dev:local:down        # Stop Docker services
bun run dev:local:restart      # Recreate containers (picks up .env changes)
bun run dev:local:rebuild     # Full rebuild (no cache) and restart
bun run dev:local:wipe        # Stop Docker services and delete volumes
bun run dev:local:logs        # Tail all Docker service logs
bun run dev:local:logs:worker # Worker logs only
bun run dev:local:logs:agent  # Agent logs only
bun run dev:local:logs:db     # Postgres logs only

# Setup
bun run setup                 # Install homelab-manager and agent

# Testing & Build (homelab-manager only)
bun run typecheck             # TypeScript type checking
bun test --isolate            # Run all tests (--isolate required: module mocks leak across files without it)
bun run test                  # Same as above + coverage enforcement (95%/98%)
bun test --isolate --watch    # Run tests in watch mode
bun build                     # Production build (runs typecheck first)
bun run build:demo            # Demo build (no server required, mock data)
bun worker                    # Run background collector locally
bun icons:download            # Download dashboard icons from homarr-labs/dashboard-icons

# Agent-only
bun run typecheck:agent       # Agent type checking
bun run test:agent            # Agent tests (no coverage)
bun run test:coverage:agent   # Agent tests + coverage enforcement (95%/98%)

# Combined (homelab-manager + agent)
bun run typecheck:all         # Typecheck both
bun run test:all              # Run tests in both (no coverage)
bun run test:coverage:all     # Run tests in both with coverage enforcement
```

## Critical Rules

1. **Styling**: TailwindCSS ONLY. Never create `.css` files (exception: `App.css`). Inline `style` only when Tailwind cannot express the value (virtualizer positioning, dynamic indent, computed transforms). Never use hardcoded hex colors - use the design tokens in `App.css` (`bg-card`, `text-muted-foreground`, `border-border`, `bg-level1`, `bg-chart-bg`, etc.). The tokens hold literal color values (no longer aliased to `--mui-palette-*`); the dark scheme lives in `:root` and the light overrides in `[data-color-scheme="light"]`, with `useLightPaletteEffect` rewriting the background-derived light tokens per selectable palette. Color mode (light/dark) is owned by `useColorMode` (sets `data-color-scheme`, persists to localStorage), seeded before first paint by an inline script in `__root.tsx`.
2. **Imports**: Always use `@/` for src files. In test files: use `@/` for imports from outside `__tests__/`, relative paths for imports within the same `__tests__/` directory. Never mix `@/` and relative paths in non-test files.
3. **Server Functions**: All server logic via `createServerFn()` + middleware injection. Never create clients directly in server functions.
4. **Dynamic Imports**: ALWAYS use `await import()` for server-only modules (pg, subscription-service, database-client) inside SSE handlers and server functions. Static imports leak into the client bundle and break the app with `node:async_hooks` errors.
5. **SSE Pattern**: TanStack Router server routes (`src/routes/api/`) → `useTimeSeriesStream` hook → shared `DataTable` (CSS Grid + conditional `useVirtualizer`). Use div-based rows (not `<table>/<tr>/<td>`). Server handles client disconnect via `request.signal`. Never use TanStack Start streaming server functions for real-time data.
6. **File Creation**: PREFER editing existing files over creating new ones.
7. **Testing**: Tests in `__tests__/` folders co-located with source. Test utilities in `src/lib/test/` (NOT in `__tests__/`). Use `bun:test` imports. 95% functions / 98% lines coverage enforced. Test scripts run with `bun test --isolate`, so each file gets a fresh global object and `mock.module()` calls do not leak across files. Within a single file, mocks still affect every sibling test, so prefer `renderHook`, dependency injection, or narrow-scope `spyOn` when only some tests need the override. For server functions that use dynamic `await import()` inside `createServerFn` handlers, prefer mocking the underlying service module (e.g. `@/lib/stacks/stack-service`) over the barrel (`@/data/stacks/functions`) - fewer mocked exports to keep in sync as the barrel grows. When tests need `setTimeout` to fire immediately (retry loops, health checks), spy on `globalThis.setTimeout` in `beforeEach`/`afterEach` at the appropriate `describe` scope.
8. **Logging**: Be purposeful with console methods. Use `console.error` for actual errors, `console.info` for operational messages (startup, shutdown), and `console.log` sparingly for temporary debugging only (do not commit). No drive-by `console.log` statements in committed code.
9. **Routing**: Never edit `routeTree.gen.ts` (auto-generated). `AppShell` renders in root layout (`__root.tsx`) - never wrap individual routes with it. All routes use `ssr: false`. QueryClient is a singleton exported from `@/lib/query-client` and consumed by `AppShell.tsx` - never create per-route.
10. **Entity IDs**: Always use entity IDs with host prefix (e.g., `server1/tank`, `192.168.1.10/abc123`) for state keys and uniqueness checks. Never use display names - they collide across hosts.
11. **Scope discipline**: When asked to plan, research, or review, produce only that deliverable. Do not start executing unless explicitly asked. Once a direction is approved, execute without re-confirming at each step.
12. **Commit scope**: Only commit files relevant to the current task. When fixing coverage, only commit test files; don't push unrelated source changes.
13. **Verify review findings**: When resolving PR review comments, verify each finding against current code before fixing. Don't blindly apply suggestions; the code may have already changed.
14. **Comments**: Write comments that capture project-specific WHY: hidden constraints, perf invariants with real numbers (e.g. "without this, a 30-min window accumulates ~1800 rows/container"), user-facing scenarios, operational concerns, non-obvious invariants a future reader would otherwise have to reverse-engineer. Don't restate framework/language behavior: `useRef`, `useMemo`, `useCallback`, `useEffect` deps, `??`/`?.`, discriminated unions, structural typing, JSX semantics, etc. are knowable from docs and add noise. JSDoc `@param`/`@returns` on complex public hooks and functions is encouraged when it documents semantics, units, defaults, or preference order, but skip it for trivial helpers where the signature already says everything.
15. **No claudisms in written output**: Avoid LLM stylistic tells in code, comments, JSDoc, commit messages, PR descriptions, and docs. Banned: em dashes (`—`), en dashes (`–`), and double-hyphen `--` used as a dash substitute; vocabulary tells ("delve", "tapestry", "intricate", "robust", "comprehensive", "meticulous", "leverage", "utilize", "facilitate", "it's worth noting", "it's important to note", "essentially", "fundamentally"); performative qualifiers in comments and commits ("carefully", "thoroughly", "comprehensively"); boilerplate sign-offs in docs/PRs ("Hope this helps!", "Feel free to reach out"); excessive emojis (✅🎉🚀✨). Use plain alternatives: "use" not "leverage"/"utilize", "help" not "facilitate", "explore" not "delve", commas/parens/colons instead of em dashes.

## Tech Stack

- **Framework:** TanStack Start (SPA mode, SSR disabled) + React 19
- **Runtime:** Bun (pinned in `.bun-version`; package manager, test runner, runtime)
- **Language:** TypeScript (strict mode, `noUnusedLocals`, `noUnusedParameters`)
- **UI:** shadcn-style components on Base UI (`@base-ui/react`, vendored in `src/components/ui/`) + TailwindCSS v4 (styling, via `@tailwindcss/vite` plugin - no config file) + sonner (toasts). MUI and emotion have been fully removed.
- **State:** Jotai (settings atoms) + TanStack Query
- **Streaming:** SSE via TanStack Router server routes
- **Charts:** Apache ECharts
- **Clients:** Dockerode (Docker), pg (PostgreSQL), native fetch (Proxmox)
- **Crypto:** jose (JWT for agent auth, JWE for at-rest secret encryption)
- **Database:** TimescaleDB (PostgreSQL 16, wide hypertables, auto-compression after 7 days)
- **Worker:** Standalone Bun process for continuous data collection
- **Testing:** `bun:test` with Happy-DOM + Testing Library

## Architecture

### Data Flow

```text
Worker → Agent sidecars (Docker/ZFS SSE) + Proxmox REST API → INSERT wide rows → TimescaleDB
                                                                                       ↓
Browser → Server (SSE) ← StatsPollService (1s poll) → Query DB → Broadcast
```

- Frontend reads from database, not direct API connections.
- Docker and ZFS stats flow through agent sidecars (SSE streams). Proxmox uses direct REST API polling. All three share the same downstream path: worker → TimescaleDB → StatsPollService → SSE → `useTimeSeriesStream`.
- Frontend preloads history via REST server function, then merges SSE updates.

### SSE Endpoints (`src/routes/api/`)

Two factories in `src/lib/sse/` own the shared boilerplate (`ReadableStream`, heartbeat, `closed` flag, abort/teardown):

- **`createStatsSseHandler(source)`**: source values are `'docker'`, `'zfs'`, `'proxmox'` (type `StatsSource`; the corresponding route files are `/api/docker-stats`, `/api/zfs-stats`, `/api/proxmox-stats`). Wraps the three-arg `statsPollService.subscribe(source, sendData, sendError)` and emits an `event: stats_error` frame when the subscribe path fails.
- **`createBroadcastSseHandler({ loadSubscribe, serialize })`**: for single-arg subscribe-based services (`docker-inventory`, `stack-status`, `settings`). Caller owns the full SSE frame via `serialize`, so named events (`event: foo`) are possible when needed.

Server-only imports must happen inside the factory callbacks:

```typescript
// ALWAYS dynamic import inside the factory callback; static imports break the client bundle:
loadSubscribe: async () => {
  await import('@/lib/server-init');
  const { stackStatusBroadcastService } = await import('@/lib/stacks/stack-status-broadcast-service');
  return (cb) => stackStatusBroadcastService.subscribe(cb);
}
```

Hand-written routes (don't fit the factory shape): `docker-logs.$containerId` (auth + DB lookup + pipe-through from agent) and `git.$` (git HTTP smart protocol, not SSE).

### Shared DataTable (`src/components/ui/datatable/`)

Unified table using TanStack Table v8 (headless) + CSS Grid rows. Key files: `DataTable.tsx`, `DataTableToolbar.tsx`, `columns.tsx` (factories: `metricColumn`, `nameColumn`, `statusColumn`, `progressColumn`), `MetricCell.tsx`, `SparklineCell.tsx`, `SparklineCanvas.tsx`.

**Virtualization**: Automatic threshold at 150 rows. Below: normal DOM flow with `content-visibility: auto` + `contain-intrinsic-size` (browser-native off-screen optimization, preserves Collapse animations). Above: `useVirtualizer` with absolute positioning (no animations). Never remove virtualization to solve other problems; a single host can have hundreds of containers.

**Expansion**: Two patterns: `getSubRows` for tree data sharing the same columns (ZFS hierarchy), `renderDetailPanel` for full-width custom content like nested DataTables (Docker hosts → containers, Proxmox hosts → guests). Detail panels always render inline within the DataTable row, never outside. Entire expandable rows are clickable (not just the name cell).

**Mobile**: `ResizeObserver` on DataTable container detects <1024px (not media queries). Sticky toolbar shows metric group toggles (CPU/RAM, Disk I/O, Net I/O), one group at a time.

**Scroll**: Table fills remaining viewport height (`flex-1 min-h-0`). `scrollbar-gutter: stable` on the DataTable scroll container when virtualized or `maxHeight` is set (not applied unconditionally; `html` has `scrollbar-gutter: auto`). Sticky header inside scroll container tracks horizontal scroll.

### Key Patterns

- **Styling**: TailwindCSS v4 configured in `App.css` with `@import "tailwindcss"`. shadcn design tokens (`--background`, `--card`, `--popover`, `--muted`, `--accent`, `--level1-3`, `--chart-bg`, `--success`, `--warning`, `--info`, `--tooltip`, etc.) defined in `App.css` as literal color values: dark scheme in `:root`, light overrides in `[data-color-scheme="light"]`. Dark mode keys off the `data-color-scheme` attribute (`@custom-variant dark`), owned by `useColorMode`. Chart CSS vars (`--chart-cpu`, `--chart-memory`, etc.) in `App.css`.
- **Settings**: Jotai atoms synced via SSE (`/api/settings`). Domain-scoped hooks (`useDockerSettings`, `useZfsSettings`, `useProxmoxSettings`, `useGeneralSettings`) provide optimistic setters and subscribe via `selectAtom` so each consumer only re-renders when its own slice changes. `useSettings()` remains as a composite wrapper for the settings page. Keys in `src/lib/constants/settings-keys.ts`. PostgreSQL `NOTIFY settings_change` broadcasts to all clients.
- **Multi-host**: Docker and ZFS monitoring both use managed hosts registered via **Settings → Managed Hosts**. User deploys the agent container on each host, then provides the agent URL and capabilities (docker/zfs). The worker subscribes to each agent's SSE streams (`AgentStatsCollector`, `ZFSCollector`, `ContainerInventoryCollector`); it never connects to Docker directly. Agent auth uses per-host Ed25519 keypair JWTs: the web app generates the keypair at enrollment, stores the private JWK encrypted (JWE, master key from `MASTER_KEY_FILE`/`MASTER_KEY`), and returns the public JWK for the operator to install in the agent as `AGENT_TRUSTED_PUBKEY` (or via `AGENT_TRUSTED_PUBKEY_FILE`).
- **Demo mode**: `VITE_DEMO_MODE=true` swaps server functions via Vite aliases and patches `EventSource`. Zero changes to routes/hooks/components. Mock entities defined in `src/lib/mock/entities.ts`.
- **Worker**: Collectors extend `BaseCollector` (AsyncDisposable, exponential backoff). Entry point uses `AsyncDisposableStack` for cleanup.
- **Entity IDs**: Docker=`host/container_id`, ZFS=`host/pool/vdev/disk` (hierarchy via indent: 0=pool, 2=vdev, 4+=disk), Proxmox=varies by type.

### Agent (`agent/`)

Separate Bun package that runs as a sidecar container alongside Docker hosts. Provides a REST/SSE API for Docker management operations (deploy, logs, stats streaming). Uses raw `Bun.serve()` with manual route matching and timing-safe auth middleware (zero framework dependencies beyond Dockerode). The agent replaces direct Docker API calls from the worker; the main app communicates with agents rather than Docker hosts directly.

The agent is intentionally NOT a workspace member of the homelab-manager `package.json`: its `agent/bun.lock` is the only lockfile the docker build (`context: ./agent`) sees, and workspace membership would mask drift by routing local `bun install` to the homelab-manager lockfile. Web/worker import only types from the agent via the TS path alias `@homelab-manager/agent/*` (resolved at compile time, no runtime dependency). Run `bun run setup` for a full install.

### Authentication (`src/lib/auth/`)

Optional OIDC login, gated by `AUTH_ENABLED=true`. When enabled, `/api/auth/login`, `/api/auth/callback`, and `/api/auth/logout` handle the OIDC handshake; sessions are issued as signed cookies with TTL from `SESSION_TTL_HOURS`. OIDC group claims map to three roles (`admin`, `operator`, `viewer`) via `OIDC_ROLE_ADMIN`/`OPERATOR`/`VIEWER` env vars. `require-role.ts` guards server functions; `sse-auth.ts` authenticates SSE endpoints. `agent-token-migration.ts` migrates legacy agent tokens on startup. UI routes: `src/routes/login.tsx`, `src/routes/denied.tsx`. Designed to pair with Pocket ID but works with any OIDC provider. When `AUTH_ENABLED=false` (default), all routes are open: keep the dashboard on a trusted network.

### Deploy Pipeline (`src/lib/deploy/`)

Trigger-agnostic orchestration: `DeployRequest` → validate → resolve secrets → dispatch to agent → record result. Uses `GitTriggerBuilder` (post-receive) or `UITriggerBuilder` (UI actions). Concurrency enforced via PostgreSQL partial unique index. Stuck deploys recovered on startup and via `DeployWatchdog` (default 10-min threshold) so a crashed process can't leave `in_progress` rows stranded.

### Git Management (`src/lib/git/`)

Server-side bare git repo via isomorphic-git. Git HTTP smart protocol at `/api/git/stacks/...` via `Bun.spawn`. Post-receive hook diffs commits, identifies changed stacks, and builds deploy requests. Commits serialized per-repo via async mutex.

### Database Tables

Hypertables: `docker_stats`, `zfs_stats`, `proxmox_stats`, `docker_container_events` (append-only state-change log; current snapshot via `DISTINCT ON (host, container_id) ORDER BY at DESC`, broadcast via `NOTIFY docker_container_change`). Plus `entity_metadata` (icons/labels), `settings` (KV with NOTIFY trigger), `managed_hosts` (Docker hosts with agent connection details), `deploy_history` (deploy records with status tracking), `stack_secrets` (per-stack environment-variable secrets, JWE-encrypted at rest), and `agent_keypairs` (per-host Ed25519 keypair: private JWK encrypted, public JWK as JSONB). Schema details in `migrations/`.

### Key Rotation

Encrypted columns (`stack_secrets.ciphertext_jwe`, `agent_keypairs.private_jwk_jwe`) use a versioned keyring so a new master key can be enrolled without breaking existing ciphertext.

**Env var patterns:**
- `MASTER_KEY` / `MASTER_KEY_FILE`: single-key legacy pattern, treated as KID `v1`.
- `MASTER_KEY_<KID>` / `MASTER_KEY_FILE_<KID>`: additional keys, e.g. `MASTER_KEY_v2=<base64>`.

The lexicographically last KID is used for new encryptions; all loaded keys are available for decryption.

**Rotation procedure:**
1. Generate a new key: `openssl rand -base64 32`
2. Add it alongside the old key: set `MASTER_KEY_v2=<new-base64>` (keep `MASTER_KEY`/`MASTER_KEY_v1` in place).
3. Restart the app: new secrets encrypt under `v2`, old secrets still decrypt via `v1`.
4. Run the migration CLI to re-encrypt existing rows:

   ```bash
   bun run migrate-secrets --from v1 --to v2
   ```

5. Remove the old key env var (`MASTER_KEY` or `MASTER_KEY_v1`) and restart.

The migration script exits non-zero on any failure. Partially migrated rows are safe because both keys remain in the keyring during the rotation window.

## Gotchas

Non-obvious pitfalls from past sessions (not restated from rules above):

1. **BIGINT string coercion**: PostgreSQL `BIGINT` returns strings via node-postgres. Always wrap with `Number()` in row converters or arithmetic becomes string concatenation.
2. **Never add framework packages to `optimizeDeps.include`**: Adding `@tanstack/react-start` pulls `node:async_hooks` into the client bundle.
3. **Stable ordering from Maps**: Map iteration is insertion-order, not sorted. Always sort data from Maps before rendering to prevent layout shift.
4. **PostgreSQL extended query protocol**: Parameterized queries use extended protocol which doesn't support multi-statement. INSERT and NOTIFY must be separate `client.query()` calls.
5. **React.memo with streaming data**: Incorrect memoization freezes streaming updates. Be cautious with `React.memo` on components receiving `latestByEntity` or `rows`.
6. **Conditional rendering belongs in the parent**: When a component only renders for a subset of rows/items (e.g., container rows but not host rows), guard at the call site (`if (!row.container) return null` in the column `cell` function) rather than adding an early return inside the component. This makes it immediately clear from reading the parent what is always rendered vs. conditionally rendered, and avoids calling hooks conditionally inside the child.
7. **Layout shift in metric columns**: Dynamic number formatting (KB→MB, varying decimals) causes width instability. Use minimum widths with `ch` units in `MetricCell`.
8. **Fix root causes, not symptoms**: Investigate actual bugs rather than adding caching/memoization workarounds. Past band-aid fixes were frequently reverted.
9. **Icon attribution**: Dashboard icons from `homarr-labs/dashboard-icons` (NOT the old `walkxcode` name).
10. **Parallel agent worktree isolation**: When dispatching multiple agents into git worktrees, each agent must `cd "$WORKTREE_PATH"` before any file writes and use relative paths only. Never run `git stash` inside a worktree while other worktrees are active: `.git/refs/stash` is shared across all worktrees, so a stash created in one worktree can be popped (and destroyed) by an agent in another.
11. **CSS vars empty on initial render**: CSS custom properties can resolve to empty strings before the theme applies. `CanvasGradient.addColorStop()` throws on empty color. Always guard canvas color operations.
12. **Virtualizer remounting resets component state**: When `useVirtualizer` repositions rows after collapse, components remount and lose refs/state. Use entity-keyed external state (not component-local refs) for data that must survive remounting (e.g., sparkline accumulators).
13. **Collapse + virtualizer can't sync**: collapse animations (CSS transitions, now Base UI Collapsible's `--collapsible-panel-height`) and virtualizer repositioning (JS `measureElement`) run on different systems. Don't virtualize the outer level (host rows); only virtualize inner levels (container rows).
14. **Parallel agent worktrees start from main, not the feature branch**: `isolation: "worktree"` in the Agent tool creates worktrees from the repo's default branch (main), not the current feature branch. Subagents dispatched to fix issues on a feature branch will reconstruct the feature work from scratch and then apply their fix on top, wasting tokens and creating merge conflicts. When fixes are small and targeted (a few lines each), apply them directly rather than delegating to subagents. If subagents are needed for complex component rewrites, scope each agent to exactly the files it must change and provide full context about the current file contents so it makes the minimum edit.
15. **MCP tool parameters are plain JSON strings**: Never use `$(cat <<'EOF'` or heredoc syntax in MCP tool call parameters (e.g., `mcp__github__create_pull_request` body). Heredoc is only for bash commands like `git commit -m` or `gh pr create` where the shell interprets the string. In MCP calls, it appears literally in the output.

## CI/CD

All changes to `main` via PR. CI runs build, test, coverage, license check. Docker images published to GHCR.
Env vars documented in `.env.example`. `.env` sets `POSTGRES_HOST=localhost` for local dev; Docker overrides to `postgres`.
