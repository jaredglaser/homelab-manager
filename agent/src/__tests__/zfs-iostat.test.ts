import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IostatSampleReader,
  parseIostatSample,
  parseZpoolStatus,
  withSpares,
  ZPOOL_IOSTAT_ARGS,
  ZPOOL_STATUS_ARGS,
} from '../lib/zfs-iostat';
import {
  zZfsHealthFrame,
  zZfsStatsFrame,
  type ZfsDevice,
  type ZfsDeviceHealth,
  type ZfsGroup,
  type ZfsGroupHealth,
  type ZfsPool,
  type ZfsPoolHealth,
} from '../types/protocol';

const originalConsoleError = console.error;
beforeEach(() => {
  console.error = mock(() => {});
});
afterEach(() => {
  console.error = originalConsoleError;
});

/** Built from the zfs-2.3.3 print routines in cmd/zpool/zpool_main.c (byte-identical in zfs-2.3.4), not captured from a machine. */
function fixture(version: '2.3.3' | '2.3.4'): string[] {
  return readFileSync(join(import.meta.dir, 'fixtures', `zpool-iostat-vpy-${version}.txt`), 'utf-8').split('\n');
}

function samples(lines: string[]): ZfsPool[][] {
  const out: ZfsPool[][] = [];
  const reader = new IostatSampleReader((pools) => out.push(pools));
  for (const line of lines) if (line.trim()) reader.push(line);
  reader.push('              capacity     operations     bandwidth');
  return out;
}

function group(pool: ZfsPool, kind: ZfsGroup['group']): ZfsGroup | undefined {
  return pool.children.find((child): child is ZfsGroup => child.kind === 'group' && child.group === kind);
}

function names(children: ReadonlyArray<ZfsDevice | ZfsGroup>): string[] {
  return children.map((child) => (child.kind === 'group' ? `@${child.group}` : child.name));
}

const HEADER = [
  '              capacity     operations     bandwidth',
  'pool        alloc   free   read  write   read  write',
  '----------  -----  -----  -----  -----  -----  -----',
];
const SEPARATOR = '----------  -----  -----  -----  -----  -----  -----';

describe('zpool iostat arguments', () => {
  test('ask for exact values and skip the since-import report', () => {
    expect(ZPOOL_IOSTAT_ARGS).toEqual(['zpool', 'iostat', '-v', '-p', '-y', '1']);
  });
});

test.each(['2.3.3', '2.3.4'] as const)('reads every line of the OpenZFS %s fixture', (version) => {
  samples(fixture(version));
  expect(console.error).not.toHaveBeenCalled();
});

describe('parseIostatSample on OpenZFS 2.3.3 output (Proxmox VE 9.0)', () => {
  const parsed = samples(fixture('2.3.3'));

  test('reads both samples with both pools and nothing else as a pool', () => {
    expect(parsed).toHaveLength(2);
    for (const pools of parsed) expect(pools.map((pool) => pool.name)).toEqual(['rpool', 'tank']);
  });

  test('places special, dedup, log and cache devices in groups inside their pool', () => {
    const rpool = parsed[0][0];
    expect(names(rpool.children)).toEqual(['mirror-0', '@dedup', '@special', '@logs', '@cache']);
    expect(names(group(rpool, 'special')!.children)).toEqual(['mirror-2']);
    expect(names(group(rpool, 'logs')!.children)).toEqual(['mirror-3']);
    expect(group(rpool, 'dedup')!.children[0]).toMatchObject({ kind: 'disk', name: 'nvme-WD_BLACK_SN770_1TB_22471N800001' });
    expect(group(rpool, 'cache')!.children[0]).toMatchObject({
      kind: 'disk',
      capacity: { allocBytes: '212600881152', freeBytes: '287469027328' },
    });
  });

  test('keeps the pool line capacity, which zpool reports without cache devices', () => {
    expect(parsed[0][0].capacity).toEqual({ allocBytes: '412316860416', freeBytes: '1500153110528' });
  });

  test('marks leaf disks as having no capacity and keeps their rates', () => {
    const mirror = parsed[0][0].children[0];
    expect(mirror.kind).toBe('vdev');
    if (mirror.kind !== 'vdev') return;
    expect(mirror.children[0]).toEqual({
      kind: 'disk',
      name: 'ata-Samsung_SSD_870_EVO_2TB_S6PNNS0W100001A-part3',
      capacity: null,
      io: { readOps: 15, writeOps: 201, readBytes: 602112, writeBytes: 8847360 },
    });
  });

  test('reads multi-terabyte capacity exactly', () => {
    expect(parsed[0][1].capacity).toEqual({ allocBytes: '8796093022208', freeBytes: '15942918602752' });
  });

  test('builds frames the shared schema accepts', () => {
    for (const pools of parsed) expect(zZfsStatsFrame.safeParse({ v: 1, time: 1, pools }).success).toBe(true);
  });
});

