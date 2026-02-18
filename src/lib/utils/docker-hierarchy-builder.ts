import type {
  DockerStatsRow,
  DockerStatsFromDB,
  DockerHierarchy,
  HostAggregatedStats,
  ContainerStats,
} from '@/types/docker';

/**
 * Convert a wide DockerStatsRow to DockerStatsFromDB for UI consumption.
 * Metadata (icon) is resolved separately.
 */
export function rowToDockerStats(
  row: DockerStatsRow,
  icon: string | null = null,
): DockerStatsFromDB {
  const entityId = `${row.host}/${row.container_id}`;
  return {
    id: entityId,
    name: row.container_name || row.container_id.substring(0, 12),
    image: row.image || '',
    icon,
    stale: false,
    timestamp: new Date(row.time),
    rates: {
      cpuPercent: row.cpu_percent ?? 0,
      memoryPercent: row.memory_percent ?? 0,
      networkRxBytesPerSec: row.network_rx_bytes_per_sec ?? 0,
      networkTxBytesPerSec: row.network_tx_bytes_per_sec ?? 0,
      blockIoReadBytesPerSec: row.block_io_read_bytes_per_sec ?? 0,
      blockIoWriteBytesPerSec: row.block_io_write_bytes_per_sec ?? 0,
    },
    memory_stats: {
      usage: row.memory_usage ?? 0,
      limit: row.memory_limit ?? 0,
    },
  };
}

/**
 * Parse entity path to extract host and container ID
 * Entity format: "hostname/container-id"
 */
function parseEntityPath(entityPath: string): { hostName: string; containerId: string } {
  const slashIndex = entityPath.indexOf('/');
  if (slashIndex === -1) {
    throw new Error(`Invalid entity path format: ${entityPath}. Expected "host/container-id"`);
  }
  return {
    hostName: entityPath.substring(0, slashIndex),
    containerId: entityPath.substring(slashIndex + 1),
  };
}

/**
 * Calculate aggregated stats for a host from its containers
 */
function calculateHostAggregates(containers: Map<string, ContainerStats>): HostAggregatedStats {
  let cpuPercent = 0;
  let memoryUsage = 0;
  let memoryLimit = 0;
  let networkRxBytesPerSec = 0;
  let networkTxBytesPerSec = 0;
  let blockIoReadBytesPerSec = 0;
  let blockIoWriteBytesPerSec = 0;
  let staleContainerCount = 0;

  for (const container of containers.values()) {
    if (container.data.stale) {
      staleContainerCount++;
      continue;
    }
    const { rates, memory_stats } = container.data;
    cpuPercent += rates.cpuPercent;
    memoryUsage += memory_stats.usage;
    memoryLimit += memory_stats.limit;
    networkRxBytesPerSec += rates.networkRxBytesPerSec;
    networkTxBytesPerSec += rates.networkTxBytesPerSec;
    blockIoReadBytesPerSec += rates.blockIoReadBytesPerSec;
    blockIoWriteBytesPerSec += rates.blockIoWriteBytesPerSec;
  }

  const memoryPercent = memoryLimit > 0 ? (memoryUsage / memoryLimit) * 100 : 0;

  return {
    cpuPercent,
    memoryUsage,
    memoryLimit,
    memoryPercent,
    networkRxBytesPerSec,
    networkTxBytesPerSec,
    blockIoReadBytesPerSec,
    blockIoWriteBytesPerSec,
    containerCount: containers.size,
    staleContainerCount,
  };
}

/**
 * Build hierarchical structure from flat array of Docker stats
 * Groups containers by host and calculates aggregated host-level stats
 *
 * @param stats - Array of Docker stats from DB
 * @returns Hierarchical Map structure: host -> containers
 */
export function buildDockerHierarchy(stats: DockerStatsFromDB[]): DockerHierarchy {
  const hierarchy: DockerHierarchy = new Map();

  // Group containers by host
  for (const stat of stats) {
    const { hostName } = parseEntityPath(stat.id);

    let hostStats = hierarchy.get(hostName);
    if (!hostStats) {
      hostStats = {
        hostName,
        aggregated: {
          cpuPercent: 0,
          memoryUsage: 0,
          memoryLimit: 0,
          memoryPercent: 0,
          networkRxBytesPerSec: 0,
          networkTxBytesPerSec: 0,
          blockIoReadBytesPerSec: 0,
          blockIoWriteBytesPerSec: 0,
          containerCount: 0,
          staleContainerCount: 0,
        },
        containers: new Map(),
        isStale: false,
      };
      hierarchy.set(hostName, hostStats);
    }

    hostStats.containers.set(stat.id, { data: stat });
  }

  // Calculate aggregates for each host
  for (const hostStats of hierarchy.values()) {
    hostStats.aggregated = calculateHostAggregates(hostStats.containers);
    hostStats.isStale =
      hostStats.aggregated.staleContainerCount === hostStats.containers.size &&
      hostStats.containers.size > 0;
  }

  // Sort hosts alphabetically and containers within each host by name
  // This ensures stable ordering regardless of database row order
  const sorted: DockerHierarchy = new Map();
  const sortedHostNames = [...hierarchy.keys()].sort((a, b) => a.localeCompare(b));

  for (const hostName of sortedHostNames) {
    const host = hierarchy.get(hostName)!;
    const sortedContainers = new Map(
      [...host.containers.entries()].sort(([, a], [, b]) =>
        a.data.name.localeCompare(b.data.name),
      ),
    );
    sorted.set(hostName, { ...host, containers: sortedContainers });
  }

  return sorted;
}
