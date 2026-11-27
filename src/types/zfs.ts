import type { ZfsGroupKind } from '@homelab-manager/agent/types/protocol';

/** `agent_outdated` is a host-level marker row with no pool, written while the host's agent is too old to send pool trees. */
export const ZFS_ENTITY_TYPE_VALUES = ['pool', 'group', 'vdev', 'disk', 'agent_outdated'] as const;
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
  /** The host's agent is too old to send pool trees, so it reports no pools. */
  agentOutdated: boolean;
  aggregated: ZFSHostAggregatedStats;
  pools: ZFSHierarchy;
}

/** Complete multi-host ZFS hierarchy: hosts -> pools -> devices */
export type ZFSHostHierarchy = Map<string, ZFSHostStats>;