describe('parseIostatSample on OpenZFS 2.3.4 output (Proxmox VE 9.1)', () => {
  const parsed = samples(fixture('2.3.4'));

  test('shows each disk of a pool without mirror or raidz as a top-level device', () => {
    const backup = parsed[0][0];
    expect(backup.name).toBe('backup:2025.a');
    expect(backup.children).toEqual([
      expect.objectContaining({ kind: 'disk', name: 'ata-ST4000VN006-3CW104_ZW600001', capacity: { allocBytes: '1649267441664', freeBytes: '3848290697216' } }),
      expect.objectContaining({ kind: 'disk', name: 'ata-ST4000VN006-3CW104_ZW600002' }),
    ]);
  });

  test('keeps thousands of ops a second and GB/s rates exact', () => {
    expect(parsed[0][1].io).toEqual({ readOps: 48213, writeOps: 15377, readBytes: 6318723072, writeBytes: 2014314496 });
    expect(parsed[1][1].io.readOps).toBe(48220);
  });

  test('places log and cache groups after the data vdevs', () => {
    expect(names(parsed[0][1].children)).toEqual(['mirror-0', 'mirror-1', '@logs', '@cache']);
  });
});

describe('parseIostatSample edge cases', () => {
  test('keeps byte counts above 2^53 exact', () => {
    const [pool] = parseIostatSample([
      'huge  9007199254740993  18446744073709551615  0  0  0  0',
      '  sda  9007199254740993  18446744073709551615  0  0  0  0',
    ]).pools;
    expect(pool.capacity).toEqual({ allocBytes: '9007199254740993', freeBytes: '18446744073709551615' });
  });

  test('leaves out a pool whose rate a JSON number cannot carry exactly', () => {
    const { pools, problems } = parseIostatSample(['tank  1  1  9007199254740993  0  0  0', '  sda  0  0  0  0  0  0']);
    expect(pools).toEqual([]);
    expect(problems).toEqual([{ pool: 'tank', reason: 'rate out of range', line: 'tank  1  1  9007199254740993  0  0  0' }]);
  });

  test('reads a pool named like a group as a pool, because a pool line carries numbers', () => {
    const pools = parseIostatSample([
      'cache  100  200  1  2  3  4',
      '  sda  100  200  1  2  3  4',
      SEPARATOR,
    ]).pools;
    expect(pools.map((pool) => pool.name)).toEqual(['cache']);
    expect(names(pools[0].children)).toEqual(['sda']);
  });

  test('keeps a top-level disk named like a group apart from the group', () => {
    const [pool] = parseIostatSample([
      'tank  100  200  1  2  3  4',
      '  logs  100  200  1  2  3  4',
      'logs  -  -  -  -  -  -',
      '  nvme0n1  0  50  0  1  0  4096',
    ]).pools;
    expect(names(pool.children)).toEqual(['logs', '@logs']);
  });

  test('keeps names with spaces and slashes, as file vdevs print their full path', () => {
    const [pool] = parseIostatSample([
      'my pool  100  200  1  2  3  4',
      '  /var/lib/zfs/disk 1.img  100  200  1  2  3  4',
    ]).pools;
    expect(pool.name).toBe('my pool');
    expect(names(pool.children)).toEqual(['/var/lib/zfs/disk 1.img']);
  });

  test('nests a spare in use below its mirror', () => {
    const [pool] = parseIostatSample([
      'tank  100  200  1  2  3  4',
      '  mirror-0  100  200  1  2  3  4',
      '    spare-1  0  0  1  2  3  4',
      '      sdb  0  0  1  2  3  4',
      '      sdz  0  0  1  2  3  4',
      '    sda  0  0  1  2  3  4',
    ]).pools;
    const mirror = pool.children[0];
    expect(mirror.kind).toBe('vdev');
    if (mirror.kind !== 'vdev') return;
    expect(names(mirror.children)).toEqual(['spare-1', 'sda']);
    expect(mirror.children[0]).toMatchObject({ kind: 'vdev', children: [{ name: 'sdb' }, { name: 'sdz' }] });
  });

  test('returns no pools for a sample with none', () => {
    expect(parseIostatSample([SEPARATOR])).toEqual({ pools: [], problems: [] });
  });

  test.each([
    ['a device before any pool', ['  sda  0  0  1  2  3  4'], null, 'device outside a pool'],
    ['a device below a skipped level', ['tank  1  1  1  1  1  1', '      sda  0  0  1  2  3  4'], 'tank', 'device without a parent'],
    ['an odd indent', ['tank  1  1  1  1  1  1', '   sda  0  0  1  2  3  4'], 'tank', 'odd indent'],
    ['a rounded value from a run without -p', ['tank  1.81T  2.00T  1  2  1.2K  3', '  sda  -  -  1  2  1.2K  3'], 'tank', 'unrecognized pool line'],
    ['an unknown group header', ['tank  1  1  1  1  1  1', 'mystery  -  -  -  -  -  -'], 'tank', 'unrecognized line'],
    ['a group header outside a pool', ['special  -  -  -  -  -  -'], null, 'group outside a pool'],
    ['a repeated group header', ['tank  1  1  1  1  1  1', 'logs  -  -  -  -  -  -', '  a  0  1  0  0  0  0', 'logs  -  -  -  -  -  -'], 'tank', 'repeated group'],
  ])('reports %s and keeps no pool with it', (_label, lines, pool, reason) => {
    const sample = parseIostatSample(lines);
    expect(sample.pools).toEqual([]);
    expect(sample.problems).toEqual([expect.objectContaining({ pool, reason })]);
  });
});

