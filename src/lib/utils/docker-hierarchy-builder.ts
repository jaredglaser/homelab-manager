import type {
  DockerStatsRow,
  DockerStatsFromDB,
  HostAggregatedStats,
  DockerHostTableRow,
  DockerContainerTableRow,
} from '@/types/docker';
import type { DockerInventorySnapshotContainer } from '@/types/docker-inventory';

/**
 * Compute a stable service key for a Docker container.
 *
 * Prefers Docker Compose labels `com.docker.compose.project` and `com.docker.compose.service` when present.
 * Any `/` characters in the label values are replaced with `-` to keep the single `/` delimiter unambiguous.
 *
 * @param labels - Optional map of Docker labels; used to derive `project/service` if both compose labels exist
 * @param containerName - Fallback container name to use when compose labels are not available
 * @returns The service key as `"{project}/{service}"` (slashes in labels sanitized) when both compose labels are present, otherwise `containerName`
 */
export function computeServiceKey(
  labels: Record<string, string> | undefined,
  containerName: string,
): string {
  const project = labels?.['com.docker.compose.project']?.replaceAll('/', '-');
  const service = labels?.['com.docker.compose.service']?.replaceAll('/', '-');
  return project && service ? `${project}/${service}` : containerName;
}

/**
 * Converts a raw DockerStatsRow into a DockerStatsFromDB object tailored for UI consumption.
 *
 * @param row - The source wide-format Docker stats row.
 * @param icon - Optional icon identifier to attach to the resulting entity.
 * @param serviceKeyEntity - Optional stable service key to use; when omitted `host/container_name` is used
 *   (matching the worker's `computeServiceKey` fallback) so recreated containers naturally deduplicate.
 * @returns A DockerStatsFromDB object with:
 *  - `id` set to `host/container_id`,
 *  - `serviceKeyEntity` set to the provided value or `host/container_name`,
 *  - `name` using `container_name` or the first 12 characters of `container_id`,
 *  - numeric rate fields defaulted to `0` when missing,
 *  - `memory_stats.usage` and `memory_stats.limit` coerced to numbers,
 *  - `timestamp` created from `row.time`, and
 *  - `stale` initialized to `false`.
 */
export function rowToDockerStats(
  row: DockerStatsRow,
  icon: string | null = null,
  serviceKeyEntity: string | null = null,
): DockerStatsFromDB {
  const entityId = `${row.host}/${row.container_id}`;
  const name = row.container_name || row.container_id.substring(0, 12);
  return {
    id: entityId,
    serviceKeyEntity: serviceKeyEntity ?? `${row.host}/${name}`,
    name,
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
      usage: Number(row.memory_usage ?? 0),
      limit: Number(row.memory_limit ?? 0),
    },
  };
}

/**
 * Bucket a Docker container state into one of the summary categories.
 *
 * @param state - Raw container state string from Docker
 * @returns `"running"`, `"stopped"`, `"restarting"`, `"paused"`, or `"other"`
 */
export function bucketContainerState(
  state: string,
): 'running' | 'stopped' | 'restarting' | 'paused' | 'other' {
  switch (state) {
    case 'running':
      return 'running';
    case 'exited':
    case 'dead':
      return 'stopped';
    case 'restarting':
      return 'restarting';
    case 'paused':
      return 'paused';
    default:
      return 'other';
  }
}

/** Total container count derived from bucket counts (no separate field to drift). */
export function totalContainers(agg: HostAggregatedStats): number {
  return agg.runningCount + agg.stoppedCount + agg.restartingCount + agg.pausedCount + agg.otherCount;
}

/** State sort priority for container rows (lower = shown first) */
const STATE_SORT_ORDER: Record<string, number> = {
  running: 0,
  restarting: 1,
  paused: 2,
  exited: 3,
  dead: 3,
  created: 4,
  removing: 4,
  unknown: 4,
};

