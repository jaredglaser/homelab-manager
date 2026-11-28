import { z } from 'zod';
import {
  zZfsDeviceErrors,
  zZfsHealthState,
  zZfsScan,
  type ZfsGroupKind,
} from '@homelab-manager/agent/types/protocol';

/**
 * `host` and `agent_outdated` are host-level rows with no pool: `host` stands for a sample with no pools
 * imported, and `agent_outdated` is written while the host's agent is too old to send pool trees.
 */
export const ZFS_ENTITY_TYPE_VALUES = ['pool', 'group', 'vdev', 'disk', 'host', 'agent_outdated'] as const;
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

/** The health of one pool, group, vdev or disk. `entity` is the node's `zfs_stats` entity. A group has no state. */
export const zZFSNodeHealth = z.object({
  entity: z.string().min(1),
  entityType: z.enum(['pool', 'group', 'vdev', 'disk']),
  state: zZfsHealthState.nullable(),
  errors: zZfsDeviceErrors.nullable(),
});
export type ZFSNodeHealth = z.infer<typeof zZFSNodeHealth>;

/** `nodes` starts with the pool's own node, then its devices in tree order. */
export const zZFSPoolHealth = z.object({
  pool: z.string().min(1),
  scan: zZfsScan.nullable(),
  nodes: z.array(zZFSNodeHealth).min(1),
});
export type ZFSPoolHealth = z.infer<typeof zZFSPoolHealth>;

export const zZFSHostHealth = z.object({
  host: z.string().min(1),
  /** False while the agent cannot read pool health. `pools` is then the last health it could read. */
  readable: z.boolean(),
  /** False while the worker has no stream from the agent. `pools` is then as it was at `lastSeenAt`. */
  connected: z.boolean(),
  /** Epoch ms. */
  lastSeenAt: z.number(),
  pools: z.array(zZFSPoolHealth),
});
export type ZFSHostHealth = z.infer<typeof zZFSHostHealth>;