describe('IostatSampleReader', () => {
  test('emits a sample only once the next header shows it is complete, with the header time', () => {
    const emitted: Array<{ pools: ZfsPool[]; time: number }> = [];
    let clock = 1000;
    const reader = new IostatSampleReader((pools, time) => emitted.push({ pools, time }), () => clock);

    for (const line of [...HEADER, 'tank  1  2  3  4  5  6']) reader.push(line);
    expect(emitted).toHaveLength(0);

    clock = 2000;
    reader.push(HEADER[0]);
    expect(emitted).toEqual([{ pools: [expect.objectContaining({ name: 'tank' })], time: 1000 }]);
  });

  test('ignores output before the first header', () => {
    const emitted: ZfsPool[][] = [];
    const reader = new IostatSampleReader((pools) => emitted.push(pools));
    reader.push('tank  1  2  3  4  5  6');
    reader.push(HEADER[0]);
    expect(emitted).toEqual([]);
  });

  test('sends the rest of a sample with a stray line and logs each problem once per five minutes', () => {
    const emitted: ZfsPool[][] = [];
    let clock = 0;
    const reader = new IostatSampleReader((pools) => emitted.push(pools), () => clock);
    const sampleWithStray = [...HEADER, 'tank  1  2  3  4  5  6', '  garbled line', SEPARATOR, 'backup  1  2  3  4  5  6', SEPARATOR];

    for (const at of [0, 1000, 2000, 301_000]) {
      clock = at;
      for (const line of sampleWithStray) reader.push(line);
    }
    clock = 302_000;
    reader.push(HEADER[0]);

    expect(emitted.map((pools) => pools.map((pool) => pool.name))).toEqual([['backup'], ['backup'], ['backup'], ['backup']]);
    expect(console.error).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledWith(
      'Could not read a zpool iostat line in pool tank, which is left out of the sample (unrecognized line):   garbled line',
    );
  });
});

function status(pools: Record<string, unknown>): string {
  return JSON.stringify({ output_version: { command: 'zpool status', vers_major: 0, vers_minor: 1 }, pools });
}

