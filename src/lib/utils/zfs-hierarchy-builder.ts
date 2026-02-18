import type { ZFSIOStatWithRates, ZFSStatsRow, ZFSHierarchy, PoolStats, VdevStats, DiskStats } from '../../types/zfs';

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
 */
export function rowToZFSStats(row: ZFSStatsRow): ZFSIOStatWithRates {
  return {
    id: row.entity,
    name: nameFromEntity(row.entity),
    indent: row.indent,
    timestamp: new Date(row.time).getTime(),
    capacity: {
      alloc: row.capacity_alloc ?? 0,
      free: row.capacity_free ?? 0,
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
