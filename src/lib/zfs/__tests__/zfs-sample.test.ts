import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildZFSHostHierarchy } from '@/lib/utils/zfs-hierarchy-builder';
import type { NewZFSStat } from '@/lib/database/repositories/stats-repository';
import type { ZFSStatsRow } from '@/types/zfs';
import { parseInfluxLine, type ZpoolStatsLine } from '../zpool-influxdb';
import { readZpoolStatus, ZpoolStatusError } from '../zpool-status';
import { buildZfsSampleRows, influxDeviceKey, samplePoolNames, ZfsCounterTracker } from '../zfs-sample';

const FIXTURES = join(import.meta.dir, 'fixtures');
const VERSIONS = ['2.3.3', '2.4.4'] as const;

function fixtureLines(version: string, sample: number): ZpoolStatsLine[] {
  const text = readFileSync(join(FIXTURES, `zpool-influxdb-${version}-sample${sample}.txt`), 'utf-8');
  return text.split('\n').filter((line) => line !== '' && !line.startsWith('#')).flatMap((line) => {
    const parsed = parseInfluxLine(line);
    if (parsed.kind === 'malformed') throw new Error(`fixture line did not parse: ${parsed.reason}`);
    return parsed.kind === 'stats' ? [parsed.line] : [];
  });
}

function fixtureLayout(version: string) {
  return readZpoolStatus(readFileSync(join(FIXTURES, `zpool-status-${version}.json`), 'utf-8'));
}

function byEntity(rows: NewZFSStat[]): Map<string, NewZFSStat> {
  return new Map(rows.map((row) => [row.entity, row]));
}

function asReadRows(rows: NewZFSStat[]): ZFSStatsRow[] {
  return rows.map((row) => ({
    time: row.time.getTime(),
    host: row.host,
    pool: row.pool,
    entity: row.entity,
    entity_type: row.entityType,
    indent: row.indent,
    capacity_alloc: row.capacityAllocBytes === null ? null : Number(row.capacityAllocBytes),
    capacity_free: row.capacityFreeBytes === null ? null : Number(row.capacityFreeBytes),
    read_ops_per_sec: row.readOpsPerSec,
    write_ops_per_sec: row.writeOpsPerSec,
    read_bytes_per_sec: row.readBytesPerSec,
    write_bytes_per_sec: row.writeBytesPerSec,
    utilization_percent: null,
  }));
}

function twoSamples(version: string, host = 'pve1') {
  const layout = fixtureLayout(version);
  const tracker = new ZfsCounterTracker();
  const first = buildZfsSampleRows({ host, time: new Date(1000), lines: fixtureLines(version, 1), layout, tracker });
  const second = buildZfsSampleRows({ host, time: new Date(2000), lines: fixtureLines(version, 2), layout, tracker });
  return { first, second };
}

describe('parseInfluxLine', () => {
  it('reads a leaf line with escaped tags and exact 64-bit counters', () => {
    const parsed = parseInfluxLine(
      'zpool_stats,name=my\\ pool,state=ONLINE,path=/dev/a\\,b,vdev=root/mirror-0/disk-1 alloc=0u,free=0u,size=0u,read_bytes=18446744073709551615u,read_errors=1u,read_ops=2u,write_bytes=3u,write_errors=4u,write_ops=5u,checksum_errors=6u,fragmentation=0u,slow_ios=9u 1764240000000000000',
    );
    expect(parsed).toEqual({
      kind: 'stats',
      line: {
        pool: 'my pool',
        vdev: 'root/mirror-0/disk-1',
        path: '/dev/a,b',
        state: 'ONLINE',
        timestampNs: 1764240000000000000n,
        allocBytes: 0n,
        freeBytes: 0n,
        readOps: 2n,
        writeOps: 5n,
        readBytes: 18446744073709551615n,
        writeBytes: 3n,
        readErrors: 1n,
        writeErrors: 4n,
        checksumErrors: 6n,
      },
    });
  });

  it('passes over measurements it does not use and reports lines it cannot read', () => {
    expect(parseInfluxLine('zpool_scan_stats,function=scrub,name=tank,state=finished pct_done=100.00 1').kind).toBe('other');
    expect(parseInfluxLine('zpool_latency,name=tank,vdev=root total_read_1us=0u 1').kind).toBe('other');
    expect(parseInfluxLine('garbage').kind).toBe('malformed');
    expect(parseInfluxLine('zpool_stats,name=tank,state=ONLINE,vdev=root alloc=1u 1').kind).toBe('malformed');
    expect(parseInfluxLine('zpool_stats,state=ONLINE,vdev=root alloc=1u 1').kind).toBe('malformed');
    expect(parseInfluxLine('zpool_stats,name=tank,state=ONLINE,vdev=root alloc=1u notatime').kind).toBe('malformed');
  });
});

