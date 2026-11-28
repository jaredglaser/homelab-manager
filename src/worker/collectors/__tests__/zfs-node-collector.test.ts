import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { NewZFSStat } from '@/lib/database/repositories/stats-repository';
import type { ZfsNodeFailure } from '@/lib/zfs/node-state';
import { ZfsSshError } from '@/lib/zfs/ssh-transport';
import { EMPTY_STATUS, FakeZfsTransport, ManualTicker } from '@/lib/test/fake-zfs-ssh';
import { mockSetTimeout, type TimerMock } from '@/lib/test/mock-timers';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import { ZFS_SAMPLE_TIMEOUT_MS, ZfsNodeCollector } from '../zfs-node-collector';

const TANK_STATUS = JSON.stringify({
  pools: { tank: { name: 'tank', state: 'ONLINE', vdevs: { tank: { name: 'tank', vdevs: {} } } } },
});

function poolLine(pool: string, seconds: number, readOps: number): string {
  return `zpool_stats,name=${pool},state=ONLINE,vdev=root alloc=100u,free=900u,size=1000u,read_bytes=${readOps * 4096}u,read_errors=0u,read_ops=${readOps}u,write_bytes=0u,write_errors=0u,write_ops=0u,checksum_errors=0u,fragmentation=0u ${BigInt(seconds) * 1_000_000_000n}\n`;
}

const NODE = {
  id: 7,
  name: 'pve1',
  address: 'pve1.lan',
  port: 22,
  username: 'hlm',
  privateKey: 'private',
  hostKeyFingerprint: 'SHA256:node-key',
};

function harness(transport: FakeZfsTransport, node = NODE) {
  const ticker = new ManualTicker();
  const samples: NewZFSStat[][] = [];
  const failures: [ZfsNodeFailure, string | null | undefined][] = [];
  let failureWaiter: (() => void) | null = null;
  const nextFailure = () => new Promise<void>((resolve) => {
    failureWaiter = resolve;
  });
  const successes: Date[] = [];
  const controller = new AbortController();
  const collector = new ZfsNodeCollector(
    node,
    {
      transport,
      states: {
        recordFailure: async (_id, state, fingerprint) => {
          failures.push([state, fingerprint]);
          failureWaiter?.();
        },
        recordSuccess: async (_id, at) => {
          successes.push(at);
        },
      },
      insertRows: async (rows) => {
        samples.push(rows);
      },
      now: ticker.now,
      tick: ticker.tick,
    },
    controller,
  );
  const step = async () => {
    await waitForCondition(() => ticker.waiting, { message: 'collector never waited for the next sample' });
    ticker.release();
  };
  const steps = async (count: number) => {
    for (let i = 0; i < count; i++) await step();
  };
  return { ticker, samples, failures, successes, controller, collector, step, steps, nextFailure };
}

function pool(rows: NewZFSStat[], name = 'tank'): NewZFSStat | undefined {
  return rows.find((row) => row.entityType === 'pool' && row.pool === name);
}

