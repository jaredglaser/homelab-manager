import type {
  ZFSIOStatWithRates,
  ZFSStatsRow,
  ZFSHierarchy,
  ZFSHostHierarchy,
  ZFSHostStats,
  ZFSHostAggregatedStats,
  PoolStats,
  VdevStats,
  DiskStats,
} from '../../types/zfs';

/**
 * Detects the hierarchy level based on indentation from zpool iostat -vvv output
 *   indent 0  → pool (top-level)
 *   indent 2  → vdev (mirror-N, raidz-N, or single-disk acting as vdev)
 *   indent 4+ → disk (individual drive under a vdev)
 */
function detectHierarchyLevel(indent: number): 'pool' | 'vdev' | 'disk' {
  if (indent <= 0) return 'pool';
  if (indent <= 2) return 'vdev';
  return 'disk';
}

/**
 * Determines the name from an entity path.
 * - "poolname" → "poolname"
 * - "poolname/vdevname" → "vdevname"
 * - "poolname/vdevname/diskname" → "diskname"
 */
function nameFromEntity(entity: string): string {
  const parts = entity.split('/');
  return parts[parts.length - 1];
}

/**
 * Convert a ZFSStatsRow (wide table row) to ZFSIOStatWithRates for UI consumption.
 * The id uses the host-prefixed entity path for multi-host deduplication.
 */
export function rowToZFSStats(row: ZFSStatsRow): ZFSIOStatWithRates {
  const id = row.host ? `${row.host}/${row.entity}` : row.entity;
  return {
    id,
    name: nameFromEntity(row.entity),
    indent: row.indent,
    timestamp: new Date(row.time).getTime(),
    capacity: {
      alloc: Number(row.capacity_alloc ?? 0),
      free: Number(row.capacity_free ?? 0),
    },
    operations: {
      read: row.read_ops_per_sec ?? 0,
      write: row.write_ops_per_sec ?? 0,
    },
    bandwidth: {
      read: row.read_bytes_per_sec ?? 0,
      write: row.write_bytes_per_sec ?? 0,
    },
    total: { readOps: 0, writeOps: 0, readBytes: 0, writeBytes: 0 },
    rates: {
      readOpsPerSec: row.read_ops_per_sec ?? 0,
      writeOpsPerSec: row.write_ops_per_sec ?? 0,
      readBytesPerSec: row.read_bytes_per_sec ?? 0,
      writeBytesPerSec: row.write_bytes_per_sec ?? 0,
      utilizationPercent: row.utilization_percent ?? 0,
    },
  };
}

/**
 * Build hierarchical structure from flat array of ZFS stats
 * Organizes pools -> vdevs -> disks based on sequence and capacity
 *
 * @param stats - Flat array of ZFS iostat stats
 * @returns Hierarchical Map structure
 */
export function buildHierarchy(stats: ZFSIOStatWithRates[]): ZFSHierarchy {
  const hierarchy: ZFSHierarchy = new Map();

  let currentPool: PoolStats | null = null;
  let currentVdev: VdevStats | null = null;

  for (const stat of stats) {
    const level = detectHierarchyLevel(stat.indent);

    switch (level) {
      case 'pool': {
        // Start a new pool
        currentPool = {
          data: stat,
          vdevs: new Map(),
          individualDisks: new Map(),
        };
        currentVdev = null; // Reset current vdev
        hierarchy.set(stat.name, currentPool);
        break;
      }

      case 'vdev': {
        if (!currentPool) {
          console.warn('[buildHierarchy] Found vdev without pool:', stat.name);
          continue;
        }

        // Add vdev to current pool
        currentVdev = {
          data: stat,
          disks: new Map(),
        };
        currentPool.vdevs.set(stat.name, currentVdev);
        break;
      }

      case 'disk': {
        if (!currentPool) {
          console.warn('[buildHierarchy] Found disk without pool:', stat.name);
          continue;
        }

        const diskStats: DiskStats = { data: stat };

        // If we have a current vdev, add disk to it
        if (currentVdev) {
          currentVdev.disks.set(stat.name, diskStats);
        } else {
          // Otherwise, it's an individual disk directly under the pool
          currentPool.individualDisks.set(stat.name, diskStats);
        }
        break;
      }
    }
  }

  return hierarchy;
}

/**
 * Calculate aggregated stats for a ZFS host from its pools
 */
function calculateHostAggregates(pools: ZFSHierarchy): ZFSHostAggregatedStats {
  let capacityAlloc = 0;
  let capacityFree = 0;
  let readOpsPerSec = 0;
  let writeOpsPerSec = 0;
  let readBytesPerSec = 0;
  let writeBytesPerSec = 0;

  for (const pool of pools.values()) {
    capacityAlloc += pool.data.capacity.alloc;
    capacityFree += pool.data.capacity.free;
    readOpsPerSec += pool.data.rates.readOpsPerSec;
    writeOpsPerSec += pool.data.rates.writeOpsPerSec;
    readBytesPerSec += pool.data.rates.readBytesPerSec;
    writeBytesPerSec += pool.data.rates.writeBytesPerSec;
  }

  return {
    capacityAlloc,
    capacityFree,
    readOpsPerSec,
    writeOpsPerSec,
    readBytesPerSec,
    writeBytesPerSec,
    poolCount: pools.size,
  };
}

/**
 * Build multi-host ZFS hierarchy from flat array of ZFS stats rows.
 * Groups by host first, then builds pool -> vdev -> disk hierarchy within each host.
 *
 * @param rows - Flat array of ZFS stats rows from the database
 * @returns Multi-host hierarchical structure: hosts -> pools -> vdevs -> disks
 */
export function buildZFSHostHierarchy(rows: ZFSStatsRow[]): ZFSHostHierarchy {
  // Group rows by host
  const rowsByHost = new Map<string, ZFSStatsRow[]>();
  for (const row of rows) {
    const hostName = row.host || '';
    let hostRows = rowsByHost.get(hostName);
    if (!hostRows) {
      hostRows = [];
      rowsByHost.set(hostName, hostRows);
    }
    hostRows.push(row);
  }

  const hierarchy: ZFSHostHierarchy = new Map();

  for (const [hostName, hostRows] of rowsByHost) {
    // Convert rows to stats and sort by entity path
    const stats: ZFSIOStatWithRates[] = hostRows.map(r => rowToZFSStats(r));
    stats.sort((a, b) => a.id.localeCompare(b.id));

    const pools = buildHierarchy(stats);

    const hostStats: ZFSHostStats = {
      hostName,
      aggregated: calculateHostAggregates(pools),
      pools,
    };

    hierarchy.set(hostName, hostStats);
  }

  // Sort hosts alphabetically
  const sorted: ZFSHostHierarchy = new Map(
    [...hierarchy.entries()].sort(([a], [b]) => a.localeCompare(b))
  );

  return sorted;
}
