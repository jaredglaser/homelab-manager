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

  it('produces valid ZFSStatsRow shapes, with no I/O for device groups and spares', () => {
    const rows = generateZFSSnapshot(time);
    for (const row of rows) {
      expect(row.time).toBe(time.getTime());
      expect(typeof row.host).toBe('string');
      expect(typeof row.pool).toBe('string');
      expect(typeof row.entity).toBe('string');
      expect(['pool', 'group', 'vdev', 'disk']).toContain(row.entity_type);
      expect(typeof row.indent).toBe('number');
      const silent = row.entity_type === 'group' || row.entity === 'rust/@spares/sdk';
      for (const value of [row.read_ops_per_sec, row.write_ops_per_sec, row.read_bytes_per_sec, row.write_bytes_per_sec]) {
        if (silent) expect(value).toBeNull();
        else expect(typeof value).toBe('number');
      }
    }
  });

  it('includes correct entity types and indentation', () => {
    const rows = generateZFSSnapshot(time);
    for (const type of ['pool', 'group', 'vdev', 'disk'] as const) {
      expect(rows.filter((r) => r.entity_type === type)).toHaveLength(ZFS_ENTITIES.filter((e) => e.entityType === type).length);
    }
    for (const pool of rows.filter((r) => r.entity_type === 'pool')) expect(pool.indent).toBe(0);
    for (const group of rows.filter((r) => r.entity_type === 'group')) expect(group.indent).toBe(2);
  });

  it('includes a pool with every kind of device group', () => {
    const groups = generateZFSSnapshot(time).filter((r) => r.entity_type === 'group').map((r) => r.entity);
    expect(groups).toEqual(['rust/@special', 'rust/@dedup', 'rust/@logs', 'rust/@cache', 'rust/@spares']);
  });

  it('reports no capacity for disks inside a vdev, as zpool does', () => {
    const rows = generateZFSSnapshot(time);
    const vdevs = new Set(rows.filter((r) => r.entity_type === 'vdev').map((r) => r.entity));
    const nested = rows.filter((r) => r.entity_type === 'disk' && vdevs.has(r.entity.slice(0, r.entity.lastIndexOf('/'))));
    expect(nested.length).toBeGreaterThan(0);
    for (const disk of nested) {
      expect(disk.capacity_alloc).toBeNull();
      expect(disk.capacity_free).toBeNull();
    }
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
      expect(rows[i].time).toBeGreaterThanOrEqual(rows[i - 1].time);
    }
  });
});
