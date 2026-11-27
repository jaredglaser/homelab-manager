import { describe, it, expect } from 'bun:test';
import { AGENT_TOO_OLD_FOR_ZFS, ZFS_GROUP_LABELS, buildHostRow, buildPoolRow } from '../zfs-row-builders';
import { buildZFSHostHierarchy } from '@/lib/utils/zfs-hierarchy-builder';
import type { ZFSEntityType, ZFSStatsRow } from '@/types/zfs';
import type { ZFSTableRow } from '@/components/zfs/ZFSPoolsTable';

function row(entity: string, entityType: ZFSEntityType, overrides: Partial<ZFSStatsRow> = {}): ZFSStatsRow {
  return {
    time: 1000,
    host: 'pve1',
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

function pool(rows: ZFSStatsRow[], name: string) {
  return buildZFSHostHierarchy(rows).get('pve1')!.pools.get(name)!;
}

function names(rows: ZFSTableRow[] | undefined): unknown[] {
  return (rows ?? []).map((r) => (r.children ? { [r.name]: names(r.children) } : r.name));
}

/** The metric columns render an empty cell, not 0, for a value left undefined. */
function expectBlank(r: ZFSTableRow): void {
  for (const key of ['readOpsPerSec', 'writeOpsPerSec', 'readBytesPerSec', 'writeBytesPerSec', 'capacityAlloc', 'capacityFree'] as const) {
    expect(r[key]).toBeUndefined();
  }
}

describe('zfs row copy', () => {
  it('labels each device group word for word', () => {
    expect(ZFS_GROUP_LABELS).toEqual({
      special: 'Special devices',
      dedup: 'Dedup devices',
      logs: 'Log devices',
      cache: 'Cache devices',
      spares: 'Spares',
    });
  });

  it('tells the operator what to do about an agent too old for ZFS stats', () => {
    expect(AGENT_TOO_OLD_FOR_ZFS).toBe("This host's agent is too old to report ZFS stats. Update the agent from the Hosts page.");
  });
});

describe('buildPoolRow', () => {
  it('lists the data vdevs, then each device group under its label with its devices', () => {
    const rows = [
      row('rust', 'pool', { capacity_alloc: 10, capacity_free: 30 }),
      row('rust/raidz2-0', 'vdev', { capacity_alloc: 10, capacity_free: 30 }),
      row('rust/raidz2-0/sda', 'disk'),
      row('rust/raidz2-0/sdb', 'disk'),
      row('rust/raidz2-1', 'vdev', { capacity_alloc: 10, capacity_free: 30 }),
      row('rust/raidz2-1/sdc', 'disk'),
      row('rust/@cache', 'group', { read_ops_per_sec: null, write_ops_per_sec: null, read_bytes_per_sec: null, write_bytes_per_sec: null }),
      row('rust/@cache/nvme1n1', 'disk', { capacity_alloc: 400, capacity_free: 100 }),
      row('rust/@special', 'group'),
      row('rust/@special/mirror-2', 'vdev', { capacity_alloc: 1, capacity_free: 3 }),
      row('rust/@special/mirror-2/nvme2n1', 'disk'),
      row('rust/@special/mirror-2/nvme3n1', 'disk'),
    ];

    const built = buildPoolRow(pool(rows, 'rust'), 1);

    expect(names(built.children)).toEqual([
      { 'raidz2-0': ['sda', 'sdb'] },
      { 'raidz2-1': ['sdc'] },
      { 'Special devices': [{ 'mirror-2': ['nvme2n1', 'nvme3n1'] }] },
      { 'Cache devices': ['nvme1n1'] },
    ]);
    expect(built).toMatchObject({ capacityAlloc: 10, capacityFree: 30, canExpand: true });
    const cache = built.children!.find((r) => r.name === 'Cache devices')!;
    expect(cache).toMatchObject({ type: 'group', id: 'group:pve1/rust/@cache' });
    expectBlank(cache);
  });

  it('shows the disks of a single vdev directly, with groups after them', () => {
    const built = buildPoolRow(pool([
      row('tank', 'pool'),
      row('tank/mirror-0', 'vdev'),
      row('tank/mirror-0/sda', 'disk'),
      row('tank/mirror-0/sdb', 'disk'),
      row('tank/@logs', 'group'),
      row('tank/@logs/nvme0n1', 'disk'),
    ], 'tank'), 1);

    expect(built.badge).toEqual({ label: 'mirror-0' });
    expect(names(built.children)).toEqual(['sda', 'sdb', { 'Log devices': ['nvme0n1'] }]);
  });

  it('keeps a single-disk pool collapsed unless it has device groups', () => {
    const plain = buildPoolRow(pool([row('system', 'pool'), row('system/sda', 'disk')], 'system'), 1);
    expect(plain).toMatchObject({ badge: { label: 'single disk', tooltip: 'sda' }, canExpand: false, children: undefined });

    const withSpare = buildPoolRow(pool([
      row('system', 'pool'),
      row('system/sda', 'disk'),
      row('system/@spares', 'group'),
      row('system/@spares/sdz', 'disk', { read_ops_per_sec: null, write_ops_per_sec: null, read_bytes_per_sec: null, write_bytes_per_sec: null }),
    ], 'system'), 1);
    expect(withSpare.canExpand).toBe(true);
    expect(names(withSpare.children)).toEqual([{ Spares: ['sdz'] }]);
    expect(withSpare.children![0].children![0].type).toBe('disk');
    expectBlank(withSpare.children![0].children![0]);
  });

  it('shows each disk of a pool without mirror or raidz as a top-level row', () => {
    const built = buildPoolRow(pool([
      row('backup', 'pool'),
      row('backup/sdb', 'disk', { capacity_alloc: 5, capacity_free: 5 }),
      row('backup/sdc', 'disk', { capacity_alloc: 5, capacity_free: 5 }),
    ], 'backup'), 1);

    expect(built.badge).toBeUndefined();
    expect(names(built.children)).toEqual(['sdb', 'sdc']);
    expect(built.children![0]).toMatchObject({ type: 'disk', id: 'disk:pve1/backup/sdb', capacityAlloc: 5 });
  });
});

describe('buildHostRow', () => {
  it('carries the notice for a host whose agent is too old', () => {
    const host = buildZFSHostHierarchy([row('', 'agent_outdated', { pool: '' })]).get('pve1')!;
    expect(buildHostRow(host, 2)).toMatchObject({ notice: AGENT_TOO_OLD_FOR_ZFS, canExpand: false, children: [] });
  });

  it('carries no notice for a host that reports pools', () => {
    const host = buildZFSHostHierarchy([row('tank', 'pool')]).get('pve1')!;
    expect(buildHostRow(host, 1).notice).toBeUndefined();
  });
});