describe('parseZpoolStatus', () => {

  test('reads spares per pool and the pools iostat can report', () => {
    const summary = parseZpoolStatus(status({
      tank: { name: 'tank', state: 'ONLINE', vdevs: {}, spares: { sdz: { name: 'sdz', state: 'AVAIL' }, sdy: { name: 'sdy', state: 'INUSE' } } },
      gone: { name: 'gone', state: 'FAULTED', vdevs: {} },
      lost: { name: 'lost', state: 'UNAVAIL', vdevs: {} },
      degraded: { name: 'degraded', state: 'DEGRADED', vdevs: {} },
    }));
    expect(summary).not.toBeNull();
    expect(summary!.poolCount).toBe(4);
    expect([...summary!.reportablePools].sort((a, b) => a.localeCompare(b))).toEqual(['degraded', 'tank']);
    expect(summary!.sparesByPool).toEqual(new Map([['tank', ['sdy', 'sdz']]]));
  });

  test('reads the empty pool list zpool prints when none are imported', () => {
    expect(parseZpoolStatus(status({}))).toEqual({ poolCount: 0, reportablePools: new Set(), sparesByPool: new Map(), health: [] });
  });

  test.each([['not JSON', 'no pools available\n'], ['the wrong shape', '{"pools":[]}']])('returns null for %s', (_label, text) => {
    expect(parseZpoolStatus(text)).toBeNull();
  });
});

/**
 * Built from status_callback_json in cmd/zpool/zpool_main.c, not captured from a machine. The file is byte-identical
 * in zfs-2.3.3 and zfs-2.3.4, and zfs-2.4.4 changes no key, state name or output_version in what this reads.
 */
function statusFixture(version: '2.3.3' | '2.3.4' | '2.4.4'): ZfsPoolHealth[] {
  const text = readFileSync(join(import.meta.dir, 'fixtures', `zpool-status-jint-${version}.json`), 'utf-8');
  const health = parseZpoolStatus(text)?.health;
  if (!health) throw new Error(`the ${version} fixture did not parse`);
  return health;
}

function healthPool(pools: ZfsPoolHealth[], name: string): ZfsPoolHealth {
  const pool = pools.find((candidate) => candidate.name === name);
  if (!pool) throw new Error(`no pool ${name}`);
  return pool;
}

function healthNode(children: ReadonlyArray<ZfsDeviceHealth | ZfsGroupHealth>, ...path: string[]): ZfsDeviceHealth | ZfsGroupHealth {
  const [head, ...rest] = path;
  const found = children.find((child) => (child.kind === 'group' ? `@${child.group}` : child.name) === head);
  if (!found) throw new Error(`no node ${head}`);
  if (rest.length === 0) return found;
  if (found.kind === 'disk') throw new Error(`${head} has no children`);
  return healthNode(found.children, ...rest);
}

const NO_ERRORS = { read: 0, write: 0, checksum: 0 };

