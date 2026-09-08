# Project Structure

Directory-level map of the repo's four packages. For how the subsystems fit together, see [Architecture](architecture.md); for file-level detail, read the directory itself. Tests live in `__tests__/` folders co-located with the code they cover (omitted below).

```text
src/                        # Web app + worker (TanStack Start SPA, Bun)
├── components/
│   ├── auth/               # Login and access-denied UI
│   ├── docker/             # Docker dashboard: container table, detail panels, charts, log viewer
│   ├── header/             # Navigation header, menus, demo banner
│   ├── proxmox/            # Proxmox dashboard: cluster summary, per-node guest/storage sections
│   ├── settings/           # Settings page cards; wizard-steps/ is the Add Host wizard
│   ├── shared/             # Cross-dashboard building blocks
│   ├── stacks/             # Stack management UI: compose editor, deploy history, variables
│   ├── ui/                 # Vendored shadcn-style Base UI components; datatable/ is the shared DataTable
│   └── zfs/                # ZFS dashboard: pool table (subtables/), speed charts
├── hooks/                  # Settings slices, SSE consumers, color mode; timeSeriesStream/ internals
├── data/                   # Server functions + Zod schemas per domain (docker, hosts, proxmox, settings, stacks, zfs)
├── middleware/             # createServerFn middleware (database client injection)
├── lib/
│   ├── auth/               # OIDC client, sessions, role mapping, SSE auth
│   ├── charts/             # ECharts helpers (CSS var colors, y-axis scaling)
│   ├── clients/            # Agent, database (pg pool), and Proxmox clients
│   ├── config/             # Env-based config loaders
│   ├── constants/          # Settings keys, query keys, timing constants
│   ├── crypto/             # Master keyring, JWE encrypt/decrypt, agent JWT signing
│   ├── database/           # StatsPollService, migration runner; repositories/ per table
│   ├── deploy/             # Deploy pipeline, change detection, watchdog, startup recovery
│   ├── docker/             # Container inventory broadcast service
│   ├── git/                # Bare repo, HTTP smart protocol, post-receive deploy dispatch
│   ├── health/             # /api/health handler
│   ├── hosts/              # Host utilities
│   ├── mock/               # Demo mode: seeded generators, mock server functions, EventSource patch
│   ├── parsers/            # zpool iostat parsing
│   ├── schemas/            # Shared Zod schemas
│   ├── services/           # Agent health, secret resolution, token generation
│   ├── settings/           # Settings broadcast service
│   ├── sse/                # SSE handler factories; channels/ holds per-stream descriptors
│   ├── stacks/             # Stack CRUD, mappers, status broadcast
│   ├── streaming/          # Core streaming interfaces
│   ├── templates/          # Agent compose stack generator
│   ├── test/               # Test setup and helpers (deliberately outside __tests__/)
│   ├── utils/              # Hierarchy builders, row converters, icon resolution
│   ├── workers/            # Monaco/YAML web workers
│   └── *.ts                # monaco-setup, query-client (singleton), server-init (startup/shutdown), stream-utils
├── worker/                 # Collector entry point, factory, dev seed; collectors/ per source
├── routes/                 # TanStack Router file routes; api/ holds SSE, auth, and git endpoints
├── types/                  # Domain types per source (docker, zfs, proxmox, settings, stacks)
└── formatters/             # Number and unit formatting

server/                     # Nitro server routes outside TanStack Router (WebSocket passthrough)

agent/                      # Agent sidecar (separate Bun package with its own lockfile)
└── src/                    # Bun.serve entry + JWT middleware; routes/ per endpoint, lib/ helpers

agent-updater/              # Agent auto-update sidecar (separate Bun package)

migrations/                 # SQL migrations (hypertables, settings, stacks, deploys, auth)
scripts/                    # check-coverage, icon/schema downloads, migrate-master-key, dev/ seeders
public/icons/               # SVG icons from homarr-labs/dashboard-icons
self-hosting/               # Operator compose file and guide
```