describe('readZpoolStatus', () => {
  it('reads no pools from the output of a node without any', () => {
    expect(readZpoolStatus('{"output_version":{"command":"zpool status","vers_major":0,"vers_minor":1},"pools":{}}')).toEqual([]);
  });

  it('refuses output that is not the JSON it expects', () => {
    expect(() => readZpoolStatus('no pools available')).toThrow(ZpoolStatusError);
    expect(() => readZpoolStatus('{"pools":{"tank":{"name":7}}}')).toThrow(ZpoolStatusError);
  });
});

describe('influxDeviceKey', () => {
  it('names non-leaf segments by id and the leaf by its path', () => {
    expect(influxDeviceKey('root', null)).toBe('');
    expect(influxDeviceKey('root/raidz-0', null)).toBe('/id:0');
    expect(influxDeviceKey('root/mirror-1/disk-0', '/dev/sdb1')).toBe('/id:1/path:/dev/sdb1');
    expect(influxDeviceKey('root/disk-2', '/dev/sdc1')).toBe('/path:/dev/sdc1');
    expect(influxDeviceKey('mirror-0', null)).toBeNull();
    expect(influxDeviceKey('root/mirror', null)).toBeNull();
  });
});

describe('buildZfsSampleRows', () => {
  it.each(VERSIONS)('lays out every device, group, cache and spare of OpenZFS %s', (version) => {
    const { second } = twoSamples(version);
    const rows = byEntity(second);

    expect(samplePoolNames(fixtureLines(version, 2))).toEqual(['rpool', 'tank']);
    expect(rows.get('rpool')).toMatchObject({ entityType: 'pool', indent: 0, state: 'ONLINE' });
    expect(rows.get('tank/@cache')).toMatchObject({ entityType: 'group', readOpsPerSec: null });
    expect(rows.get('tank/@spares')).toMatchObject({ entityType: 'group' });
    for (const row of second) {
      expect(row.time).toEqual(new Date(2000));
      expect(row.host).toBe('pve1');
    }
  });

  it('places the OpenZFS 2.3.3 log mirror, cache and spare under their groups with their own state', () => {
    const rows = byEntity(twoSamples('2.3.3').second);

    expect(rows.get('tank/raidz1-0')).toMatchObject({ entityType: 'vdev', indent: 2, state: 'DEGRADED' });
    expect(rows.get('tank/raidz1-0/ata-HDD_2')).toMatchObject({
      entityType: 'disk', indent: 4, state: 'FAULTED', readErrors: '3', checksumErrors: '12', capacityAllocBytes: null,
    });
    expect(rows.get('tank/@logs/mirror-1')).toMatchObject({ entityType: 'vdev', indent: 4 });
    expect(rows.get('tank/@logs/mirror-1/nvme-LOG_A')?.readOpsPerSec).toBeGreaterThan(0);
    expect(rows.get('tank/@cache/nvme-CACHE_A')).toMatchObject({
      entityType: 'disk', capacityAllocBytes: '53687091200', capacityFreeBytes: '202373423104', readOpsPerSec: null,
    });
    expect(rows.get('tank/@spares/ata-HDD_SPARE')).toMatchObject({ entityType: 'disk', state: 'AVAIL', readErrors: null });
    expect(rows.has('tank/@special')).toBe(false);
  });

  it('places the OpenZFS 2.4.4 special mirror and dedup disk under their groups, and a single-disk pool as one disk', () => {
    const rows = byEntity(twoSamples('2.4.4').second);

    expect(rows.get('rpool/nvme-BOOT-part3')).toMatchObject({ entityType: 'disk', indent: 2, capacityAllocBytes: '21474836480' });
    expect(rows.get('tank/@special/mirror-1/nvme-META_B')?.writeBytesPerSec).toBeGreaterThan(0);
    expect(rows.get('tank/@dedup/nvme-DDT')).toMatchObject({ entityType: 'disk', indent: 4 });
    expect(rows.get('tank/@dedup/nvme-DDT')?.readOpsPerSec).toBeGreaterThan(0);
    expect(rows.get('tank/@spares/ata-HDD_SPARE2')).toMatchObject({ state: 'AVAIL' });
  });

  it.each(VERSIONS)('builds the page tree for OpenZFS %s from the rows it writes', (version) => {
    const host = buildZFSHostHierarchy(asReadRows(twoSamples(version).second)).get('pve1')!;
    const tank = host.pools.get('tank')!;

    expect([...host.pools.keys()]).toEqual(['rpool', 'tank']);
    expect(tank.children.filter((child) => child.type === 'group').map((child) => child.group)).toEqual(
      version === '2.3.3' ? ['logs', 'cache', 'spares'] : ['special', 'dedup', 'cache', 'spares'],
    );
  });

  it('computes rates from the counter deltas over the node clock', () => {
    const tracker = new ZfsCounterTracker();
    const line = (timestampNs: bigint, readOps: bigint, readBytes: bigint): ZpoolStatsLine => ({
      pool: 'tank', vdev: 'root', path: null, state: 'ONLINE', timestampNs,
      allocBytes: 1n, freeBytes: 1n, readOps, writeOps: 0n, readBytes, writeBytes: 0n,
      readErrors: 0n, writeErrors: 0n, checksumErrors: 0n,
    });
    expect(tracker.rates(line(1_000_000_000n, 100n, 4096n))).toBeNull();
    expect(tracker.rates(line(3_000_000_000n, 300n, 12288n))).toEqual({
      readOpsPerSec: 100, writeOpsPerSec: 0, readBytesPerSec: 4096, writeBytesPerSec: 0,
    });
  });

  it('leaves the first sample blank, and the first after counters reset, instead of a spike or a negative rate', () => {
    const layout = fixtureLayout('2.3.3');
    const tracker = new ZfsCounterTracker();
    const before = fixtureLines('2.3.3', 2);
    const reset = fixtureLines('2.3.3', 1).map((line) => ({ ...line, timestampNs: line.timestampNs + 5_000_000_000n }));
    const after = reset.map((line) => ({
      ...line, timestampNs: line.timestampNs + 1_000_000_000n, readOps: line.readOps + 10n, readBytes: line.readBytes + 40960n,
    }));

    const first = buildZfsSampleRows({ host: 'pve1', time: new Date(1), lines: before, layout, tracker });
    const afterReset = buildZfsSampleRows({ host: 'pve1', time: new Date(2), lines: reset, layout, tracker });
    const next = buildZfsSampleRows({ host: 'pve1', time: new Date(3), lines: after, layout, tracker });

    for (const rows of [first, afterReset]) {
      for (const row of rows) expect(row.readOpsPerSec).toBeNull();
    }
    expect(byEntity(next).get('tank')?.readOpsPerSec).toBe(10);
    for (const row of next) if (row.readOpsPerSec !== null) expect(row.readOpsPerSec).toBeGreaterThanOrEqual(0);
  });

  it('writes one host row for a node with no pools', () => {
    const rows = buildZfsSampleRows({ host: 'pve3', time: new Date(5), lines: [], layout: [], tracker: new ZfsCounterTracker() });
    expect(rows).toEqual([expect.objectContaining({ host: 'pve3', pool: '', entity: '', entityType: 'host' })]);
    expect(buildZFSHostHierarchy(asReadRows(rows)).get('pve3')?.pools.size).toBe(0);
  });

  it('writes only the pool row of a pool imported since the last layout', () => {
    const tracker = new ZfsCounterTracker();
    const lines = fixtureLines('2.3.3', 1);
    const rows = buildZfsSampleRows({ host: 'pve1', time: new Date(1), lines, layout: fixtureLayout('2.3.3').filter((pool) => pool.name !== 'tank'), tracker });
    expect(rows.filter((row) => row.pool === 'tank').map((row) => row.entity)).toEqual(['tank']);
    expect(buildZfsSampleRows({ host: 'pve1', time: new Date(1), lines, layout: null, tracker }).map((row) => row.entity)).toEqual(['rpool', 'tank']);
  });

  it('keeps two cluster nodes with a pool named rpool apart, each under its own node', () => {
    const pve1 = twoSamples('2.3.3', 'pve1').second;
    const pve2 = twoSamples('2.4.4', 'pve2').second;
    const hierarchy = buildZFSHostHierarchy(asReadRows([...pve1, ...pve2]));

    const rpool1 = hierarchy.get('pve1')!.pools.get('rpool')!;
    const rpool2 = hierarchy.get('pve2')!.pools.get('rpool')!;
    expect(rpool1.id).toBe('pve1/rpool');
    expect(rpool2.id).toBe('pve2/rpool');
    expect(rpool1.children.map((child) => child.name)).toEqual(['mirror-0']);
    expect(rpool2.children.map((child) => child.name)).toEqual(['nvme-BOOT-part3']);
  });
});
