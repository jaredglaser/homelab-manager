/** Device groups in the order the page lists them after a pool's data devices. */
export const ZFS_GROUP_KINDS = ['special', 'dedup', 'logs', 'cache', 'spares'] as const;
export type ZfsGroupKind = (typeof ZFS_GROUP_KINDS)[number];

/** `host` is a host-level row with no pool, written for a sample in which the node had no pool imported. */
export const ZFS_ENTITY_TYPE_VALUES = ['pool', 'group', 'vdev', 'disk', 'host'] as const;
export type ZFSEntityType = (typeof ZFS_ENTITY_TYPE_VALUES)[number];

/** Wide row from zfs_stats hypertable */
export interface ZFSStatsRow {
  /** Epoch ms, converted at the repository read path */
  time: number;
  host: string;
  pool: string;
  entity: string;
  entity_type: ZFSEntityType;
  indent: number;
  capacity_alloc: number | null;
  capacity_free: number | null;
  read_ops_per_sec: number | null;
  write_ops_per_sec: number | null;
  read_bytes_per_sec: number | null;
  write_bytes_per_sec: number | null;
  utilization_percent: number | null;
}

/** A device or device group below a pool. `id` is host-prefixed, so it is unique across hosts. */
export interface ZFSTreeNode {
  id: string;
  name: string;
  type: 'group' | 'vdev' | 'disk';
  /** Set on group nodes only. */
  group?: ZfsGroupKind;
  row: ZFSStatsRow;
  children: ZFSTreeNode[];
}

export interface ZFSPoolNode {
  id: string;
  name: string;
  row: ZFSStatsRow;
  /** Data devices sorted by name, then device groups in `ZFS_GROUP_KINDS` order. */
  children: ZFSTreeNode[];
}

/** Pools by pool name, sorted by name. */
export type ZFSHierarchy = Map<string, ZFSPoolNode>;

/** Aggregated stats for a ZFS host (summed from pools) */
export interface ZFSHostAggregatedStats {
  capacityAlloc: number;
  capacityFree: number;
  readOpsPerSec: number;
  writeOpsPerSec: number;
  readBytesPerSec: number;
  writeBytesPerSec: number;
  poolCount: number;
}

/** ZFS host with its pool hierarchy */
export interface ZFSHostStats {
  hostName: string;
  aggregated: ZFSHostAggregatedStats;
  pools: ZFSHierarchy;
}

/** Complete multi-host ZFS hierarchy: hosts -> pools -> devices */
export type ZFSHostHierarchy = Map<string, ZFSHostStats>;
