# Project Structure

```text
src/
├── components/
│   ├── AppShell.tsx                 # Shared layout (ThemeProvider, QueryClient, Header)
│   ├── Header.tsx                   # Navigation header
│   ├── PageHeader.tsx               # Page title with optional actions
│   ├── ModeToggle.tsx               # Dark/light theme toggle
│   ├── ThemeProvider.tsx            # MUI Material theme wrapper
│   ├── docker/
│   │   ├── ContainerTable.tsx       # Docker table (CSS Grid + useWindowVirtualizer, includes HostRow)
│   │   ├── ContainerRow.tsx         # Container row with icon, metrics, and sparklines
│   │   ├── ContainerChartsCard.tsx  # Expanded container detail charts (60s history)
│   │   ├── ContainerMetricChart.tsx # Individual metric chart component
│   │   ├── SparklineChart.tsx       # Inline SVG sparkline for real-time metrics
│   │   └── IconPickerDialog.tsx     # Container icon picker with search
│   ├── zfs/
│   │   ├── ZFSPoolsTable.tsx        # ZFS table (CSS Grid + useWindowVirtualizer)
│   │   ├── ZFSPoolSpeedCharts.tsx   # Pool-level speed charts
│   │   └── ZFSPoolSpeedChart.tsx    # Individual pool speed chart
│   ├── proxmox/
│   │   ├── ClusterSummaryCards.tsx   # Cluster-wide CPU/memory/storage summary
│   │   └── ProxmoxHostView.tsx      # Per-node expandable sections (VMs, containers, storage)
│   └── shared-table/
│       └── MetricValue.tsx          # Formatted metric display (value + unit + optional sparkline)
├── hooks/
│   ├── settingsAtom.ts              # Jotai atoms (rawSettings → derived settings), types, parsing
│   ├── useSettings.tsx              # Consumer hook — settings + optimistic setters with rollback
│   ├── useSettingsSync.ts           # SSE-to-atom bridge (syncs /api/settings → rawSettingsAtom)
│   ├── useSSE.ts                    # EventSource-based SSE consumer
│   ├── useTimeSeriesStream.ts       # Preload + SSE merge + time-windowed buffer + stale detection
│   └── toastAtom.ts                 # Toast notification atom + useToast hook
├── data/
│   ├── docker.functions.tsx         # Docker server functions (active containers, icon updates)
│   ├── proxmox.functions.tsx        # Proxmox server functions (connection test)
│   ├── settings.functions.tsx       # Settings server functions (get/update)
│   └── zfs.functions.tsx            # ZFS server functions (active pools, stale check)
├── middleware/
│   ├── docker-middleware.ts         # Docker client injection
│   └── ssh-middleware.ts            # SSH client injection
├── lib/
│   ├── __tests__/                   # Unit tests
│   ├── clients/                     # Connection managers (Docker, SSH, Database)
│   ├── config/                      # Configuration loaders (database, worker)
│   ├── database/
│   │   ├── repositories/            # Data access layer (StatsRepository, SettingsRepository)
│   │   ├── subscription-service.ts  # StatsPollService — shared 1s poll, broadcasts to SSE clients
│   │   └── migrate.ts               # Database migration runner
│   ├── proxmox/
│   │   └── proxmox-poll-service.ts  # ProxmoxPollService — shared API poll + SSE broadcast
│   ├── settings/
│   │   └── settings-broadcast-service.ts  # PostgreSQL LISTEN + SSE broadcast for settings changes
│   ├── parsers/                     # Stream parsers (ZFS iostat, text lines)
│   ├── test/                        # Test utilities and helpers
│   ├── utils/
│   │   ├── docker-hierarchy-builder.ts  # Wide rows → domain objects + host/container hierarchy
│   │   ├── zfs-hierarchy-builder.ts     # Wide rows → domain objects + pool/vdev/disk hierarchy
│   │   ├── icon-resolver.ts             # Auto-resolve icons from Docker image names
│   │   └── available-icons.ts           # Icon slug registry (dashboard-icons)
│   ├── streaming/types.ts           # Core interfaces (StreamingClient, RateCalculator)
│   └── server-init.ts               # Server-side shutdown handlers
├── worker/
│   ├── collectors/                  # Background collectors (Docker, ZFS)
│   └── collector.ts                 # Worker entry point
├── types/                           # Domain types (Docker, ZFS)
├── formatters/metrics.ts            # Number formatting (%, bytes, bits)
├── routes/
│   ├── __root.tsx                   # HTML shell (SSR-safe, no MUI)
│   ├── api/
│   │   ├── docker-stats.ts          # Docker SSE endpoint
│   │   ├── zfs-stats.ts             # ZFS SSE endpoint
│   │   ├── proxmox-overview.ts      # Proxmox SSE endpoint
│   │   └── settings.ts              # Settings SSE endpoint (cross-browser sync)
│   ├── index.tsx                    # Docker page (/)
│   ├── proxmox.tsx                  # Proxmox page (/proxmox)
│   ├── settings.tsx                 # Settings page (/settings)
│   └── zfs.tsx                      # ZFS page (/zfs)
└── theme.ts                         # MUI Material theme config

public/icons/                        # SVG icons from homarr-labs/dashboard-icons
migrations/                          # SQL migrations (settings + TimescaleDB wide tables)
```
