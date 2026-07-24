# Project Structure

```text
src/
├── components/
│   ├── AppShell.tsx                 # Shared layout (ThemeProvider, QueryClient, Header)
│   ├── Header.tsx                   # Navigation header
│   ├── PageStatusBar.tsx            # Thin status strip with left/right slots (dashboards)
│   ├── PageTitle.tsx                # Plain h4 title (settings and static pages)
│   ├── ModeToggle.tsx               # Dark/light theme toggle
│   ├── ThemeProvider.tsx            # MUI Material theme wrapper
│   ├── Toasts.tsx                   # Toast notification display
│   ├── docker/
│   │   ├── ContainerDetailPanel.tsx # Expanded container detail (dual-series charts + log viewer)
│   │   ├── ContainerHistoryPage.tsx # Historical data page for a container
│   │   ├── ContainerHistoryPanel.tsx # History panel drawer wrapper
│   │   ├── ContainerLogViewer.tsx   # Live xterm.js log viewer with SSE streaming
│   │   ├── ContainerMetricChart.tsx # Individual metric chart component
│   │   ├── ContainerStateChip.tsx   # Container state indicator chip (running/stopped/etc.)
│   │   ├── ContainerTable.tsx       # Docker table (wraps shared DataTable, includes HostRow)
│   │   ├── DockerStatusSummary.tsx  # Docker status summary display
│   │   ├── DualSeriesChart.tsx      # Dual-series ECharts component (CPU/Mem, Network I/O)
│   │   ├── DualSeriesChartRenderer.tsx # Renders dual-series chart from shared data/config
│   │   ├── HistoricalChartsGrid.tsx # Grid layout for historical charts
│   │   ├── HistoricalMetricChart.tsx # Individual historical metric chart
│   │   ├── HistoricalTimeline.tsx   # Timeline navigation for history
│   │   ├── IconGrid.tsx             # Grid of selectable container icons
│   │   ├── IconPickerDialog.tsx     # Container icon picker with search
│   │   └── MetricCheckboxes.tsx     # Metric toggle controls
│   ├── stacks/
│   │   ├── ComposeEditor.tsx        # Monaco YAML editor for docker-compose files
│   │   ├── ComposeEditorLoader.tsx  # Dynamic loader for compose editor
│   │   ├── ContainerList.tsx        # Running containers for a stack
│   │   ├── CreateStackDialog.tsx    # Create new stack dialog
│   │   ├── DeleteStackDialog.tsx    # Stack deletion confirmation
│   │   ├── DeployHistoryList.tsx    # Deploy history timeline
│   │   ├── DeployHistoryRow.tsx     # Individual deploy history entry
│   │   ├── RollbackDialog.tsx       # Rollback to previous deployment
│   │   ├── StackActionBar.tsx       # Deploy, teardown, restart action buttons
│   │   ├── StackEditorForm.tsx      # Tabbed stack editor; hosts the shared react-hook-form + unsaved-changes guard
│   │   ├── StackSettingsDialog.tsx  # Stack settings editor
│   │   ├── SyncStatusBadge.tsx      # Git sync status badge
│   │   ├── UnsavedChangesDialog.tsx # Discard-confirmation shown when leaving with unsaved edits
│   │   ├── VariableRow.tsx          # Individual variable editor row (form-registered value + delete)
│   │   ├── VariablesPanel.tsx       # Stack variables editor (JWE-encrypted in stack_secrets)
│   │   ├── stack-form.ts            # Shared react-hook-form value shape for the stack editor
│   │   └── stacks-context.ts        # Context providers for stack data
│   ├── settings/
│   │   ├── AddHostWizard.tsx        # Multi-step host onboarding wizard
│   │   ├── CopyButton.tsx           # Copy-to-clipboard button
│   │   ├── HostDialogs.tsx          # Host edit/delete confirmation dialogs
│   │   ├── HostRow.tsx              # Individual host row component
│   │   ├── ManagedHostsCard.tsx     # Host management card (presentation)
│   │   └── ManagedHostsCardConnected.tsx # Host management card (connected)
│   ├── zfs/
│   │   ├── ZFSPoolsTable.tsx        # ZFS table (wraps shared DataTable)
│   │   ├── ZFSPoolSpeedCharts.tsx   # Pool-level speed charts
│   │   └── ZFSPoolSpeedChart.tsx    # Individual pool speed chart
│   ├── proxmox/
│   │   ├── ClusterSummaryCards.tsx   # Cluster-wide CPU/memory/storage summary
│   │   ├── ProxmoxHostView.tsx      # Per-node expandable sections (VMs, containers, storage)
│   │   ├── GuestSection.tsx         # VM/LXC guest list within a node
│   │   └── StorageSection.tsx       # Storage list within a node
│   ├── ui/datatable/
│   │   ├── DataTable.tsx            # Unified table (TanStack Table + CSS Grid rows, virtualizer at 150+ rows)
│   │   ├── DataTableToolbar.tsx     # Table toolbar with search, filters, and metric group toggles
│   │   ├── MetricCell.tsx           # Metric value cell with formatted display
│   │   ├── MetricHeaderCell.tsx     # Sortable column header for metric tables
│   │   ├── SparklineCanvas.tsx      # Canvas-based sparkline renderer
│   │   ├── SparklineCell.tsx        # Sparkline cell wrapper for DataTable
│   │   ├── sparkline-accumulator-store.ts # Entity-keyed sparkline accumulator (survives virtualizer remounts)
│   │   ├── StaleDataAlert.tsx       # Stale data warning indicator
│   │   ├── columns.tsx              # Column factories (metricColumn, nameColumn, statusColumn, progressColumn)
│   │   └── index.tsx                # Barrel exports
│   └── shared/
│       └── BottomDrawer.tsx         # Reusable bottom drawer component
├── hooks/
│   ├── settingsAtom.ts              # Jotai atoms (rawSettings → derived settings), types, parsing
│   ├── timeSeriesStream/            # Modular time-series stream internals
│   │   ├── timeWindowTrim.ts        # Trims data to configured time window
│   │   ├── types.ts                 # Shared types for stream hooks
│   │   ├── useLatestByEntity.ts     # Latest snapshot per entity ID
│   │   ├── useSSEBuffer.ts          # SSE event buffering and deduplication
│   │   └── useVisibilityRefresh.ts  # Refresh on tab visibility change
│   ├── toastAtom.ts                 # Toast notification atom + useToast hook
│   ├── useContainerChartData.ts     # Derived chart data from container time-series
│   ├── useContainerLogs.ts          # SSE-based container log stream → xterm.js with reconnection
│   ├── useDockerInventory.ts        # Docker container inventory SSE subscription
│   ├── useDockerSettings.ts         # Docker settings slice with optimistic setters
│   ├── useEChartTimeScroll.ts       # ECharts time-axis scroll interaction
│   ├── useEventSource.ts            # EventSource-based SSE consumer with exponential backoff
│   ├── useGeneralSettings.ts        # General settings slice with optimistic setters
│   ├── useLightPaletteEffect.ts     # Light mode palette adjustment
│   ├── useOptimisticSetting.ts      # Generic optimistic setting updater with rollback
│   ├── useProxmoxSettings.ts        # Proxmox settings slice with optimistic setters
│   ├── usePulseIndicator.ts         # Pulse animation indicator for live data
│   ├── useSettings.tsx              # Consumer hook - settings + optimistic setters with rollback
│   ├── useSettingsSync.ts           # SSE-to-atom bridge (syncs /api/settings → rawSettingsAtom)
│   ├── useStackStatus.ts            # Stack status SSE subscription with shallow equality
│   ├── useTimeSeriesStream.ts       # Preload + SSE merge + time-windowed buffer + stale detection
│   ├── useVisibleRAF.ts             # requestAnimationFrame gated on tab visibility
│   └── useZfsSettings.ts            # ZFS settings slice with optimistic setters
├── data/
│   ├── docker/
│   │   ├── functions.tsx            # Docker server functions (active containers, icon updates)
│   │   └── schemas.ts              # Docker request/response validation schemas
│   ├── hosts/
│   │   ├── functions.tsx            # Host management server functions (CRUD, tokens)
│   │   ├── handlers.ts             # Host add/edit/delete/token handlers
│   │   └── schemas.ts              # Host validation schemas
│   ├── proxmox/
│   │   ├── functions.tsx            # Proxmox server functions (connection test)
│   │   └── schemas.ts              # Proxmox validation schemas
│   ├── settings/
│   │   ├── functions.tsx            # Settings server functions (get/update)
│   │   └── schemas.ts              # Settings validation schemas
│   ├── stacks/
│   │   ├── functions.tsx            # Stack CRUD server functions (create, deploy, rollback, variables)
│   │   └── schemas.ts              # Stack validation schemas
│   ├── zfs/
│   │   ├── functions.tsx            # ZFS server functions (active pools, stale check)
│   │   └── schemas.ts              # ZFS validation schemas
│   └── mock-docker-containers.ts    # Mock container data for testing
├── middleware/
│   └── database-middleware.ts       # Database client injection
├── lib/
│   ├── clients/
│   │   ├── agent-client.ts          # HTTP client for agent sidecar communication (JWT-signed requests)
│   │   ├── database-client.ts       # PostgreSQL connection pool manager
│   │   └── proxmox-client.ts        # Proxmox VE REST API client
│   ├── config/
│   │   ├── database-config.ts       # Database connection configuration
│   │   ├── git-config.ts            # Git server configuration
│   │   ├── proxmox-config.ts        # Proxmox API configuration
│   │   └── worker-config.ts         # Worker process configuration
│   ├── constants/
│   │   ├── settings-keys.ts         # Canonical DB key definitions used across frontend + backend
│   │   ├── stacks-keys.ts           # Stack-related React Query key definitions
│   │   ├── ui-timing.ts             # UI timing constants
│   │   └── preload-queries.ts       # Preload query definitions
│   ├── charts/
│   │   ├── css-vars.ts              # CSS variable color resolution for charts
│   │   └── y-axis.ts                # Y-axis scaling utilities
│   ├── crypto/
│   │   ├── master-key.ts            # Resolve MASTER_KEY / MASTER_KEY_FILE → AES-GCM CryptoKey
│   │   ├── encrypted-value.ts       # JWE encrypt/decrypt helpers for at-rest secrets
│   │   └── agent-jwt.ts             # Ed25519 keypair generation and short-lived JWT signing
│   ├── database/
│   │   ├── repositories/
│   │   │   ├── stats-repository.ts  # Time-series stats data access
│   │   │   ├── settings-repository.ts # Settings KV data access
│   │   │   ├── deploy-repository.ts # Deploy history data access
│   │   │   ├── host-repository.ts   # managed_hosts data access (UI + deploy)
│   │   │   ├── docker-container-event-repository.ts # Docker container inventory events data access
│   │   │   ├── entity-metadata-repository.ts    # Entity metadata (icons/labels) data access
│   │   │   ├── stack-secrets-repository.ts  # JWE-encrypted stack secrets data access
│   │   │   └── agent-keypairs-repository.ts # Encrypted per-agent Ed25519 keypairs data access
│   │   ├── subscription-service.ts  # StatsPollService - shared 1s poll, broadcasts to SSE clients
│   │   └── migrate.ts               # Database migration runner
│   ├── deploy/
│   │   ├── change-detection.ts      # Content hashing to skip no-op deploys
│   │   ├── deploy-watchdog.ts       # Recovers stuck in_progress deploys (default 20-min threshold)
│   │   ├── pipeline.ts              # Deploy pipeline orchestrator (validate → resolve secrets → dispatch)
│   │   ├── pipeline-factory.ts      # Factory for building configured pipeline instances
│   │   ├── secret-resolver.ts       # Pluggable secret resolution interface
│   │   ├── stack-repo-writer.ts     # Writes compose files to the git-backed stack repository
│   │   ├── startup-recovery.ts      # Recovers stuck deploys on process startup
│   │   ├── types.ts                 # Deploy domain types
│   │   └── index.ts                 # Barrel exports
│   ├── git/
│   │   ├── repo.ts                  # Bare repo init, commit, read, list, log, diff (isomorphic-git)
│   │   ├── git-server.ts            # HTTP smart protocol handlers via child_process.spawn
│   │   ├── git-http.ts              # Path parsing and request type classification
│   │   ├── git-server-functions.ts  # File tree builder for UI
│   │   ├── manifest.ts              # YAML manifest parsing and validation
│   │   ├── post-receive.ts          # Change detection and deploy request builder
│   │   ├── post-receive-handler.ts  # Post-receive orchestration with pipeline dispatch
│   │   ├── init-repo.ts             # Startup initialization with seed manifest
│   │   └── editor-operations.ts     # In-app file save/commit and manifest updates
│   ├── stacks/
│   │   ├── delete-stack-resolver.ts # Resolve and execute stack deletion
│   │   ├── parse-variables.ts       # Parse compose variable references
│   │   ├── stack-mappers.ts         # Map domain to/from storage models
│   │   ├── stack-service.ts         # Stack CRUD and orchestration
│   │   └── stack-status-broadcast-service.ts # PostgreSQL LISTEN + SSE broadcast for stack status
│   ├── services/
│   │   ├── agent-health-service.ts  # Agent health check with timeout
│   │   ├── agent-provisioning-service.ts # Deploy agent containers to hosts (injects public JWK)
│   │   ├── agent-constants.ts       # Agent configuration constants
│   │   ├── token-service.ts         # generateToken(): random UUID generation
│   │   └── docker-image-utils.ts    # Docker image version utilities
│   ├── templates/
│   │   └── agent-stack-compose.ts   # Generate agent docker-compose.yml for host deployment
│   ├── hosts/
│   │   └── host-utils.ts            # Host utility functions
│   ├── auth/
│   │   ├── oidc-client.ts            # OIDC discovery + authorization-code flow client
│   │   ├── oidc-secrets.ts           # OIDC client secret resolution
│   │   ├── session-manager.ts       # Signed-cookie session issue/verify (TTL from SESSION_TTL_HOURS)
│   │   ├── role-mapper.ts            # OIDC group claim -> admin/operator/viewer role
│   │   ├── require-role.ts           # Server-function guard by role
│   │   ├── sse-auth.ts               # SSE endpoint authentication helper
│   │   ├── agent-token-migration.ts # One-shot migration of legacy agent tokens at startup
│   │   └── types.ts                  # Auth domain types (Session, Role, OIDCClaims)
│   ├── settings/
│   │   └── settings-broadcast-service.ts  # PostgreSQL LISTEN + SSE broadcast for settings changes
│   ├── sse/
│   │   ├── create-stats-sse-handler.ts      # SSE factory for stats poll sources (docker/zfs/proxmox)
│   │   └── create-broadcast-sse-handler.ts  # SSE factory for subscribe-based broadcasts (inventory/status/settings)
│   ├── docker/
│   │   └── docker-inventory-broadcast-service.ts # PostgreSQL LISTEN + SSE broadcast for container inventory
│   ├── parsers/
│   │   ├── zfs-iostat-parser.ts     # ZFS iostat output parser
│   │   └── text-parser.ts           # Generic text line parser
│   ├── streaming/types.ts           # Core interfaces (StreamingClient, RateCalculator)
│   ├── workers/
│   │   ├── editor.worker.ts         # Monaco editor web worker
│   │   └── yaml.worker.ts          # YAML parsing web worker
│   ├── mock/                        # Demo mode: deterministic mock data generation
│   │   ├── prng.ts                  # Mulberry32 seeded PRNG + FNV hash
│   │   ├── patterns.ts              # Time-series pattern functions (sine, noise, lerp, smoothstep)
│   │   ├── entities.ts              # Static entity definitions with metric profiles
│   │   ├── generators/              # Snapshot + history generators (docker, zfs, proxmox, settings)
│   │   ├── functions/               # Mock server function replacements (Vite alias targets)
│   │   ├── mock-event-source.ts     # Drop-in EventSource replacement for SSE
│   │   └── install-demo.ts          # One-time setup: patches window.EventSource
│   ├── test/                        # Test utilities (Happy-DOM setup, Testing Library setup, stream helpers)
│   ├── utils/
│   │   ├── docker-hierarchy-builder.ts    # Wide rows → domain objects + host/container hierarchy
│   │   ├── docker-log-demux.ts            # Docker log stream demuxer (TTY vs muxed frame protocol)
│   │   ├── zfs-hierarchy-builder.ts       # Wide rows → domain objects + pool/vdev/disk hierarchy
│   │   ├── zfs-rate-calculator.ts         # ZFS rate calculation utilities
│   │   ├── proxmox-overview-converter.ts  # Proxmox API overview → flat DB rows
│   │   ├── proxmox-overview-builder.ts    # Flat DB rows → reconstructed Proxmox overview
│   │   ├── icon-resolver.ts               # Auto-resolve icons from Docker image names
│   │   ├── available-icons.ts             # Icon slug registry (dashboard-icons)
│   │   ├── abbreviate-unit.ts             # Unit abbreviation utilities
│   │   ├── api-url.ts                     # API URL construction helpers
│   │   └── abortable-sleep.ts             # Cancellable sleep via AbortSignal
│   ├── monaco-setup.ts              # Monaco editor initialization and schema configuration
│   ├── rate-calculator.ts           # Generic rate calculation
│   ├── stream-utils.ts              # Stream utility functions
│   └── server-init.ts               # Idempotent server startup + graceful shutdown handlers
├── worker/
│   ├── collectors/
│   │   ├── base-collector.ts        # Base class (AsyncDisposable, backoff, collection loop)
│   │   ├── agent-stats-collector.ts # Agent SSE-based stats collection (pre-computed metrics)
│   │   ├── zfs-collector.ts         # ZFS iostat collection via agent sidecar
│   │   ├── proxmox-collector.ts     # Proxmox REST API polling
│   │   └── container-inventory-collector.ts # Docker container inventory via agent events
│   ├── collector.ts                 # Worker entry point (AsyncDisposableStack, AbortController)
│   ├── collector-factory.ts         # Factory for creating configured collectors (local + managed hosts)
│   ├── settings-listener.ts         # Runtime settings change listener
│   ├── resolve-collection-interval.ts  # Collection interval resolution logic
│   └── dev-seed.ts                  # Development database seeding
├── types/                           # Domain types (docker.ts, zfs.ts, proxmox.ts, settings.ts, stacks.ts)
├── formatters/metrics.ts            # Number formatting (%, bytes, bits)
├── router.tsx                       # Router factory configuration
└── routes/
    ├── __root.tsx                   # HTML shell (SSR-safe, no MUI)
    ├── api/
    │   ├── docker-stats.ts          # Docker SSE endpoint
    │   ├── docker-inventory.ts      # Docker container inventory SSE endpoint
    │   ├── docker-logs.$containerId.ts  # Container log SSE endpoint
    │   ├── zfs-stats.ts             # ZFS SSE endpoint
    │   ├── proxmox-stats.ts         # Proxmox SSE endpoint
    │   ├── settings.ts              # Settings SSE endpoint (cross-browser sync)
    │   ├── stack-status.ts          # Stack status SSE endpoint
    │   ├── auth/
    │   │   ├── login.ts             # OIDC login redirect (initiates auth code flow)
    │   │   ├── callback.ts          # OIDC callback (issues session cookie)
    │   │   └── logout.ts            # Clears session cookie
    │   └── git.$.ts                 # Git HTTP smart protocol (catch-all route)
    ├── login.tsx                    # Login landing page (/login)
    ├── denied.tsx                   # Access-denied page (/denied)
    ├── index.tsx                    # Home/redirect page (/)
    ├── docker.tsx                   # Docker page (/docker)
    ├── docker.$containerId.tsx      # Docker container detail (/docker/:containerId)
    ├── proxmox.tsx                  # Proxmox page (/proxmox)
    ├── settings.tsx                 # Settings page (/settings)
    ├── zfs.tsx                      # ZFS page (/zfs)
    ├── stacks.tsx                   # Stacks layout (/stacks)
    └── stacks/
        ├── index.tsx                # Stacks list page (/stacks)
        ├── $stackName.tsx           # Stack detail page (/stacks/:stackName)
        └── host.$hostName.tsx       # Host stacks view (/stacks/host/:hostName)

src/theme.ts                         # MUI Material theme config
public/icons/                        # SVG icons from homarr-labs/dashboard-icons
migrations/                          # SQL migrations (settings + TimescaleDB wide tables + stack status + deploys)
scripts/                             # check-coverage.js, download-icons.ts, download-compose-schema.ts, migrate-master-key.ts, test-perf.sh

agent/                               # Agent sidecar container (separate Bun package)
├── src/
│   ├── index.ts                     # Bun.serve entry point with route registration
│   ├── middleware.ts                # JWT authentication middleware (verifies EdDSA Bearer tokens)
│   ├── routes/
│   │   ├── health.ts               # Docker version check + heartbeat
│   │   ├── stats.ts                # SSE container stats with pre-computed metrics
│   │   ├── logs.ts                 # SSE container log streaming (backlog + live)
│   │   ├── stacks.ts               # Stack deploy/teardown/restart/status
│   │   ├── containers-events.ts    # SSE Docker container inventory stream
│   │   ├── zfs.ts                  # ZFS pool status and SSE iostat streaming
│   │   └── agent-update.ts         # Agent self-update endpoint
│   └── lib/
│       ├── jwt-auth.ts              # JWT verification (verifyAgentJwt using EdDSA)
│       └── zfs-capabilities.ts     # ZFS binary detection and capability checking
├── Dockerfile
├── package.json
└── tsconfig.json

server/                              # WebSocket / non-SSR API routes outside TanStack Router
└── routes/
    └── api/
        └── docker-exec/[containerId].ts  # WebSocket-style exec passthrough to agent for container terminal

agent-updater/                       # Agent updater sidecar (separate Bun package)
├── src/
│   ├── index.ts                     # Entry point with interval-based update checks
│   ├── agent-updater.ts             # Pull, stop, recreate, health-check update flow
│   ├── health-reporter.ts           # Report updater health status
│   └── parse-interval.ts           # Parse duration strings (e.g., "5m", "1h")
├── Dockerfile
├── package.json
└── tsconfig.json
```
