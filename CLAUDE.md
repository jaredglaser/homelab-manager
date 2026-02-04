# Project Guidelines for Claude

## Workflow

**Start of every conversation:**
- ALWAYS read this file (`CLAUDE.md`) first to get up-to-date project context and guidelines.

**End of every task:**
- After completing a task, check if `README.md` and `CLAUDE.md` need updates to reflect changes.
- Update documentation immediately if:
  - New architecture patterns were introduced
  - File/folder organization changed
  - New commands or scripts were added
  - Testing conventions changed
  - New tech stack components were added

## Tech Stack

- **Framework:** TanStack Start (SPA mode, SSR disabled)
- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **UI:** MUI Joy UI + TailwindCSS
- **Routing:** TanStack Router (file-based, auto-generated route tree)
- **State:** TanStack Query (QueryClient lives in `__root.tsx`)
- **Streaming:** Server functions via `createServerFn()` with async generators
- **Clients:** Dockerode (Docker API), ssh2 (SSH)
- **Validation:** Zod
- **Testing:** Bun test (`bun:test`)

## Commands

- `bun dev` — Start dev server on port 3000
- `bun build` — Production build
- `bun test` — Run tests
- `bun test --watch` — Watch mode

## Architecture Rules

### Styling
- Use **TailwindCSS only** for styling. Do not use MUI `sx` props, inline `style`, or CSS files unless absolutely necessary (e.g., Joy UI theming in `theme.ts`).
- Do not create `.css` files for components.

### Routing
- TanStack Router auto-generates `routeTree.gen.ts` — never edit it manually. It regenerates on `bun dev` and `bun build`.
- The root route (`__root.tsx`) only has a `shellComponent` (plain HTML). Do NOT add a `component` to the root route — it gets SSR'd and MUI Joy components break during SSR.
- Shared client-side layout (ThemeProvider, QueryClientProvider, Header) lives in `AppShell.tsx`. Each route wraps its content with `<AppShell>`.
- All routes use `ssr: false` (SPA mode).

### Server Functions
- Use `createServerFn()` from `@tanstack/react-start` for all server-side logic.
- Use middleware for connection injection (Docker, SSH). Do not create connections directly in server functions.
- Streaming data uses async generator server functions (`async function*`).

### Data Flow Pattern
- Server functions → `useServerStream` hook → `StreamingTable` component
- When adding a new streaming data source, follow the factory pattern: provide a stream function, column definitions, an `onData` reducer, and a row renderer to `StreamingTable`.
- Rate calculators must implement the `RateCalculator<TInput, TOutput>` interface from `src/lib/streaming/types.ts`. Use class-based calculators, not module-level functions.

### Components
- Shared table infrastructure lives in `src/components/shared-table/` (MetricCell, StreamingTable).
- Domain-specific components go in their own directories (`docker/`, `zfs/`).
- Extract shared rendering patterns into reusable components (e.g., `ZFSMetricCells` for repeated metric columns).

### Hooks
- Custom hooks live in `src/hooks/`.
- `useServerStream` is the standard hook for consuming streaming server functions. Always use it instead of raw `useEffect` + `for await` patterns.

### Types
- Domain types go in `src/types/` (e.g., `docker.ts`, `zfs.ts`).
- Streaming infrastructure types go in `src/lib/streaming/types.ts`.

### Testing
- Test files must be placed in `__tests__/` folders within the same directory as the files they test.
- Test files use the naming convention `*.test.ts` or `*.test.tsx`.
- Test utilities and helpers live in their own directories (e.g., `src/lib/test/`) and are NOT placed in `__tests__/`.
- Use Bun's built-in test runner (`bun:test`) — import `describe`, `it`, `expect`, etc. from `'bun:test'`.

### Do NOT
- Do not use `console.log` for debugging in committed code. Use `console.error` only for actual errors.
- Do not log environment variables or sensitive configuration.
- Do not create dashboard wrapper components — `StreamingTable` handles the title + sheet + table + loading/error states.
- Do not duplicate streaming logic in components — use `useServerStream`.
- Do not create a `QueryClient` per route — it is a singleton in `__root.tsx`.
- Do not use `sx` props for layout/spacing when Tailwind classes exist (`p-3` not `sx={{ p: 3 }}`).

### Path Aliases
- `@/` maps to `./src/` — always use `@/` imports for project files.