describe('ZfsNodeCollector', () => {
  let timers: TimerMock | null = null;
  afterEach(() => {
    timers?.restore();
    timers = null;
  });

  test('asks zpool_influxdb once a second and writes rates, leaving the first sample blank', async () => {
    let ops = 0;
    const transport = new FakeZfsTransport({
      status: { code: 0, stdout: TANK_STATUS, stderr: '' },
      influx: (request) => poolLine('tank', request + 1, (ops += 10)),
    });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(3);
    await waitForCondition(() => h.samples.length >= 2);
    h.controller.abort();
    await run;

    expect(pool(h.samples[0])?.readOpsPerSec).toBeNull();
    expect(pool(h.samples[1])).toMatchObject({ host: 'pve1', entity: 'tank', readOpsPerSec: 10, readBytesPerSec: 40960 });
    expect(transport.sessions).toHaveLength(1);
    expect(transport.sessions[0].streams[0].requests).toBeGreaterThanOrEqual(3);
    expect(h.successes.length).toBeGreaterThanOrEqual(1);
    expect(transport.sessions[0].closed).toBe(true);
  });

  test('leaves a sample blank, never negative, when counters go backwards after an export and import', async () => {
    const counters = [100, 200, 5, 15];
    const transport = new FakeZfsTransport({
      status: { code: 0, stdout: TANK_STATUS, stderr: '' },
      influx: (request) => (request < counters.length ? poolLine('tank', request + 1, counters[request]) : null),
    });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(5);
    await waitForCondition(() => h.samples.length >= 4);
    h.controller.abort();
    await run;

    expect(h.samples.map((rows) => pool(rows)?.readOpsPerSec)).toEqual([null, 100, null, 10]);
  });

  test('starts every session blank, so a worker restart or reconnect never compares against old counters', async () => {
    const transport = new FakeZfsTransport({
      status: { code: 0, stdout: TANK_STATUS, stderr: '' },
      influx: (request) => poolLine('tank', request + 1, 1000 + request),
    });
    const first = harness(transport);
    const firstRun = first.collector.run();
    await first.steps(2);
    await waitForCondition(() => first.samples.length >= 1);
    first.controller.abort();
    await firstRun;

    const restarted = harness(transport);
    const run = restarted.collector.run();
    await restarted.steps(2);
    await waitForCondition(() => restarted.samples.length >= 1);
    restarted.controller.abort();
    await run;

    expect(pool(restarted.samples[0])?.readOpsPerSec).toBeNull();
  });

  test('reconnects with a growing backoff while the node is unreachable', async () => {
    const transport = new FakeZfsTransport({ connectError: new ZfsSshError('unreachable', 'connect ECONNREFUSED') });
    const scheduled: number[] = [];
    let onBackoff: (() => void) | null = null;
    timers = mockSetTimeout({
      onSchedule: (timer) => {
        scheduled.push(timer.delayMs);
        onBackoff?.();
      },
    });
    const h = harness(transport);
    const nextBackoff = () => new Promise<void>((resolve) => {
      onBackoff = resolve;
    });

    let waiting = nextBackoff();
    const run = h.collector.run();
    for (let attempt = 0; attempt < 3; attempt++) {
      await waiting;
      waiting = nextBackoff();
      timers.fireNext();
    }
    await waiting;
    h.controller.abort();
    await run;

    expect(scheduled.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    expect(transport.attempts).toHaveLength(4);
    expect(h.failures.every(([state]) => state === 'unreachable')).toBe(true);
    expect(transport.sessions).toHaveLength(0);
  });

  test('stops collecting when the host key changes, and reads nothing with the unconfirmed key', async () => {
    const transport = new FakeZfsTransport({ fingerprint: 'SHA256:other-machine' });
    const h = harness(transport);
    await h.collector.run();

    expect(h.failures).toEqual([['host_key_changed', 'SHA256:other-machine']]);
    expect(transport.attempts).toHaveLength(1);
    expect(transport.sessions).toHaveLength(0);
    expect(h.samples).toHaveLength(0);
  });

  test('stops at the next connect when the host key changes mid-session, writing nothing after it', async () => {
    const transport = new FakeZfsTransport({
      status: { code: 0, stdout: TANK_STATUS, stderr: '' },
      influx: (request) => poolLine('tank', request + 1, request * 10),
    });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(2);
    await waitForCondition(() => h.samples.length >= 1);
    const written = h.samples.length;

    transport.behaviour.fingerprint = 'SHA256:impostor';
    timers = mockSetTimeout({ fireImmediately: true });
    transport.sessions[0].close();
    await run;

    expect(h.failures.at(-1)).toEqual(['host_key_changed', 'SHA256:impostor']);
    expect(transport.sessions).toHaveLength(1);
    expect(h.samples).toHaveLength(written);
  });

  test('times out a sample that never answers, marks the node and closes the session', async () => {
    const transport = new FakeZfsTransport({
      status: { code: 0, stdout: TANK_STATUS, stderr: '' },
      influx: (request) => (request === 0 ? poolLine('tank', 1, 1) : null),
    });
    const h = harness(transport);
    const run = h.collector.run();
    let stepsTaken = 0;
    while (!h.failures.some(([state]) => state === 'timeout')) {
      await h.step();
      stepsTaken++;
      if (stepsTaken > ZFS_SAMPLE_TIMEOUT_MS / 1000 + 3) throw new Error('never timed out');
    }
    h.controller.abort();
    await run;

    expect(stepsTaken).toBeGreaterThanOrEqual(ZFS_SAMPLE_TIMEOUT_MS / 1000);
    expect(transport.sessions[0].closed).toBe(true);
  });

  test('keeps another node updating while one node hangs', async () => {
    const hung = harness(new FakeZfsTransport({ status: { code: 0, stdout: TANK_STATUS, stderr: '' }, influx: () => null }));
    const healthy = harness(
      new FakeZfsTransport({ status: { code: 0, stdout: TANK_STATUS, stderr: '' }, influx: (request) => poolLine('tank', request + 1, request) }),
      { ...NODE, id: 8, name: 'pve2' },
    );
    const runs = [hung.collector.run(), healthy.collector.run()];
    for (let i = 0; i < ZFS_SAMPLE_TIMEOUT_MS / 1000 + 1; i++) {
      await Promise.all([hung.step(), healthy.step()]);
    }
    await waitForCondition(() => hung.failures.some(([state]) => state === 'timeout'));
    await waitForCondition(() => healthy.samples.length >= ZFS_SAMPLE_TIMEOUT_MS / 1000);
    hung.controller.abort();
    healthy.controller.abort();
    await Promise.all(runs);

    expect(hung.samples).toHaveLength(0);
    expect(healthy.failures).toHaveLength(0);
    expect(healthy.samples.every((rows) => rows[0].host === 'pve2')).toBe(true);
  });

  test('marks a node missing zpool_influxdb', async () => {
    const transport = new FakeZfsTransport({ influxExit: 127 });
    timers = mockSetTimeout();
    const h = harness(transport);
    const failed = h.nextFailure();
    const run = h.collector.run();
    await failed;
    h.controller.abort();
    await run;
    expect(h.failures[0]).toEqual(['influxdb_missing', null]);
  });

  test('marks a refused key', async () => {
    const transport = new FakeZfsTransport({ connectError: new ZfsSshError('key_refused', 'All configured authentication methods failed') });
    timers = mockSetTimeout();
    const h = harness(transport);
    const failed = h.nextFailure();
    const run = h.collector.run();
    await failed;
    h.controller.abort();
    await run;
    expect(h.failures[0]).toEqual(['key_refused', null]);
  });

  test('skips a line it does not know, logs it once, and still writes the sample', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    const transport = new FakeZfsTransport({
      status: { code: 0, stdout: TANK_STATUS, stderr: '' },
      influx: (request) => `zpool_stats,name=tank garbage\n${poolLine('tank', request + 1, request)}`,
    });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(3);
    await waitForCondition(() => h.samples.length >= 2);
    h.controller.abort();
    await run;
    const logged = errors.mock.calls.filter(([message]) => String(message).includes('cannot read'));
    errors.mockRestore();

    expect(pool(h.samples[1])?.entity).toBe('tank');
    expect(logged).toHaveLength(1);
  });

  test('writes a host row each second for a node with no pools', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: EMPTY_STATUS, stderr: '' }, influx: () => null });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(3);
    await waitForCondition(() => h.samples.length >= 2);
    h.controller.abort();
    await run;

    expect(h.samples[0]).toEqual([expect.objectContaining({ host: 'pve1', entityType: 'host', pool: '' })]);
    expect(h.failures).toHaveLength(0);
  });

  test('picks up a pool imported while the channel runs on the next sample', async () => {
    let imported = false;
    const transport = new FakeZfsTransport({
      status: { code: 0, stdout: TANK_STATUS, stderr: '' },
      influx: (request) => poolLine('tank', request + 1, request) + (imported ? poolLine('backup', request + 1, request) : ''),
    });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(2);
    imported = true;
    await h.steps(2);
    await waitForCondition(() => h.samples.length >= 3);
    h.controller.abort();
    await run;

    expect(pool(h.samples[0], 'backup')).toBeUndefined();
    expect(pool(h.samples.at(-1)!, 'backup')).toMatchObject({ entity: 'backup', entityType: 'pool' });
  });

  test('closes the session within the same turn when it is stopped', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK_STATUS, stderr: '' }, influx: (request) => poolLine('tank', request + 1, request) });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(1);
    h.collector.stop();
    expect(transport.sessions[0].closed).toBe(true);
    await run;
  });
});
