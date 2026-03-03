import { describe, it, expect } from 'bun:test';
import { generateProxmoxSnapshot, generateProxmoxHistory } from '../proxmox';
import { PROXMOX_ENTITIES } from '../../entities';

describe('generateProxmoxSnapshot', () => {
  const time = new Date('2025-06-15T12:00:00Z');

  it('returns one row per entity', () => {
    const rows = generateProxmoxSnapshot(time);
    expect(rows).toHaveLength(PROXMOX_ENTITIES.length);
  });

  it('is deterministic', () => {
    const rows1 = generateProxmoxSnapshot(time);
    const rows2 = generateProxmoxSnapshot(time);
    expect(rows1).toEqual(rows2);
  });

  it('produces valid ProxmoxStatsRow shapes', () => {
    const rows = generateProxmoxSnapshot(time);
    for (const row of rows) {
      expect(row.time).toBe(time.toISOString());
      expect(typeof row.host).toBe('string');
      expect(['cluster', 'node', 'qemu', 'lxc', 'storage']).toContain(row.entity_type);
      expect(typeof row.entity_id).toBe('string');
      expect(typeof row.entity_name).toBe('string');
    }
  });

  it('includes all entity types', () => {
    const rows = generateProxmoxSnapshot(time);
    const types = new Set(rows.map((r) => r.entity_type));
    expect(types.has('cluster')).toBe(true);
    expect(types.has('node')).toBe(true);
    expect(types.has('qemu')).toBe(true);
    expect(types.has('lxc')).toBe(true);
    expect(types.has('storage')).toBe(true);
  });

  it('nodes have non-null cpu and mem', () => {
    const rows = generateProxmoxSnapshot(time);
    const nodes = rows.filter((r) => r.entity_type === 'node');
    expect(nodes.length).toBe(2);
    for (const node of nodes) {
      expect(node.cpu).not.toBeNull();
      expect(node.max_cpu).not.toBeNull();
      expect(node.mem).not.toBeNull();
      expect(node.max_mem).not.toBeNull();
    }
  });

  it('cluster row has cluster_version', () => {
    const rows = generateProxmoxSnapshot(time);
    const cluster = rows.find((r) => r.entity_type === 'cluster');
    expect(cluster).toBeDefined();
    expect(cluster!.cluster_version).toBe(8);
  });

  it('storages have storage-specific fields', () => {
    const rows = generateProxmoxSnapshot(time);
    const storages = rows.filter((r) => r.entity_type === 'storage');
    expect(storages.length).toBe(3);
    for (const storage of storages) {
      expect(storage.storage_type).not.toBeNull();
      expect(storage.storage_content).not.toBeNull();
      expect(storage.max_disk).not.toBeNull();
    }
  });

  it('uptime grows over time', () => {
    const time1 = new Date('2025-06-15T12:00:00Z');
    const time2 = new Date('2025-06-15T12:01:00Z'); // 60s later
    const rows1 = generateProxmoxSnapshot(time1);
    const rows2 = generateProxmoxSnapshot(time2);
    const node1 = rows1.find((r) => r.entity_id === 'pve1');
    const node2 = rows2.find((r) => r.entity_id === 'pve1');
    expect(node2!.uptime! - node1!.uptime!).toBe(60);
  });
});

describe('generateProxmoxHistory', () => {
  it('returns correct number of rows', () => {
    const seconds = 3;
    const rows = generateProxmoxHistory(seconds);
    expect(rows).toHaveLength((seconds + 1) * PROXMOX_ENTITIES.length);
  });

  it('rows are ordered oldest-first', () => {
    const rows = generateProxmoxHistory(5);
    for (let i = 1; i < rows.length; i++) {
      const prevTime = new Date(rows[i - 1].time as string).getTime();
      const currTime = new Date(rows[i].time as string).getTime();
      expect(currTime).toBeGreaterThanOrEqual(prevTime);
    }
  });
});
