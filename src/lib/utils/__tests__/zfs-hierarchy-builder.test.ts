import { describe, it, expect, spyOn } from 'bun:test';
import { buildZFSHostHierarchy, latestSampleRows, zfsEntitySegment, zfsGroupSegment } from '../zfs-hierarchy-builder';
import type { ZFSEntityType, ZFSStatsRow, ZFSTreeNode } from '@/types/zfs';

function row(
  host: string,
  entity: string,
  entityType: ZFSEntityType,
  overrides: Partial<ZFSStatsRow> = {},
): ZFSStatsRow {
  return {
    time: 1000,
    host,
    pool: entity.split('/')[0],
    entity,
    entity_type: entityType,
    indent: 0,
    capacity_alloc: null,
    capacity_free: null,
    read_ops_per_sec: 1,
    write_ops_per_sec: 2,
    read_bytes_per_sec: 3,
    write_bytes_per_sec: 4,
    utilization_percent: null,
    ...overrides,
  };
}

function shape(nodes: ZFSTreeNode[]): unknown[] {
  return nodes.map((node) => (node.children.length ? { [`${node.type}:${node.name}`]: shape(node.children) } : `${node.type}:${node.name}`));
}

describe('zfs entity segments', () => {
  it('escapes the characters that would split or mark a segment', () => {
    expect(zfsEntitySegment('/var/lib/disk@1 100%.img')).toBe('%2Fvar%2Flib%2Fdisk%401 100%25.img');
    expect(zfsEntitySegment('backup:2025.a')).toBe('backup:2025.a');
    expect(zfsGroupSegment('logs')).toBe('@logs');
  });
});