describe('parseZpoolStatus health', () => {
  test('asks zpool for integer JSON', () => {
    expect(ZPOOL_STATUS_ARGS).toEqual(['zpool', 'status', '-j', '--json-int']);
  });

  test.each(['2.3.3', '2.3.4', '2.4.4'] as const)('reads an online pool with every device group from %s', (version) => {
    const rpool = healthPool(statusFixture(version), 'rpool');
    expect(rpool.state).toBe('online');
    expect(rpool.children.map((child) => (child.kind === 'group' ? `@${child.group}` : child.name)))
      .toEqual(['mirror-0', '@special', '@dedup', '@logs', '@cache', '@spares']);
    expect(healthNode(rpool.children, 'mirror-0', 'ata-Samsung_SSD_870_EVO_2TB_S6PNNS0W100001A-part3'))
      .toEqual({ kind: 'disk', name: 'ata-Samsung_SSD_870_EVO_2TB_S6PNNS0W100001A-part3', state: 'online', errors: NO_ERRORS });
    expect(healthNode(rpool.children, '@special', 'mirror-2')).toMatchObject({ kind: 'vdev', state: 'online' });
    expect(healthNode(rpool.children, '@cache', 'nvme-KINGSTON_SNV2S500G_50026B7000000007')).toMatchObject({ kind: 'disk', state: 'online' });
    expect(healthNode(rpool.children, '@spares', 'ata-ST8000VN004-2M2101_WSD00009')).toEqual({
      kind: 'disk', name: 'ata-ST8000VN004-2M2101_WSD00009', state: 'online', errors: null,
    });
    expect(rpool.scan).toEqual({ kind: 'scrub', state: 'finished', percentDone: null, endedAt: 1763863212000, repairedBytes: 0, errors: 0 });
  });

  test('reads a degraded mirror with a faulted disk and its error counts from 2.3.3', () => {
    const tank = healthPool(statusFixture('2.3.3'), 'tank');
    expect(tank.state).toBe('degraded');
    expect(tank.scan).toBeNull();
    expect(healthNode(tank.children, 'mirror-0')).toMatchObject({ kind: 'vdev', state: 'degraded' });
    expect(healthNode(tank.children, 'mirror-0', 'ata-WDC_WD80EFZZ-68BTXN0_WD-CA0SDA')).toEqual({
      kind: 'disk', name: 'ata-WDC_WD80EFZZ-68BTXN0_WD-CA0SDA', state: 'faulted', errors: { read: 3, write: 0, checksum: 12 },
    });
  });

  test('reads a running scrub as a whole percent of what is issued from 2.3.3', () => {
    expect(healthPool(statusFixture('2.3.3'), 'backup').scan).toEqual({
      kind: 'scrub', state: 'running', percentDone: 42, endedAt: null, repairedBytes: 0, errors: 0,
    });
  });

  test('reads a resilver onto a hot spare from 2.3.4', () => {
    const tank = healthPool(statusFixture('2.3.4'), 'tank');
    expect(tank.state).toBe('degraded');
    expect(tank.scan).toEqual({ kind: 'resilver', state: 'running', percentDone: 42, endedAt: null, repairedBytes: 1288490188800, errors: 0 });
    expect(healthNode(tank.children, 'mirror-0', 'spare-0')).toMatchObject({ kind: 'vdev', state: 'degraded' });
    expect(healthNode(tank.children, 'mirror-0', 'spare-0', 'ata-WDC_WD80EFZZ-68BTXN0_WD-CA0SDA')).toMatchObject({
      state: 'faulted', errors: { read: 0, write: 7, checksum: 0 },
    });
    expect(healthNode(tank.children, '@spares', 'ata-ST8000VN004-2M2101_WSD00009')).toMatchObject({ state: 'online', errors: null });
  });

  test('reads a replaced disk that is gone and a finished resilver from 2.3.4', () => {
    const cold = healthPool(statusFixture('2.3.4'), 'cold');
    expect(healthNode(cold.children, 'mirror-0', 'replacing-0', '11987654321098765432')).toMatchObject({ kind: 'disk', state: 'unavailable' });
    expect(cold.scan).toEqual({ kind: 'resilver', state: 'finished', percentDone: null, endedAt: 1763280000000, repairedBytes: 2199023255552, errors: 0 });
  });

  test('reads a degraded mirror with a running scrub from 2.4.4', () => {
    const tank = healthPool(statusFixture('2.4.4'), 'tank');
    expect(tank.state).toBe('degraded');
    expect(healthNode(tank.children, 'mirror-0', 'ata-WDC_WD80EFZZ-68BTXN0_WD-CA0SDA')).toMatchObject({
      state: 'degraded', errors: { read: 0, write: 0, checksum: 41 },
    });
    expect(tank.scan).toEqual({ kind: 'scrub', state: 'running', percentDone: 85, endedAt: null, repairedBytes: 4096, errors: 0 });
  });

  test('reads a resilver onto a replacing disk from 2.4.4', () => {
    const fast = healthPool(statusFixture('2.4.4'), 'fast');
    expect(fast.scan).toMatchObject({ kind: 'resilver', state: 'running', percentDone: 10 });
    expect(healthNode(fast.children, 'mirror-0', 'replacing-1', 'nvme-old-0001')).toMatchObject({ kind: 'disk', state: 'offline' });
    expect(healthNode(fast.children, 'mirror-0', 'replacing-1', 'nvme-new-0002')).toMatchObject({ kind: 'disk', state: 'online' });
  });

  test('reads a paused scrub and a pool of one disk from 2.3.4', () => {
    const vault = healthPool(statusFixture('2.3.4'), 'vault');
    expect(vault.scan).toEqual({ kind: 'scrub', state: 'paused', percentDone: 25, endedAt: null, repairedBytes: 0, errors: 0 });
    expect(vault.children.map((child) => child.kind)).toEqual(['disk']);
  });

  test.each(['2.3.3', '2.3.4', '2.4.4'] as const)('builds a health frame the manager accepts from %s', (version) => {
    expect(zZfsHealthFrame.safeParse({ v: 1, time: 1, status: 'ok', pools: statusFixture(version) }).success).toBe(true);
  });

  const onePool = (pool: Record<string, unknown>) => status({ tank: { name: 'tank', state: 'ONLINE', ...pool } });
  const disk = (fields: Record<string, unknown>) => ({ name: 'sda', vdev_type: 'disk', state: 'ONLINE', read_errors: 0, write_errors: 0, checksum_errors: 0, ...fields });

  test('caps a counter at the integer limit to the largest exact number', () => {
    const text = onePool({ vdevs: { tank: { name: 'tank', vdevs: { sda: disk({}) } } } }).replace('"read_errors":0', '"read_errors":18446744073709551615');
    const [tank] = parseZpoolStatus(text)!.health!;
    expect(tank.children[0]).toMatchObject({ errors: { read: Number.MAX_SAFE_INTEGER, write: 0, checksum: 0 } });
  });

  test.each([
    ['CANT_OPEN', 'unavailable'], ['REMOVED', 'removed'], ['OFFLINE', 'offline'], ['CLOSED', 'offline'], ['SPLIT', 'unknown'], [undefined, 'unknown'],
  ])('reads device state %s as %s', (state, expected) => {
    const [tank] = parseZpoolStatus(onePool({ vdevs: { tank: { name: 'tank', vdevs: { sda: disk({ state }) } } } }))!.health!;
    expect(tank.children[0]).toMatchObject({ state: expected });
  });

  test.each<[string, ZfsPoolHealth['state']]>([['SUSPENDED', 'suspended'], ['UNAVAIL', 'unavailable'], ['FAULTED', 'faulted']])('reads pool state %s as %s', (state, expected) => {
    expect(parseZpoolStatus(status({ tank: { name: 'tank', state } }))!.health![0].state).toBe(expected);
  });

  test.each<[string, Record<string, unknown>, Record<string, unknown>]>([
    ['a canceled scrub', { function: 'SCRUB', state: 'CANCELED', end_time: 1700000000 }, { kind: 'scrub', state: 'canceled', percentDone: null, endedAt: 1700000000000 }],
    ['a canceled resilver', { function: 'RESILVER', state: 'CANCELED', end_time: 1700000000 }, { kind: 'resilver', state: 'canceled', endedAt: 1700000000000 }],
    ['a scan with nothing to examine', { function: 'SCRUB', state: 'SCANNING', to_examine: 0 }, { state: 'running', percentDone: 0 }],
  ])('reads %s', (_label, fields, expected) => {
    const scanStats = { end_time: 0, to_examine: 10, skipped: 0, issued: 0, processed: 0, errors: 0, scrub_pause: 0, ...fields };
    expect(parseZpoolStatus(onePool({ scan_stats: scanStats }))!.health![0].scan).toMatchObject(expected);
  });

  test.each([['NONE', 'NONE'], ['ERRORSCRUB', 'FINISHED'], ['SCRUB', 'ERRORSCRUBBING']])('reads no scan for function %s in state %s', (fn, state) => {
    const scanStats = { function: fn, state, end_time: 0, to_examine: 0, skipped: 0, issued: 0, processed: 0, errors: 0, scrub_pause: 0 };
    expect(parseZpoolStatus(onePool({ scan_stats: scanStats }))!.health![0].scan).toBeNull();
  });

  test('keeps the pool list but reads no health from counters zpool printed as scaled strings', () => {
    const summary = parseZpoolStatus(onePool({ vdevs: { tank: { name: 'tank', vdevs: { sda: disk({ read_errors: '1.2K' }) } } } }));
    expect(summary?.poolCount).toBe(1);
    expect(summary?.health).toBeNull();
  });
});

describe('withSpares', () => {
  test('adds a spares group with no capacity and no I/O to the pool that owns them', () => {
    const pool: ZfsPool = {
      name: 'tank',
      capacity: { allocBytes: '1', freeBytes: '2' },
      io: { readOps: 0, writeOps: 0, readBytes: 0, writeBytes: 0 },
      children: [],
    };
    const [tank, other] = withSpares([pool, { ...pool, name: 'other' }], new Map([['tank', ['sdz']]]));
    expect(tank.children).toEqual([{ kind: 'group', group: 'spares', children: [{ kind: 'disk', name: 'sdz', capacity: null, io: null }] }]);
    expect(other.children).toEqual([]);
  });
});
