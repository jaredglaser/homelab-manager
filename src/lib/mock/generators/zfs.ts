import type { ZfsScan } from '@homelab-manager/agent/types/protocol';
import type { ZFSHostHealth, ZFSNodeHealth, ZFSPoolHealth, ZFSStatsRow } from '@/types/zfs';
import { generateActivityMetrics } from '@/lib/mock/patterns';
import { ZFS_ENTITIES } from '@/lib/mock/entities';

/**
 * Generate a single ZFS stats snapshot for a given timestamp.
 * Returns one row per entity (pool, group, vdev, disk), matching the `zfs_stats` hypertable schema.
 *
 * All entities in the same pool share an activity state (idle/low/med/high) so
 * that when the pool is streaming a file, every disk in that pool is active.
 * Per-entity noise is applied independently so individual disks vary naturally.
 */
export function generateZFSSnapshot(time: Date): ZFSStatsRow[] {
  const timeMs = time.getTime();

  return ZFS_ENTITIES.map((e) => {
    // Pool-level key drives the shared activity state - all disks/vdevs in a pool
    // transition together. Per-entity key provides independent noise variation.
    const activityKey = `${e.host}/${e.pool}`;
    const noiseKey    = `${e.host}/${e.pool}/${e.entity}`;
    const m = e.activity ? generateActivityMetrics(timeMs, activityKey, noiseKey, e.activity) : null;
    let utilization: number | null = null;
    if (e.capacityAlloc !== null && e.capacityFree !== null) {
      const total = e.capacityAlloc + e.capacityFree;
      utilization = total > 0 ? Math.round(e.capacityAlloc / total * 10_000) / 100 : 0;
    }

    return {
      time: timeMs,
      host: e.host,
      pool: e.pool,
      entity: e.entity,
      entity_type: e.entityType,
      indent: e.indent,
      capacity_alloc: e.capacityAlloc,
      capacity_free: e.capacityFree,
      read_ops_per_sec: m?.readOps ?? null,
      write_ops_per_sec: m?.writeOps ?? null,
      read_bytes_per_sec: m?.readBytes ?? null,
      write_bytes_per_sec: m?.writeBytes ?? null,
      utilization_percent: utilization,
    };
  });
}

/**
 * Generate `seconds` worth of historical ZFS data at 1-second intervals.
 * Rows are ordered oldest-first (ascending time).
 */
export function generateZFSHistory(seconds: number): ZFSStatsRow[] {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const now = Date.now();
  const rows: ZFSStatsRow[] = [];

  for (let i = s; i >= 0; i--) {
    const time = new Date(now - i * 1000);
    rows.push(...generateZFSSnapshot(time));
  }

  return rows;
}

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

type NodeOverride = Partial<Pick<ZFSNodeHealth, 'state' | 'errors'>>;

/** The demo's one failing disk: rust lost sdf, and its last scrub had found the checksum errors. */
const NODE_OVERRIDES: Readonly<Record<string, NodeOverride>> = {
  rust: { state: 'degraded' },
  'rust/raidz2-0': { state: 'degraded' },
  'rust/raidz2-0/sdf': { state: 'faulted', errors: { read: 3, write: 0, checksum: 12 } },
};

function demoScan(pool: string, now: number): ZfsScan | null {
  if (pool === 'application') return { kind: 'scrub', state: 'running', percentDone: 42, endedAt: null, repairedBytes: 0, errors: 0 };
  if (pool === 'rust') return { kind: 'scrub', state: 'finished', percentDone: null, endedAt: now - 4 * DAY_MS, repairedBytes: 0, errors: 0 };
  return null;
}

/** Health for every pool in `ZFS_ENTITIES`, on the same entities, as the zfs-health topic sends it. */
export function generateZFSHealthSnapshot(now: Date): ZFSHostHealth[] {
  const nowMs = now.getTime();
  const byHost = new Map<string, Map<string, ZFSPoolHealth>>();
  for (const e of ZFS_ENTITIES) {
    let pools = byHost.get(e.host);
    if (!pools) {
      pools = new Map();
      byHost.set(e.host, pools);
    }
    let pool = pools.get(e.pool);
    if (!pool) {
      pool = { pool: e.pool, scan: demoScan(e.pool, nowMs), nodes: [] };
      pools.set(e.pool, pool);
    }
    const isGroup = e.entityType === 'group';
    pool.nodes.push({
      entity: e.entity,
      entityType: e.entityType,
      state: isGroup ? null : 'online',
      errors: isGroup || e.entityType === 'pool' || e.entity.startsWith(`${e.pool}/@spares/`) ? null : { read: 0, write: 0, checksum: 0 },
      ...NODE_OVERRIDES[e.entity],
    });
  }
  return [...byHost].map(([host, pools]) => ({
    host,
    readable: true,
    connected: true,
    lastSeenAt: nowMs,
    pools: [...pools.values()],
  }));
}
