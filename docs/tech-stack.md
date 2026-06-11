# Tech Stack

| Layer | Technology | Role |
|-------|-----------|------|
| **Framework** | [TanStack Start](https://tanstack.com/start) | Full-stack React framework - server functions, file-based routing (SPA mode, SSR disabled) |
| **Routing** | [TanStack Router](https://tanstack.com/router) | Type-safe, file-based routing with built-in devtools |
| **Async State** | [TanStack Query](https://tanstack.com/query) | Server state management - caching, refetching, and stale data detection |
| **Virtualization** | [TanStack Virtual](https://tanstack.com/virtual) | Virtualized rendering for large lists (container-scroll mode) |
| **Runtime** | [Bun](https://bun.sh) | Package manager, test runner, and JavaScript runtime |
| **Build** | [Vite](https://vite.dev) | Dev server and production bundler |
| **UI** | [MUI Material UI](https://mui.com/material-ui/getting-started/) + [TailwindCSS](https://tailwindcss.com) | Component library and utility-first styling |
| **Docker** | [Dockerode](https://github.com/apocas/dockerode) | Docker Engine API client |
| **Git** | [isomorphic-git](https://isomorphic-git.org/) | Server-side git operations for stack repository management |
| **Crypto** | [jose](https://github.com/panva/jose) | JWE at-rest encryption for stack secrets and per-agent private keys; Ed25519 JWT signing for agent auth |
| **Code Editor** | [Monaco Editor](https://microsoft.github.io/monaco-editor/) + [monaco-yaml](https://github.com/remcohaszing/monaco-yaml) | In-app YAML editor for Docker Compose files with schema validation |
| **Database** | [TimescaleDB](https://www.timescale.com/) | PostgreSQL with automatic compression and indefinite retention for time-series data |
| **DB Driver** | [node-postgres (`pg`)](https://node-postgres.com/) | PostgreSQL client used by the web server and worker for queries, LISTEN/NOTIFY, and connection pooling |
| **Server Runtime** | [Nitro](https://nitro.build/) | Server engine under TanStack Start (pinned to a nightly build via `nitro-nightly`) |
| **Validation** | [Zod](https://zod.dev) | Schema validation |
| **Charts** | [Apache ECharts](https://echarts.apache.org/) | Interactive charts - sparklines, dual-series, and historical metric charts |
| **Terminal** | [xterm.js](https://xtermjs.org/) | Container log viewer with live SSE streaming |
| **State** | [Jotai](https://jotai.org) | Atomic state management - settings atoms with optimistic updates and SSE sync |
| **Language** | TypeScript + React 19 | Type-safe UI development |

## Nitro nightly pin

`package.json` aliases `nitro` to an exact `nitro-nightly` snapshot:

```json
"nitro": "npm:nitro-nightly@3.0.1-20260402-182549-a5a3389c"
```

This is the highest-churn dependency in the stack. TanStack Start on Vite 8 needs Nitro v3, which has no stable release yet; the only published builds are nightlies. Nightlies carry no semver guarantees, so any snapshot can change dev-server behavior, route handling, or build output without notice. The pin is exact for that reason: upgrades are deliberate, never automatic.

### Known failure modes

- **Vite 8 + Nitro v3 integration churn.** Both projects are moving targets and the integration between them breaks periodically in the nightly channel. A bad snapshot can fail the build outright or change how server routes are mounted.
- **Dev-mode server-route redirects.** Some nightlies mishandle redirect responses from server routes in dev mode. The OIDC flow depends on these: `/api/auth/login` and `/api/auth/callback` both answer with redirects, so a regression here breaks login during local development (`AUTH_ENABLED=true` with the `oidc` compose profile) while production builds keep working.

When bumping the snapshot, verify the dev OIDC round trip and a production build before merging.

### What Nitro provides here

- The production server bundle (`.output/server/index.mjs`, the Docker image entrypoint).
- Nitro server routes in `server/routes/`, currently the `docker-exec` WebSocket proxy (uses `defineWebSocketHandler` from h3/crossws, enabled by `features: { websocket: true }` in `vite.config.ts`).
- The dev server middleware that serves TanStack Start server functions and `src/routes/api/` routes during `bun dev`.

### Escape hatch: custom Bun.serve entry

If the nightly channel becomes unusable, the project does not have to stay on Nitro. TanStack Start can build without the Nitro plugin (drop `nitro(...)` from `vite.config.ts`), producing a server build that exposes a fetch handler instead of a self-contained Nitro server. A small hand-written entry can wire that handler into `Bun.serve()` and replace the Docker `CMD`. The two pieces that need replacing by hand:

- The `docker-exec` WebSocket route, since `defineWebSocketHandler` is Nitro-specific. `Bun.serve()` has native WebSocket support, and the agent (`agent/src/`) already runs on raw `Bun.serve()` with manual route matching, so the pattern exists in this repo.
- Static asset serving for the client build output, which Nitro currently handles.

This fallback trades Nitro's conveniences for full control over the server runtime and removes the nightly dependency entirely. It is documented here as the contingency plan, not the current direction.
