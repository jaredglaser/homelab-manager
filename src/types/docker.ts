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
