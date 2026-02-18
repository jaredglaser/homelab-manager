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
  cpuPercent: number;
  memoryUsage: number;
  memoryLimit: number;
  memoryPercent: number;
  networkRxBytesPerSec: number;
  networkTxBytesPerSec: number;
  blockIoReadBytesPerSec: number;
  blockIoWriteBytesPerSec: number;
  containerCount: number;
  staleContainerCount: number;
}

/** Container stats within a host */
export interface ContainerStats {
  data: DockerStatsFromDB;
}

/** Docker host with its containers */
export interface HostStats {
  hostName: string;
  aggregated: HostAggregatedStats;
  containers: Map<string, ContainerStats>;
  isStale: boolean; // True when ALL containers are stale (host connectivity issue)
}

/** Complete Docker hierarchy: hosts -> containers */
export type DockerHierarchy = Map<string, HostStats>;