describe('buildZFSHostHierarchy', () => {
  it('places special, dedup, log, cache and spare groups inside their pool and keeps them out of its capacity', () => {
    const hierarchy = buildZFSHostHierarchy([
      row('pve1', 'rpool', 'pool', { capacity_alloc: 400, capacity_free: 1600 }),
      row('pve1', 'rpool/mirror-0', 'vdev', { capacity_alloc: 390, capacity_free: 1560 }),
      row('pve1', 'rpool/mirror-0/sda', 'disk'),
      row('pve1', 'rpool/mirror-0/sdb', 'disk'),
      row('pve1', 'rpool/@spares', 'group'),
      row('pve1', 'rpool/@spares/sdz', 'disk', { read_ops_per_sec: null, write_ops_per_sec: null, read_bytes_per_sec: null, write_bytes_per_sec: null }),
      row('pve1', 'rpool/@cache', 'group'),
      row('pve1', 'rpool/@cache/nvme1n1', 'disk', { capacity_alloc: 200_000, capacity_free: 300_000 }),
      row('pve1', 'rpool/@logs', 'group'),
      row('pve1', 'rpool/@logs/mirror-3', 'vdev', { capacity_alloc: 0, capacity_free: 16 }),
      row('pve1', 'rpool/@logs/mirror-3/nvme2n1', 'disk'),
      row('pve1', 'rpool/@logs/mirror-3/nvme3n1', 'disk'),
      row('pve1', 'rpool/@dedup', 'group'),
      row('pve1', 'rpool/@dedup/nvme4n1', 'disk', { capacity_alloc: 1, capacity_free: 30 }),
      row('pve1', 'rpool/@special', 'group'),
      row('pve1', 'rpool/@special/mirror-2', 'vdev', { capacity_alloc: 8, capacity_free: 38 }),
      row('pve1', 'rpool/@special/mirror-2/nvme5n1', 'disk'),
      row('pve1', 'rpool/@special/mirror-2/nvme6n1', 'disk'),
    ]);

    const host = hierarchy.get('pve1')!;
    expect([...host.pools.keys()]).toEqual(['rpool']);
    expect(shape(host.pools.get('rpool')!.children)).toEqual([
      { 'vdev:mirror-0': ['disk:sda', 'disk:sdb'] },
      { 'group:special': [{ 'vdev:mirror-2': ['disk:nvme5n1', 'disk:nvme6n1'] }] },
      { 'group:dedup': ['disk:nvme4n1'] },
      { 'group:logs': [{ 'vdev:mirror-3': ['disk:nvme2n1', 'disk:nvme3n1'] }] },
      { 'group:cache': ['disk:nvme1n1'] },
      { 'group:spares': ['disk:sdz'] },
    ]);
    expect(host.aggregated).toMatchObject({ capacityAlloc: 400, capacityFree: 1600, poolCount: 1 });
  });

  it('keeps a disk named like a group apart from the group', () => {
    const hierarchy = buildZFSHostHierarchy([
      row('pve1', 'tank', 'pool'),
      row('pve1', 'tank/logs', 'disk'),
      row('pve1', 'tank/@logs', 'group'),
      row('pve1', 'tank/@logs/nvme0n1', 'disk'),
    ]);

    expect(shape(hierarchy.get('pve1')!.pools.get('tank')!.children)).toEqual([
      'disk:logs',
      { 'group:logs': ['disk:nvme0n1'] },
    ]);
  });

  it('shows each disk of a pool without mirror or raidz as a top-level device', () => {
    const hierarchy = buildZFSHostHierarchy([
      row('pve1', 'backup', 'pool'),
      row('pve1', 'backup/sdc', 'disk', { capacity_alloc: 10, capacity_free: 20 }),
      row('pve1', 'backup/sdb', 'disk', { capacity_alloc: 10, capacity_free: 20 }),
    ]);

    expect(shape(hierarchy.get('pve1')!.pools.get('backup')!.children)).toEqual(['disk:sdb', 'disk:sdc']);
  });

  it('decodes names that carry slashes, such as file vdevs', () => {
    const hierarchy = buildZFSHostHierarchy([
      row('pve1', 'tank', 'pool'),
      row('pve1', `tank/${zfsEntitySegment('/var/lib/zfs/a.img')}`, 'disk'),
    ]);

    expect(shape(hierarchy.get('pve1')!.pools.get('tank')!.children)).toEqual(['disk:/var/lib/zfs/a.img']);
  });

  it('keeps two pools on one host and two hosts with a pool named tank apart, with host-prefixed ids', () => {
    const hierarchy = buildZFSHostHierarchy([
      row('nas01', 'tank', 'pool', { capacity_alloc: 1, capacity_free: 1 }),
      row('nas01', 'tank/mirror-0', 'vdev'),
      row('nas01', 'tank/mirror-0/sda', 'disk'),
      row('nas01', 'backup', 'pool', { capacity_alloc: 2, capacity_free: 2 }),
      row('nas01', 'backup/sdb', 'disk'),
      row('nas02', 'tank', 'pool', { capacity_alloc: 5, capacity_free: 5 }),
      row('nas02', 'tank/raidz1-0', 'vdev'),
      row('nas02', 'tank/raidz1-0/sdx', 'disk'),
    ]);

    expect([...hierarchy.keys()]).toEqual(['nas01', 'nas02']);
    const nas01 = hierarchy.get('nas01')!;
    const nas02 = hierarchy.get('nas02')!;
    expect([...nas01.pools.keys()]).toEqual(['backup', 'tank']);
    expect(nas01.pools.get('tank')!.id).toBe('nas01/tank');
    expect(nas02.pools.get('tank')!.id).toBe('nas02/tank');
    expect(nas01.pools.get('tank')!.children[0].id).toBe('nas01/tank/mirror-0');
    expect(shape(nas02.pools.get('tank')!.children)).toEqual([{ 'vdev:raidz1-0': ['disk:sdx'] }]);
    expect(nas01.aggregated.capacityAlloc).toBe(3);
    expect(nas02.aggregated.capacityAlloc).toBe(5);
  });

  it('drops a pool exported since the previous sample on the next sample', () => {
    const rows = [
      row('pve1', 'tank', 'pool', { time: 1000 }),
      row('pve1', 'old', 'pool', { time: 1000 }),
      row('pve1', 'tank', 'pool', { time: 2000 }),
      row('pve1', 'new', 'pool', { time: 2000 }),
      row('pve2', 'other', 'pool', { time: 500 }),
    ];

    const hierarchy = buildZFSHostHierarchy(rows);

    expect([...hierarchy.get('pve1')!.pools.keys()]).toEqual(['new', 'tank']);
    expect([...hierarchy.get('pve2')!.pools.keys()]).toEqual(['other']);
    expect(latestSampleRows(rows).map((r) => `${r.host}/${r.entity}@${r.time}`)).toEqual([
      'pve1/tank@2000',
      'pve1/new@2000',
      'pve2/other@500',
    ]);
  });

  it('marks a host whose agent is too old, with no pools', () => {
    const hierarchy = buildZFSHostHierarchy([
      row('old-agent', 'tank', 'pool', { time: 500 }),
      row('old-agent', '', 'agent_outdated', { pool: '', time: 1000 }),
      row('nas01', 'tank', 'pool'),
    ]);

    expect(hierarchy.get('old-agent')).toMatchObject({ agentOutdated: true, aggregated: { poolCount: 0 } });
    expect(hierarchy.get('old-agent')!.pools.size).toBe(0);
    expect(hierarchy.get('nas01')!.agentOutdated).toBe(false);
  });

  it('shows the pools again once the updated agent sends a sample newer than the marker', () => {
    const hierarchy = buildZFSHostHierarchy([
      row('pve1', '', 'agent_outdated', { pool: '', time: 1000 }),
      row('pve1', 'tank', 'pool', { time: 2000 }),
    ]);

    expect(hierarchy.get('pve1')).toMatchObject({ agentOutdated: false, aggregated: { poolCount: 1 } });
  });

  it('skips rows whose parent is missing or whose group it does not know, with a warning', () => {
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const hierarchy = buildZFSHostHierarchy([
      row('pve1', 'tank', 'pool'),
      row('pve1', 'tank/mirror-9/sda', 'disk'),
      row('pve1', 'tank/@mystery', 'group'),
      row('pve1', 'orphan', 'disk'),
    ]);

    expect(hierarchy.get('pve1')!.pools.get('tank')!.children).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });

  it('returns an empty map for no rows', () => {
    expect(buildZFSHostHierarchy([]).size).toBe(0);
  });
});
