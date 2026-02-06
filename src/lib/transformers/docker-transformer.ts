import type { LatestStatRow } from '@/lib/database/repositories/stats-repository';

/**
 * Docker stats reconstructed from database rows.
 * Contains only the fields stored in DB that the frontend needs.
 */
export interface DockerStatsFromDB {
  id: string;
  name: string;
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

/** Map of stat type name to the field path in DockerStatsFromDB */
const DOCKER_TYPE_MAP: Record<string, (stats: DockerStatsFromDB, value: number) => void> = {
  cpu_percent: (s, v) => (s.rates.cpuPercent = v),
  memory_usage: (s, v) => (s.memory_stats.usage = v),
  memory_limit: (s, v) => (s.memory_stats.limit = v),
  memory_percent: (s, v) => (s.rates.memoryPercent = v),
  network_rx_bytes_per_sec: (s, v) => (s.rates.networkRxBytesPerSec = v),
  network_tx_bytes_per_sec: (s, v) => (s.rates.networkTxBytesPerSec = v),
  block_io_read_bytes_per_sec: (s, v) => (s.rates.blockIoReadBytesPerSec = v),
  block_io_write_bytes_per_sec: (s, v) => (s.rates.blockIoWriteBytesPerSec = v),
};

/**
 * Creates an empty DockerStatsFromDB object with default values
 */
function createEmptyDockerStats(entityId: string): DockerStatsFromDB {
  return {
    id: entityId,
    name: entityId.substring(0, 12), // Docker short ID format
    timestamp: new Date(),
    rates: {
      cpuPercent: 0,
      memoryPercent: 0,
      networkRxBytesPerSec: 0,
      networkTxBytesPerSec: 0,
      blockIoReadBytesPerSec: 0,
      blockIoWriteBytesPerSec: 0,
    },
    memory_stats: {
      usage: 0,
      limit: 0,
    },
  };
}

/**
 * Transform flat database rows into DockerStatsFromDB objects.
 * Groups rows by entity (container ID) and maps type names to object fields.
 *
 * @param rows - Latest stat rows from the database
 * @returns Map of container ID to stats object
 */
export function transformDockerStats(rows: LatestStatRow[]): Map<string, DockerStatsFromDB> {
  const result = new Map<string, DockerStatsFromDB>();

  for (const row of rows) {
    let stats = result.get(row.entity);
    if (!stats) {
      stats = createEmptyDockerStats(row.entity);
      result.set(row.entity, stats);
    }

    // Update timestamp to the most recent
    if (row.timestamp > stats.timestamp) {
      stats.timestamp = row.timestamp;
    }

    // Apply the value to the appropriate field
    const setter = DOCKER_TYPE_MAP[row.type];
    if (setter) {
      setter(stats, row.value);
    }
  }

  return result;
}
