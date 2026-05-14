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
