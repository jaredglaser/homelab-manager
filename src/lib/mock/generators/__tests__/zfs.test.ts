import { describe, it, expect } from 'bun:test';
import { generateZFSSnapshot, generateZFSHistory } from '../zfs';
import { ZFS_ENTITIES } from '../../entities';

describe('generateZFSSnapshot', () => {
  const time = new Date('2025-06-15T12:00:00Z');

  it('returns one row per entity', () => {
    const rows = generateZFSSnapshot(time);
    expect(rows).toHaveLength(ZFS_ENTITIES.length);
  });

  it('is deterministic', () => {
    const rows1 = generateZFSSnapshot(time);
    const rows2 = generateZFSSnapshot(time);
    expect(rows1).toEqual(rows2);
  });

  it('produces valid ZFSStatsRow shapes', () => {
    const rows = generateZFSSnapshot(time);
    for (const row of rows) {
      expect(row.time).toBe(time.toISOString());
      expect(typeof row.host).toBe('string');
      expect(typeof row.pool).toBe('string');
      expect(typeof row.entity).toBe('string');
      expect(['pool', 'vdev', 'disk']).toContain(row.entity_type);
      expect(typeof row.indent).toBe('number');
      expect(typeof row.read_ops_per_sec).toBe('number');
      expect(typeof row.write_ops_per_sec).toBe('number');
      expect(typeof row.read_bytes_per_sec).toBe('number');
      expect(typeof row.write_bytes_per_sec).toBe('number');
      expect(typeof row.utilization_percent).toBe('number');
    }
  });

  it('includes correct entity types and indentation', () => {
    const rows = generateZFSSnapshot(time);
    const pools = rows.filter((r) => r.entity_type === 'pool');
    const vdevs = rows.filter((r) => r.entity_type === 'vdev');
    const disks = rows.filter((r) => r.entity_type === 'disk');

    expect(pools.length).toBe(2); // tank and fast
    expect(vdevs.length).toBe(1); // mirror-0
    expect(disks.length).toBe(3); // sda, sdb, nvme0n1

    for (const pool of pools) expect(pool.indent).toBe(0);
    for (const vdev of vdevs) expect(vdev.indent).toBe(2);
  });
});

describe('generateZFSHistory', () => {
  it('returns correct number of rows', () => {
    const seconds = 3;
    const rows = generateZFSHistory(seconds);
    expect(rows).toHaveLength((seconds + 1) * ZFS_ENTITIES.length);
  });

  it('rows are ordered oldest-first', () => {
    const rows = generateZFSHistory(5);
    for (let i = 1; i < rows.length; i++) {
      const prevTime = new Date(rows[i - 1].time as string).getTime();
      const currTime = new Date(rows[i].time as string).getTime();
      expect(currTime).toBeGreaterThanOrEqual(prevTime);
    }
  });
});