function getStateSortPriority(state: string): number {
  return STATE_SORT_ORDER[state] ?? 4;
}

/**
 * Build a flat container row from inventory, merging in live stats when available.
 * Determines `isStale` based on whether stats are missing for a running container.
 */
function buildContainerRow(
  entityId: string,
  inventory: DockerInventorySnapshotContainer,
  stats: Map<string, DockerStatsFromDB>,
  hostName: string,
): DockerContainerTableRow {
  const liveStats = stats.get(entityId);
  const isStale = inventory.state === 'running' && !liveStats;

  return {
    type: 'container',
    id: entityId,
    hostName,
    inventory,
    stats: liveStats,
    isStale,
  };
}

/**
 * Compute HostAggregatedStats from a list of container rows with optional live stats.
 * Metrics are summed over running containers with live stats only.
 * Count fields cover all containers regardless of state.
 */
function computeHostAggregates(containers: DockerContainerTableRow[]): HostAggregatedStats {
  let cpuPercent = 0;
  let memoryUsage = 0;
  let memoryLimit = 0;
  let networkRxBytesPerSec = 0;
  let networkTxBytesPerSec = 0;
  let blockIoReadBytesPerSec = 0;
  let blockIoWriteBytesPerSec = 0;
  let runningCount = 0;
  let stoppedCount = 0;
  let restartingCount = 0;
  let pausedCount = 0;
  let otherCount = 0;
  let staleContainerCount = 0;

  for (const c of containers) {
    const { state } = c.inventory;

    const bucket = bucketContainerState(state);
    if (bucket === 'running') {
      runningCount++;
    } else if (bucket === 'stopped') {
      stoppedCount++;
    } else if (bucket === 'restarting') {
      restartingCount++;
    } else if (bucket === 'paused') {
      pausedCount++;
    } else {
      otherCount++;
    }

    if (c.isStale) {
      staleContainerCount++;
      continue;
    }

    if ((state === 'running' || state === 'restarting') && c.stats) {
      const { rates, memory_stats } = c.stats;
      cpuPercent += rates.cpuPercent;
      memoryUsage += memory_stats.usage;
      memoryLimit += memory_stats.limit;
      networkRxBytesPerSec += rates.networkRxBytesPerSec;
      networkTxBytesPerSec += rates.networkTxBytesPerSec;
      blockIoReadBytesPerSec += rates.blockIoReadBytesPerSec;
      blockIoWriteBytesPerSec += rates.blockIoWriteBytesPerSec;
    }
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
    runningCount,
    stoppedCount,
    restartingCount,
    pausedCount,
    otherCount,
    staleContainerCount,
  };
}

/**
 * Hierarchy build result: flat list of host rows suitable for `DataTable`.
 * Each host row carries its container children, sorted by state then name.
 */
export interface DockerTableHierarchy {
  hosts: DockerHostTableRow[];
}

/**
 * Inventory-only skeleton of the hierarchy: deduped containers grouped per host
 * with final row order already applied. Stats-free so callers can memoize it on
 * inventory changes alone; stats flush every second while inventory changes rarely.
 */
export interface DockerInventoryHierarchy {
  /** Host names sorted ascending; drives host row order */
  hostNames: string[];
  /** Deduped containers per host, sorted by state priority then name */
  containersByHost: Map<string, DockerInventorySnapshotContainer[]>;
}

/**
 * Build the inventory-driven part of the hierarchy: serviceKey dedup, grouping
 * by host, and row ordering. No stats involved.
 *
 * ServiceKey deduplication: within a host, only the most recently started
 * container per `serviceKey` is kept (max `startedAt`, fallback `updatedAt`).
 *
 * @param inventory - Map of `host/containerId` → `DockerInventorySnapshotContainer`
 */
