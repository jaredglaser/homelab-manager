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

// Re-export the DB type for convenience
export type { DockerStatsFromDB } from '../lib/transformers/docker-transformer';

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
  data: import('../lib/transformers/docker-transformer').DockerStatsFromDB;
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
