# Project Structure

```text
src/
├── components/
│   ├── AppShell.tsx                 # Shared layout (ThemeProvider, QueryClient, Header)
│   ├── Header.tsx                   # Navigation header
│   ├── PageHeader.tsx               # Page title with optional actions
│   ├── ModeToggle.tsx               # Dark/light theme toggle
│   ├── ThemeProvider.tsx            # MUI Material theme wrapper
│   ├── Toasts.tsx                   # Toast notification display
│   ├── docker/
│   │   ├── ContainerTable.tsx       # Docker table (CSS Grid + useWindowVirtualizer, includes HostRow)
│   │   ├── ContainerRow.tsx         # Container row with icon, metrics, and sparklines
│   │   ├── ContainerChartsCard.tsx  # Expanded container detail (dual-series charts + log viewer)
│   │   ├── ContainerHistoryPage.tsx # Historical data page for a container
│   │   ├── ContainerHistoryPanel.tsx # History panel drawer wrapper
│   │   ├── ContainerLogViewer.tsx   # Live xterm.js log viewer with SSE streaming
│   │   ├── ContainerMetricChart.tsx # Individual metric chart component
│   │   ├── DualSeriesChart.tsx      # Dual-series ECharts component (CPU/Mem, Network I/O)
│   │   ├── HistoricalChartsGrid.tsx # Grid layout for historical charts
│   │   ├── HistoricalMetricChart.tsx # Individual historical metric chart
│   │   ├── HistoricalTimeline.tsx   # Timeline navigation for history
│   │   ├── IconPickerDialog.tsx     # Container icon picker with search
│   │   ├── MetricCheckboxes.tsx     # Metric toggle controls
│   │   ├── MetricSparkline.tsx      # Inline sparkline for metric values
│   │   └── SparklineChart.tsx       # Inline SVG sparkline for real-time metrics
│   ├── zfs/
│   │   ├── ZFSPoolsTable.tsx        # ZFS table (CSS Grid + useWindowVirtualizer)
│   │   ├── ZFSPoolSpeedCharts.tsx   # Pool-level speed charts
│   │   └── ZFSPoolSpeedChart.tsx    # Individual pool speed chart
│   ├── proxmox/
│   │   ├── ClusterSummaryCards.tsx   # Cluster-wide CPU/memory/storage summary
│   │   ├── ProxmoxHostView.tsx      # Per-node expandable sections (VMs, containers, storage)
│   │   ├── GuestSection.tsx         # VM/LXC guest list within a node
│   │   └── StorageSection.tsx       # Storage list within a node
│   ├── shared-table/
│   │   ├── index.tsx                # Barrel exports
│   │   ├── MetricValue.tsx          # Formatted metric display (value + unit + optional sparkline)
│   │   ├── MetricHeader.tsx         # Sortable column header for metric tables
│   │   └── StaleDataAlert.tsx       # Stale data warning indicator
│   └── shared/
│       └── BottomDrawer.tsx         # Reusable bottom drawer component
├── hooks/
│   ├── settingsAtom.ts              # Jotai atoms (rawSettings → derived settings), types, parsing
│   ├── useSettings.tsx              # Consumer hook - settings + optimistic setters with rollback
│   ├── useSettingsSync.ts           # SSE-to-atom bridge (syncs /api/settings → rawSettingsAtom)
│   ├── useEventSource.ts            # EventSource-based SSE consumer
│   ├── useContainerLogs.ts          # SSE-based container log stream → xterm.js
│   ├── useTimeSeriesStream.ts       # Preload + SSE merge + time-windowed buffer + stale detection
│   ├── useEChartTimeScroll.ts       # ECharts time-axis scroll interaction
│   ├── useLightPaletteEffect.ts     # Light mode palette adjustment
│   └── toastAtom.ts                 # Toast notification atom + useToast hook
├── data/
│   ├── docker.functions.tsx         # Docker server functions (active containers, icon updates)
│   ├── proxmox.functions.tsx        # Proxmox server functions (connection test)
│   ├── settings.functions.tsx       # Settings server functions (get/update)
│   ├── zfs.functions.tsx            # ZFS server functions (active pools, stale check)
│   └── mock-docker-containers.ts    # Mock container data for testing
├── middleware/
│   ├── docker-middleware.ts         # Docker client injection
│   └── ssh-middleware.ts            # SSH client injection
├── lib/
│   ├── clients/                     # Connection managers (Docker, SSH, Database, Proxmox)
│   ├── config/                      # Configuration loaders (database, docker, zfs, proxmox, worker)
│   ├── constants/                   # Shared constants
│   │   ├── settings-keys.ts         # Canonical DB key definitions used across frontend + backend
│   │   ├── ui-timing.ts             # UI timing constants
│   │   └── preload-queries.ts       # Preload query definitions
│   ├── charts/                      # Chart utilities
│   │   ├── css-vars.ts              # CSS variable color resolution for charts
│   │   └── y-axis.ts                # Y-axis scaling utilities
│   ├── database/
│   │   ├── repositories/            # Data access layer (StatsRepository, SettingsRepository)
│   │   ├── subscription-service.ts  # StatsPollService - shared 1s poll, broadcasts to SSE clients
│   │   └── migrate.ts               # Database migration runner
│   ├── settings/
│   │   └── settings-broadcast-service.ts  # PostgreSQL LISTEN + SSE broadcast for settings changes
│   ├── parsers/                     # Stream parsers (ZFS iostat, text lines)
│   ├── streaming/types.ts           # Core interfaces (StreamingClient, RateCalculator)
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
│   ├── rate-calculator.ts           # Generic rate calculation
│   ├── stream-utils.ts              # Stream utility functions
│   └── server-init.ts               # Idempotent server startup + graceful shutdown handlers
├── worker/
│   ├── collectors/                  # Background collectors (Docker, ZFS, Proxmox)
│   │   ├── base-collector.ts        # Base class (AsyncDisposable, backoff, collection loop)
│   │   ├── docker-collector.ts      # Docker stats collection
│   │   ├── zfs-collector.ts         # ZFS iostat collection via SSH
│   │   └── proxmox-collector.ts     # Proxmox REST API polling
│   ├── collector.ts                 # Worker entry point (AsyncDisposableStack, AbortController)
│   ├── collector-factory.ts         # Factory for creating configured collectors
│   ├── settings-listener.ts         # Runtime settings change listener
│   └── resolve-collection-interval.ts  # Collection interval resolution logic
├── types/                           # Domain types (docker.ts, zfs.ts, proxmox.ts, settings.ts)
├── formatters/metrics.ts            # Number formatting (%, bytes, bits)
├── router.tsx                       # Router factory configuration
└── routes/
    ├── __root.tsx                   # HTML shell (SSR-safe, no MUI)
    ├── api/
    │   ├── docker-stats.ts          # Docker SSE endpoint
    │   ├── docker-logs.$containerId.ts  # Container log SSE endpoint
    │   ├── zfs-stats.ts             # ZFS SSE endpoint
    │   ├── proxmox-stats.ts         # Proxmox SSE endpoint
    │   └── settings.ts              # Settings SSE endpoint (cross-browser sync)
    ├── index.tsx                    # Home/redirect page (/)
    ├── docker.tsx                   # Docker page (/docker)
    ├── docker.$containerId.tsx      # Docker container detail (/docker/:containerId)
    ├── proxmox.tsx                  # Proxmox page (/proxmox)
    ├── settings.tsx                 # Settings page (/settings)
    └── zfs.tsx                      # ZFS page (/zfs)

src/theme.ts                         # MUI Material theme config
public/icons/                        # SVG icons from homarr-labs/dashboard-icons
migrations/                          # SQL migrations (settings + TimescaleDB wide tables)
scripts/                             # check-coverage.js, download-icons.ts
```
