import type { LatestStatRow } from '@/lib/database/repositories/stats-repository';
import type { ZFSIOStatWithRates } from '@/types/zfs';

/**
 * ZFS stats reconstructed from database rows.
 * Uses the same type as direct streaming since we store all needed fields.
 */
export type ZFSStatsFromDB = ZFSIOStatWithRates;

/** Map of stat type name to the field setter in ZFSStatsFromDB */
const ZFS_TYPE_MAP: Record<string, (stats: ZFSStatsFromDB, value: number) => void> = {
  capacity_alloc: (s, v) => (s.capacity.alloc = v),
  capacity_free: (s, v) => (s.capacity.free = v),
  read_ops_per_sec: (s, v) => (s.rates.readOpsPerSec = v),
  write_ops_per_sec: (s, v) => (s.rates.writeOpsPerSec = v),
  read_bytes_per_sec: (s, v) => (s.rates.readBytesPerSec = v),
  write_bytes_per_sec: (s, v) => (s.rates.writeBytesPerSec = v),
  utilization_percent: (s, v) => (s.rates.utilizationPercent = v),
};

/**
 * Determines the hierarchy level and indent from an entity path.
 * - "poolname" → pool, indent 0
 * - "poolname/vdevname" → vdev, indent 2
 * - "poolname/vdevname/diskname" → disk, indent 4
 */
function parseEntityPath(entityPath: string): { name: string; indent: number } {
  const parts = entityPath.split('/');

  if (parts.length === 1) {
    // Pool: just the pool name
    return { name: parts[0], indent: 0 };
  } else if (parts.length === 2) {
    // Vdev: pool/vdev
    return { name: parts[1], indent: 2 };
  } else {
    // Disk: pool/vdev/disk (or deeper)
    return { name: parts[parts.length - 1], indent: 4 };
  }
}

/**
 * Creates an empty ZFSStatsFromDB object with default values
 */
function createEmptyZFSStats(entityPath: string): ZFSStatsFromDB {
  const { name, indent } = parseEntityPath(entityPath);

  return {
    id: entityPath,
    name,
    indent,
    timestamp: Date.now(),
    capacity: { alloc: 0, free: 0 },
    operations: { read: 0, write: 0 },
    bandwidth: { read: 0, write: 0 },
    total: { readOps: 0, writeOps: 0, readBytes: 0, writeBytes: 0 },
    rates: {
      readOpsPerSec: 0,
      writeOpsPerSec: 0,
      readBytesPerSec: 0,
      writeBytesPerSec: 0,
      utilizationPercent: 0,
    },
  };
}

/**
 * Compare function to sort ZFS stats in hierarchy order for buildHierarchy().
 * Sorts by full entity path to keep parent-child relationships together:
 *   "backup", "backup/raidz1-0", "backup/raidz1-0/sda", "tank", "tank/mirror-0", etc.
 *
 * This is critical because buildHierarchy() processes items sequentially and
 * expects children to immediately follow their parents.
 */
function compareZFSStats(a: ZFSStatsFromDB, b: ZFSStatsFromDB): number {
  return a.id.localeCompare(b.id);
}

/**
 * Sort ZFS stats array in hierarchy order for buildHierarchy().
 * Returns a new sorted array.
 */
export function sortZFSStats(stats: ZFSStatsFromDB[]): ZFSStatsFromDB[] {
  return [...stats].sort(compareZFSStats);
}

/**
 * Transform flat database rows into ZFSStatsFromDB objects.
 * Reconstructs hierarchy from entity paths and orders correctly for buildHierarchy().
 *
 * @param rows - Latest stat rows from the database
 * @returns Map of entity path to stats object
 */
export function transformZFSStats(rows: LatestStatRow[]): Map<string, ZFSStatsFromDB> {
  const result = new Map<string, ZFSStatsFromDB>();

  for (const row of rows) {
    let stats = result.get(row.entity);
    if (!stats) {
      stats = createEmptyZFSStats(row.entity);
      result.set(row.entity, stats);
    }

    // Update timestamp to the most recent
    const rowTimestamp = row.timestamp.getTime();
    if (rowTimestamp > stats.timestamp) {
      stats.timestamp = rowTimestamp;
    }

    // Apply the value to the appropriate field
    const setter = ZFS_TYPE_MAP[row.type];
    if (setter) {
      setter(stats, row.value);
    }

    // Also set operations to match rates (they're the same for rate-based stats)
    stats.operations.read = stats.rates.readOpsPerSec;
    stats.operations.write = stats.rates.writeOpsPerSec;
    stats.bandwidth.read = stats.rates.readBytesPerSec;
    stats.bandwidth.write = stats.rates.writeBytesPerSec;
  }

  return result;
}

/**
 * Filters ZFS stats based on visibility state.
 *
 * @param allStats - All ZFS stats from the cache
 * @param expandedPools - Set of pool names that are expanded
 * @param expandedVdevs - Set of vdev paths (pool/vdev) that are expanded
 * @returns Filtered stats that should be visible to the client
 */
export function filterVisibleZFSStats(
  allStats: Map<string, ZFSStatsFromDB>,
  expandedPools?: string[],
  expandedVdevs?: string[]
): ZFSStatsFromDB[] {
  const expandedPoolsSet = new Set(expandedPools ?? []);
  const expandedVdevsSet = new Set(expandedVdevs ?? []);
  const visible: ZFSStatsFromDB[] = [];

  for (const [entityPath, stats] of allStats) {
    const parts = entityPath.split('/');

    if (parts.length === 1) {
      // Pool: always visible
      visible.push(stats);
    } else if (parts.length === 2) {
      // Vdev: visible if parent pool is expanded
      const poolName = parts[0];
      if (expandedPoolsSet.has(poolName)) {
        visible.push(stats);
      }
    } else {
      // Disk: visible if parent vdev is expanded
      const vdevPath = parts.slice(0, 2).join('/');
      if (expandedVdevsSet.has(vdevPath)) {
        visible.push(stats);
      }
    }
  }

  return visible.sort(compareZFSStats);
}
