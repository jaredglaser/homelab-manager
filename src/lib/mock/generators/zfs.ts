import type { ZFSStatsRow } from '@/types/zfs';
import { generateActivityMetrics } from '@/lib/mock/patterns';
import { ZFS_ENTITIES } from '@/lib/mock/entities';

/**
 * Generate a single ZFS stats snapshot for a given timestamp.
 * Returns one row per entity (pool, vdev, disk), matching the `zfs_stats` hypertable schema.
 *
 * All entities in the same pool share an activity state (idle/low/med/high) so
 * that when the pool is streaming a file, every disk in that pool is active.
 * Per-entity noise is applied independently so individual disks vary naturally.
 */
export function generateZFSSnapshot(time: Date): ZFSStatsRow[] {
  const timeMs = time.getTime();
  const timeStr = time.toISOString();

  return ZFS_ENTITIES.map((e) => {
    // Pool-level key drives the shared activity state - all disks/vdevs in a pool
    // transition together. Per-entity key provides independent noise variation.
    const activityKey = `${e.host}/${e.pool}`;
    const noiseKey    = `${e.host}/${e.pool}/${e.entity}`;
    const m = generateActivityMetrics(timeMs, activityKey, noiseKey, e.activity);

    return {
      time: timeStr,
      host: e.host,
      pool: e.pool,
      entity: e.entity,
      entity_type: e.entityType,
      indent: e.indent,
      capacity_alloc: e.capacityAlloc,
      capacity_free: e.capacityFree,
      read_ops_per_sec: m.readOps,
      write_ops_per_sec: m.writeOps,
      read_bytes_per_sec: m.readBytes,
      write_bytes_per_sec: m.writeBytes,
      utilization_percent: e.capacityAlloc + e.capacityFree > 0
        ? Math.round(e.capacityAlloc / (e.capacityAlloc + e.capacityFree) * 10_000) / 100
        : 0,
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