export function buildDockerInventoryHierarchy(
  inventory: Map<string, DockerInventorySnapshotContainer>,
): DockerInventoryHierarchy {
  const dedupedByHostServiceKey = new Map<string, DockerInventorySnapshotContainer>();

  for (const [, inv] of inventory) {
    const hostName = inv.host;
    // Use the pre-computed serviceKey stored on inventory (written by the worker from labels at
    // write time). This avoids re-deriving the key from labels which are omitted on streaming
    // upsert NOTIFY events, where falling back to inv.name would shift the dedup identity.
    const sk = inv.serviceKey || inv.name;
    const dedupKey = `${hostName}/${sk}`;

    const existing = dedupedByHostServiceKey.get(dedupKey);
    if (!existing) {
      dedupedByHostServiceKey.set(dedupKey, inv);
      continue;
    }

    const existingTime = existing.startedAt?.getTime() ?? existing.updatedAt.getTime();
    const newTime = inv.startedAt?.getTime() ?? inv.updatedAt.getTime();
    if (newTime > existingTime) {
      dedupedByHostServiceKey.set(dedupKey, inv);
    }
  }

  const containersByHost = new Map<string, DockerInventorySnapshotContainer[]>();

  for (const [, inv] of dedupedByHostServiceKey) {
    let bucket = containersByHost.get(inv.host);
    if (!bucket) {
      bucket = [];
      containersByHost.set(inv.host, bucket);
    }
    bucket.push(inv);
  }

  for (const containers of containersByHost.values()) {
    containers.sort((a, b) => {
      const stateDiff = getStateSortPriority(a.state) - getStateSortPriority(b.state);
      if (stateDiff !== 0) return stateDiff;
      return a.name.localeCompare(b.name);
    });
  }

  const hostNames = [...containersByHost.keys()].sort((a, b) => a.localeCompare(b));

  return { hostNames, containersByHost };
}

/**
 * Merge live stats into an inventory hierarchy skeleton to produce table rows.
 *
 * Linear pass: per-container stats lookup plus host aggregates. Absence of
 * stats for a running container sets `isStale = true`.
 *
 * @param hierarchy - Skeleton from {@link buildDockerInventoryHierarchy}
 * @param stats - Map of `host/containerId` → `DockerStatsFromDB`
 */
export function attachStatsToHierarchy(
  hierarchy: DockerInventoryHierarchy,
  stats: Map<string, DockerStatsFromDB>,
): DockerTableHierarchy {
  const totalHosts = hierarchy.hostNames.length;

  const hosts: DockerHostTableRow[] = hierarchy.hostNames.map((hostName) => {
    const containers: DockerContainerTableRow[] = hierarchy.containersByHost
      .get(hostName)!
      .map((inv) => buildContainerRow(`${hostName}/${inv.containerId}`, inv, stats, hostName));
    const aggregated = computeHostAggregates(containers);
    const isStale =
      aggregated.staleContainerCount === aggregated.runningCount &&
      aggregated.runningCount > 0 &&
      totalContainers(aggregated) > 0;

    return {
      type: 'host',
      id: `host:${hostName}`,
      hostName,
      aggregated,
      totalHosts,
      children: containers,
      isStale,
    };
  });

  return { hosts };
}

/**
 * Build hierarchical table rows from inventory and live stats.
 *
 * Inventory is the **source of truth** for which containers exist.
 * Stats are merged in for running containers; absence of stats for a
 * running container sets `isStale = true`.
 *
 * Convenience composition of {@link buildDockerInventoryHierarchy} and
 * {@link attachStatsToHierarchy}; callers on a hot path should memoize the
 * two passes separately.
 *
 * @param inventory - Map of `host/containerId` → `DockerInventorySnapshotContainer`
 * @param stats - Map of `host/containerId` → `DockerStatsFromDB`
 */
export function buildDockerTableHierarchy(
  inventory: Map<string, DockerInventorySnapshotContainer>,
  stats: Map<string, DockerStatsFromDB>,
): DockerTableHierarchy {
  return attachStatsToHierarchy(buildDockerInventoryHierarchy(inventory), stats);
}
