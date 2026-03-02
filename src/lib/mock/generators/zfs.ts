import type { ZFSStatsRow } from '@/types/zfs';
import { generateMetric } from '../patterns';
import { ZFS_ENTITIES } from '../entities';

/**
 * Generate a single ZFS stats snapshot for a given timestamp.
 * Returns one row per entity (pool, vdev, disk), matching the `zfs_stats` hypertable schema.
 */
export function generateZFSSnapshot(time: Date): ZFSStatsRow[] {
  const timeMs = time.getTime();
  const timeStr = time.toISOString();

  return ZFS_ENTITIES.map((e) => {
    const entityKey = `${e.host}/${e.pool}/${e.entity}`;

    return {
      time: timeStr,
      host: e.host,
      pool: e.pool,
      entity: e.entity,
      entity_type: e.entityType,
      indent: e.indent,
      capacity_alloc: e.capacityAlloc || null,
      capacity_free: e.capacityFree || null,
      read_ops_per_sec: Math.round(generateMetric(timeMs, entityKey, 'readOps', e.readOps)),
      write_ops_per_sec: Math.round(generateMetric(timeMs, entityKey, 'writeOps', e.writeOps)),
      read_bytes_per_sec: Math.round(generateMetric(timeMs, entityKey, 'readBytes', e.readBytes)),
      write_bytes_per_sec: Math.round(generateMetric(timeMs, entityKey, 'writeBytes', e.writeBytes)),
      utilization_percent: Math.round(generateMetric(timeMs, entityKey, 'util', e.utilization) * 100) / 100,
    };
  });
}

/**
 * Generate `seconds` worth of historical ZFS data at 1-second intervals.
 * Rows are ordered oldest-first (ascending time).
 */
export function generateZFSHistory(seconds: number): ZFSStatsRow[] {
  const now = Date.now();
  const rows: ZFSStatsRow[] = [];

  for (let s = seconds; s >= 0; s--) {
    const time = new Date(now - s * 1000);
    rows.push(...generateZFSSnapshot(time));
  }

  return rows;
}
