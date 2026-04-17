import type { DockerContainerInventory } from '@/types/docker-inventory';

export interface DockerContainer {
  name: string;
  cpuUtil: number; // percentage
  ramUtil: number; // percentage
  ioRead: number; // megabytes per second
  ioWrite: number; // megabytes per second
  networkRead: number; // megabits per second
  networkWrite: number; // megabits per second
  ioWait: number; // percentage
}

export type { ContainerStatsWithRates } from '../lib/rate-calculator';

/** Wide row from docker_stats hypertable */
export interface DockerStatsRow {
  time: string | Date;
  host: string;
  container_id: string;
  container_name: string | null;
  image: string | null;
  cpu_percent: number | null;
  memory_usage: number | null;
  memory_limit: number | null;
  memory_percent: number | null;
  network_rx_bytes_per_sec: number | null;
  network_tx_bytes_per_sec: number | null;
  block_io_read_bytes_per_sec: number | null;
  block_io_write_bytes_per_sec: number | null;
}

/**
 * Docker stats reconstructed from wide table rows.
 * Contains only the fields the frontend needs.
 */
export interface DockerStatsFromDB {
  id: string;
  /** Entity path used for icon storage: host/service_key (e.g. "myhost/media-stack/plex") */
  serviceKeyEntity: string;
  name: string;
  image: string;
  icon: string | null;
  stale: boolean;
  timestamp: Date;
  rates: {
    cpuPercent: number;
    memoryPercent: number;
    networkRxBytesPerSec: number;
    networkTxBytesPerSec: number;
    blockIoReadBytesPerSec: number;
    blockIoWriteBytesPerSec: number;
  };
  memory_stats: {
    usage: number;
    limit: number;
  };
}

/**
 * Common interface for container stats that works with both
 * direct streaming (ContainerStatsWithRates) and database-backed streaming (DockerStatsFromDB)
 */
export interface ContainerStatsDisplay {
  id: string;
  name: string;
  rates: {
    cpuPercent: number;
    memoryPercent: number;
    networkRxBytesPerSec: number;
    networkTxBytesPerSec: number;
    blockIoReadBytesPerSec: number;
    blockIoWriteBytesPerSec: number;
  };
}

/**
 * Hierarchical data structures for multi-host Docker dashboard
 */

/** Aggregated stats for a Docker host (calculated from containers) */
export interface HostAggregatedStats {
  /** Metric fields: computed over running containers with live stats only */
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
  blockIoReadBytesPerSec: number;
  blockIoWriteBytesPerSec: number;

  /** Count fields: include all containers regardless of state */
  containerCount: number;
  runningCount: number;
  stoppedCount: number;        // exited + dead
  restartingCount: number;
  pausedCount: number;
  otherCount: number;          // created, removing, unknown
  staleContainerCount: number; // running but no recent stats
}

// ─── Tagged-union row model for the DataTable tree structure ───────────────

interface DockerTableRowBase {
  id: string;
}

export interface DockerHostTableRow extends DockerTableRowBase {
  type: 'host';
  hostName: string;
  aggregated: HostAggregatedStats;
  totalHosts: number;
  children: DockerContainerTableRow[];
  /** True when ALL containers on this host are stale */
  isStale: boolean;
}

export interface DockerContainerTableRow extends DockerTableRowBase {
  type: 'container';
  hostName: string;
  /** Always present — provides state, name, image, timestamps */
  inventory: DockerContainerInventory;
  /** Present only when live metrics are available */
  stats?: DockerStatsFromDB;
  /** True when state === 'running' but no recent stats are available */
  isStale: boolean;
  chartData?: DockerStatsRow[];
  sparklineData?: import('@/hooks/useContainerChartData').SparklineData;
  dataPoints?: import('@/hooks/useContainerChartData').ChartDataPoint[];
}

export type DockerTableRow = DockerHostTableRow | DockerContainerTableRow;
