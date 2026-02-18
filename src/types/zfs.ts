/**
 * ZFS pool statistics types
 */

/**
 * Raw ZFS iostat data (one line of output from zpool iostat)
 */
export interface ZFSIOStatRaw {
  /** Pool or device name */
  name: string;

  /** Indentation level from zpool iostat output (0=pool, 2=vdev, 4+=disk) */
  indent: number;

  /** Capacity metrics */
  capacity: {
    alloc: number; // bytes allocated
    free: number;  // bytes free
  };

  /** Operations per second */
  operations: {
    read: number;  // read ops/s
    write: number; // write ops/s
  };

  /** Bandwidth (bytes/sec) */
  bandwidth: {
    read: number;  // bytes/s
    write: number; // bytes/s
  };

  /** Total operations and bytes (cumulative counters) */
  total: {
    readOps: number;
    writeOps: number;
    readBytes: number;
    writeBytes: number;
  };
}

/**
 * ZFS iostat with calculated rates
 */
export interface ZFSIOStatWithRates extends ZFSIOStatRaw {
  id: string;
  timestamp: number;
  rates: {
    readOpsPerSec: number;
    writeOpsPerSec: number;
    readBytesPerSec: number;
    writeBytesPerSec: number;
    utilizationPercent: number;
  };
}

/** Wide row from zfs_stats hypertable */
export interface ZFSStatsRow {
  time: string | Date;
  pool: string;
  entity: string;
  entity_type: string; // 'pool', 'vdev', 'disk'
  indent: number;
  capacity_alloc: number | null;
  capacity_free: number | null;
  read_ops_per_sec: number | null;
  write_ops_per_sec: number | null;
  read_bytes_per_sec: number | null;
  write_bytes_per_sec: number | null;
  utilization_percent: number | null;
}

/**
 * Configuration for ZFS monitoring
 */
export interface ZFSMonitorConfig {
  /** SSH connection details */
  ssh: {
    host: string;
    port: number;
    username: string;
    privateKeyPath?: string;
    password?: string;
  };

  /** Pool names to monitor (empty = all pools) */
  pools?: string[];

  /** Update interval in seconds (for iostat -v 1) */
  interval?: number;
}

/**
 * ZFS pool information (from zpool list)
 */
export interface ZFSPool {
  name: string;
  size: string;
  allocated: string;
  free: string;
  capacity: string;
  health: string;
}

/**
 * Hierarchical data structures for ZFS dashboard
 */

/** Individual disk stats */
export interface DiskStats {
  data: ZFSIOStatWithRates;
}

/** Vdev with its disks */
export interface VdevStats {
  data: ZFSIOStatWithRates;
  disks: Map<string, DiskStats>;
}

/** Pool with its vdevs and individual disks (for single-disk pools) */
export interface PoolStats {
  data: ZFSIOStatWithRates;
  vdevs: Map<string, VdevStats>;
  individualDisks: Map<string, DiskStats>;
}

/** Complete ZFS hierarchy: pools -> vdevs -> disks */
export type ZFSHierarchy = Map<string, PoolStats>;
