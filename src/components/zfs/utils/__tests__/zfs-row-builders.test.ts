import { describe, it, expect } from 'bun:test';
import {
  AGENT_TOO_OLD_FOR_ZFS,
  ZFS_GROUP_LABELS,
  ZFS_STATE_LABELS,
  buildHostRow,
  buildPoolRow,
  deviceErrorsTooltip,
  healthLookup,
  hostHealthNotice,
  offlineHealthRows,
  poolBanner,
  scanLine,
} from '../zfs-row-builders';
import type { ZfsScan } from '@homelab-manager/agent/types/protocol';
import type { ZFSHostHealth } from '@/types/zfs';
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

describe('pool health copy', () => {
  it('names each state on its chip word for word, and leaves an unknown state without one', () => {
    expect(ZFS_STATE_LABELS).toEqual({
      online: 'Online',
      degraded: 'Degraded',
      faulted: 'Faulted',
      offline: 'Offline',
      unavailable: 'Unavailable',
      removed: 'Removed',
      suspended: 'Suspended',
      unknown: null,
    });
  });

  it('writes the degraded banner word for word', () => {
    expect(poolBanner('tank', 'pve1', 'degraded')).toEqual({
      message: 'tank on pve1 is degraded. A device has failed or is missing, so the pool has lost redundancy. Your data is still readable.',
      tone: 'warning',
    });
  });

  it.each(['faulted', 'suspended', 'unavailable'] as const)('writes the faulted banner word for word for a %s pool', (state) => {
    expect(poolBanner('tank', 'pve1', state)).toEqual({ message: 'tank on pve1 is faulted. Data on this pool may be unavailable.', tone: 'error' });
  });

  it.each(['online', 'offline', 'removed', 'unknown'] as const)('shows no banner for a %s pool', (state) => {
    expect(poolBanner('tank', 'pve1', state)).toBeNull();
  });

  it('writes the error counts word for word, and nothing once they are all zero', () => {
    expect(deviceErrorsTooltip({ read: 3, write: 0, checksum: 12 })).toBe('3 read, 0 write and 12 checksum errors since the counters were last cleared.');
    expect(deviceErrorsTooltip({ read: 0, write: 0, checksum: 0 })).toBeUndefined();
    expect(deviceErrorsTooltip(null)).toBeUndefined();
  });

  const NOV_23 = new Date(2026, 10, 23, 4).getTime();
  const scan = (overrides: Partial<ZfsScan>): ZfsScan => ({ kind: 'scrub', state: 'running', percentDone: 42, endedAt: null, repairedBytes: 0, errors: 0, ...overrides });

  it.each<[string, ZfsScan | null, string | null]>([
    ['a finished scrub', scan({ state: 'finished', percentDone: null, endedAt: NOV_23 }), 'Last scrub Nov 23, repaired 0 B, 0 errors'],
    ['a running scrub', scan({}), 'Scrub running, 42% done'],
    ['a running resilver', scan({ kind: 'resilver' }), 'Resilvering, 42% done'],
    ['a pool never scrubbed', null, 'Never scrubbed'],
    ['a finished resilver', scan({ kind: 'resilver', state: 'finished', percentDone: null, endedAt: NOV_23, repairedBytes: 1.5 * 1024 ** 3 }), 'Last resilver Nov 23, repaired 1.5 GiB, 0 errors'],
    ['a paused scrub', scan({ state: 'paused' }), 'Scrub paused, 42% done'],
    ['a canceled scrub', scan({ state: 'canceled', percentDone: null, endedAt: NOV_23 }), 'Scrub canceled Nov 23'],
    ['a canceled resilver', scan({ kind: 'resilver', state: 'canceled', percentDone: null, endedAt: NOV_23 }), 'Resilver canceled Nov 23'],
    ['one error and repaired bytes', scan({ state: 'finished', percentDone: null, endedAt: NOV_23, repairedBytes: 2 * 1024 ** 4, errors: 1 }), 'Last scrub Nov 23, repaired 2 TiB, 1 error'],
    ['a stopped scan with no end time', scan({ state: 'finished', percentDone: null }), null],
  ])('writes the scrub line for %s word for word', (_label, value, expected) => {
    expect(scanLine(value)).toBe(expected);
  });

  const host = (overrides: Partial<ZFSHostHealth>): ZFSHostHealth => ({
    host: 'pve1', readable: true, connected: true, lastSeenAt: new Date(2026, 10, 27, 10, 42).getTime(), pools: [], ...overrides,
  });

  it('writes the unreadable notice word for word', () => {
    expect(hostHealthNotice(host({ readable: false }), true)).toBe("Can't read pool health from pve1. I/O stats are still live.");
  });

  it('writes the offline notice word for word in the 12 and the 24-hour form', () => {
    expect(hostHealthNotice(host({ connected: false }), true)).toBe('pve1 is offline. Showing pool health from 10:42 AM.');
    expect(hostHealthNotice(host({ connected: false }), false)).toBe('pve1 is offline. Showing pool health from 10:42.');
    expect(hostHealthNotice(host({ connected: false, readable: false }), false)).toBe('pve1 is offline. Showing pool health from 10:42.');
  });

  it('writes no notice for a host that reports health, or one with none recorded', () => {
    expect(hostHealthNotice(host({}), true)).toBeUndefined();
    expect(hostHealthNotice(undefined, true)).toBeUndefined();
  });
});

describe('pool health on the rows', () => {
  const health: ZFSHostHealth = {
    host: 'pve1',
    readable: true,
    connected: false,
    lastSeenAt: 5000,
    pools: [{
      pool: 'tank',
      scan: null,
      nodes: [
        { entity: 'tank', entityType: 'pool', state: 'degraded', errors: null },
        { entity: 'tank/raidz1-0', entityType: 'vdev', state: 'degraded', errors: { read: 1, write: 0, checksum: 0 } },
        { entity: 'tank/raidz1-0/sda', entityType: 'disk', state: 'faulted', errors: { read: 3, write: 0, checksum: 12 } },
        { entity: 'tank/raidz1-0/sdb', entityType: 'disk', state: 'unknown', errors: null },
        { entity: 'tank/mirror-1', entityType: 'vdev', state: 'online', errors: null },
        { entity: 'tank/mirror-1/sdc', entityType: 'disk', state: 'online', errors: null },
        { entity: 'tank/@spares', entityType: 'group', state: null, errors: null },
        { entity: 'tank/@spares/sdz', entityType: 'disk', state: 'online', errors: null },
      ],
    }],
  };

  it('puts the state chip on pools and devices, the scrub line on the pool, and the error counts on disks only', () => {
    const rows = offlineHealthRows([health], new Set());
    const tank = pool(rows, 'tank');
    const built = buildPoolRow(tank, 1, healthLookup([health]));
    const byName = new Map(built.children!.map((child) => [child.name, child]));
    const raidz = byName.get('raidz1-0')!;
    const spares = byName.get('Spares')!;
    expect(byName.get('mirror-1')!.health).toEqual({ label: 'Online', tone: 'ok', tooltip: undefined });

    expect(built.health).toEqual({ label: 'Degraded', tone: 'warning', tooltip: undefined });
    expect(built.detail).toBe('Never scrubbed');
    expect(raidz.health).toEqual({ label: 'Degraded', tone: 'warning', tooltip: undefined });
    expect(raidz.children![0].health).toEqual({ label: 'Faulted', tone: 'error', tooltip: '3 read, 0 write and 12 checksum errors since the counters were last cleared.' });
    expect(raidz.children![1].health).toBeUndefined();
    expect(spares.health).toBeUndefined();
    expect(spares.children![0].health).toEqual({ label: 'Online', tone: 'ok', tooltip: undefined });
  });

  it('keys health by host, so the same pool name on two hosts keeps its own chips', () => {
    const other: ZFSHostHealth = { ...health, host: 'pve2', pools: [{ ...health.pools[0], nodes: [{ entity: 'tank', entityType: 'pool', state: 'online', errors: null }] }] };
    const rows = [row('tank', 'pool'), { ...row('tank', 'pool'), host: 'pve2' }];
    const hierarchy = buildZFSHostHierarchy(rows);
    const lookup = healthLookup([health, other]);
    expect(buildPoolRow(hierarchy.get('pve1')!.pools.get('tank')!, 1, lookup).health?.label).toBe('Degraded');
    expect(buildPoolRow(hierarchy.get('pve2')!.pools.get('tank')!, 1, lookup).health?.label).toBe('Online');
  });

  it('shows no chip and no scrub line where no health is recorded', () => {
    const built = buildPoolRow(pool([row('tank', 'pool'), row('tank/sda', 'disk')], 'tank'), 1);
    expect(built.health).toBeUndefined();
    expect(built.detail).toBeUndefined();
  });

  it('stands in rows for an offline host whose stats are gone, with no capacity or I/O, and none for a host still on the page', () => {
    const rows = offlineHealthRows([health], new Set());
    expect(rows.map((r) => [r.entity, r.entity_type, r.indent])).toEqual([
      ['tank', 'pool', 0],
      ['tank/raidz1-0', 'vdev', 2],
      ['tank/raidz1-0/sda', 'disk', 4],
      ['tank/raidz1-0/sdb', 'disk', 4],
      ['tank/mirror-1', 'vdev', 2],
      ['tank/mirror-1/sdc', 'disk', 4],
      ['tank/@spares', 'group', 2],
      ['tank/@spares/sdz', 'disk', 4],
    ]);
    for (const r of rows) {
      expect(r).toMatchObject({ host: 'pve1', time: 5000, capacity_alloc: null, read_ops_per_sec: null, write_bytes_per_sec: null });
    }
    expect(offlineHealthRows([health], new Set(['pve1']))).toEqual([]);
    expect(offlineHealthRows([{ ...health, connected: true }], new Set())).toEqual([]);
  });

  it('passes the host notice to the host row', () => {
    const host = buildZFSHostHierarchy(offlineHealthRows([health], new Set())).get('pve1')!;
    expect(buildHostRow(host, 1, healthLookup([health]), 'notice').healthNotice).toBe('notice');
  });
});
