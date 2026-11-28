import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import type { NewZFSStat } from '@/lib/database/repositories/stats-repository';
import type { ZfsNodeFailure } from '@/lib/zfs/node-state';
import { ZfsSshError } from '@/lib/zfs/ssh-transport';
import { EMPTY_STATUS, FakeZfsTransport, ManualTicker } from '@/lib/test/fake-zfs-ssh';
import { mockSetTimeout, type CapturedTimer, type TimerMock } from '@/lib/test/mock-timers';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import {
  ZFS_HEALTHY_SESSION_MS,
  ZFS_MAX_SAMPLE_LINES,
  ZFS_SAMPLE_TIMEOUT_MS,
  ZFS_SLOW_RETRY_MS,
  ZfsNodeCollector,
} from '../zfs-node-collector';

function statusOf(...pools: string[]): string {
  return JSON.stringify({
    pools: Object.fromEntries(pools.map((pool) => [pool, { name: pool, state: 'ONLINE', vdevs: { [pool]: { name: pool, alloc_space: 100, total_space: 1000, vdevs: {} } } }])),
  });
}

const TANK_STATUS = statusOf('tank');
const OK = (stdout: string) => ({ code: 0, stdout, stderr: '' });

function poolLine(pool: string, seconds: number, readOps: number): string {
  return `zpool_stats,name=${pool},state=ONLINE,vdev=root alloc=100u,free=900u,size=1000u,read_bytes=${readOps * 4096}u,read_errors=0u,read_ops=${readOps}u,write_bytes=0u,write_errors=0u,write_ops=0u,checksum_errors=0u,fragmentation=0u ${BigInt(seconds) * 1_000_000_000n}\n`;
}

function poolEnd(pool: string): string {
  return `zpool_vdev_stats,name=${pool},vdev=root sync_r_active_queue=0u 1\n`;
}

function poolSample(pool: string, seconds: number, readOps: number): string {
  return poolLine(pool, seconds, readOps) + poolEnd(pool);
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
  const successes: Date[] = [];
  let failureWaiter: (() => void) | null = null;
  const nextFailure = () => new Promise<void>((resolve) => {
    failureWaiter = resolve;
  });
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

/** Captures the next backoff wait without firing it, then puts the real timers back so the test can keep stepping. */
async function captureBackoff(trigger: () => void): Promise<CapturedTimer> {
  let resolveTimer: (timer: CapturedTimer) => void = () => {};
  const scheduled = new Promise<CapturedTimer>((resolve) => {
    resolveTimer = resolve;
  });
  const mock: TimerMock = mockSetTimeout({ onSchedule: (timer) => resolveTimer(timer) });
  try {
    trigger();
    return await scheduled;
  } finally {
    mock.restore();
  }
}

describe('ZfsNodeCollector', () => {
  let timers: TimerMock | null = null;
  afterEach(() => {
    timers?.restore();
    timers = null;
  });

  test('asks zpool_influxdb once a second and writes rates, leaving the first sample blank', async () => {
    let ops = 0;
    const transport = new FakeZfsTransport({ status: OK(TANK_STATUS), influx: (request) => poolSample('tank', request + 1, (ops += 10)) });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(3);
    await waitForCondition(() => h.samples.length >= 2);
    h.controller.abort();
    await run;

    expect(pool(h.samples[0])?.readOpsPerSec).toBeNull();
    expect(pool(h.samples[1])).toMatchObject({ host: 'pve1', entity: 'tank', readOpsPerSec: 10, readBytesPerSec: 40960 });
    expect(transport.sessions).toHaveLength(1);
    expect(h.successes.length).toBeGreaterThanOrEqual(1);
    expect(transport.sessions[0].closed).toBe(true);
  });

  test('leaves a sample blank, never negative, when counters go backwards after an export and import', async () => {
    const counters = [100, 200, 5, 15];
    const transport = new FakeZfsTransport({
      status: OK(TANK_STATUS),
      influx: (request) => (request < counters.length ? poolSample('tank', request + 1, counters[request]) : null),
    });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(5);
    await waitForCondition(() => h.samples.length >= 4);
    h.controller.abort();
    await run;

    expect(h.samples.map((rows) => pool(rows)?.readOpsPerSec)).toEqual([null, 100, null, 10]);
  });

  test('starts every session blank, so a worker restart never compares against old counters', async () => {
    const transport = new FakeZfsTransport({ status: OK(TANK_STATUS), influx: (request) => poolSample('tank', request + 1, 1000 + request) });
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
  });

  test('keeps the backoff growing for a node that drops within a minute, and resets it after a healthy minute', async () => {
    const transport = new FakeZfsTransport({ status: OK(TANK_STATUS), influx: (request) => poolSample('tank', request + 1, request) });
    const h = harness(transport);
    const run = h.collector.run();
    const delays: number[] = [];
    for (const stepsUp of [3, 3, ZFS_HEALTHY_SESSION_MS / 1000 + 1]) {
      await h.steps(stepsUp);
      const session = transport.sessions.at(-1)!;
      const timer = await captureBackoff(() => session.close());
      delays.push(timer.delayMs);
      void timer.fn();
      await waitForCondition(() => transport.sessions.length > delays.length);
    }
    h.controller.abort();
    await run;

    expect(delays).toEqual([1000, 2000, 1000]);
  });

  test('reads nothing with a changed host key, retries slowly, and collects again once the real key is back', async () => {
    const transport = new FakeZfsTransport({ fingerprint: 'SHA256:other-machine', status: OK(TANK_STATUS), influx: (request) => poolSample('tank', request + 1, request) });
    const h = harness(transport);
    const failed = h.nextFailure();
    const backoff = captureBackoff(() => void h.collector.run());
    const run = (async () => {
      const timer = await backoff;
      return timer;
    })();
    await failed;
    const timer = await run;

    expect(h.failures).toEqual([['host_key_changed', 'SHA256:other-machine']]);
    expect(timer.delayMs).toBe(ZFS_SLOW_RETRY_MS);
    expect(transport.sessions).toHaveLength(0);
    expect(h.samples).toHaveLength(0);

    transport.behaviour.fingerprint = 'SHA256:node-key';
    h.collector.wake();
    await h.steps(2);
    await waitForCondition(() => h.samples.length >= 1);
    expect(h.successes.length).toBeGreaterThanOrEqual(1);
    h.controller.abort();
  });

  test('stops reading at the next connect when the host key changes mid-session, writing nothing after it', async () => {
    const transport = new FakeZfsTransport({ status: OK(TANK_STATUS), influx: (request) => poolSample('tank', request + 1, request * 10) });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(2);
    await waitForCondition(() => h.samples.length >= 1);
    const written = h.samples.length;

    transport.behaviour.fingerprint = 'SHA256:impostor';
    const quickRetry = await captureBackoff(() => transport.sessions[0].close());
    const slowRetry = await captureBackoff(() => void quickRetry.fn());

    expect(slowRetry.delayMs).toBe(ZFS_SLOW_RETRY_MS);
    expect(h.failures.at(-1)).toEqual(['host_key_changed', 'SHA256:impostor']);
    expect(transport.sessions).toHaveLength(1);
    expect(h.samples).toHaveLength(written);
    h.controller.abort();
    await run;
  });

  test('keeps sampling through a hung zpool status, never starts a second one, and clears the notice when it answers', async () => {
    const transport = new FakeZfsTransport({ status: 'hang', influx: (request) => poolSample('tank', request + 1, request) });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(ZFS_SAMPLE_TIMEOUT_MS / 1000 + 2);
    await waitForCondition(() => h.failures.some(([state]) => state === 'timeout'));
    const session = transport.sessions[0];
    const successesWhileHung = h.successes.length;
    const samplesWhileHung = h.samples.length;
    await h.steps(3);

    expect(session.statusCalls).toBe(1);
    expect(session.closed).toBe(false);
    expect(h.samples.length).toBeGreaterThan(samplesWhileHung);
    expect(h.successes.length).toBe(successesWhileHung);
    expect(h.failures.map(([state]) => state)).toEqual(['timeout']);

    session.releaseStatus(OK(TANK_STATUS));
    await h.steps(2);
    await waitForCondition(() => h.successes.length > successesWhileHung);
    h.controller.abort();
    await run;
  });

  test('marks a node whose zpool_influxdb hangs but which still answers, keeps the session, and recovers when it answers', async () => {
    let answering = false;
    const transport = new FakeZfsTransport({ status: OK(TANK_STATUS), influx: (request) => (answering ? poolSample('tank', request + 1, request) : null) });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(ZFS_SAMPLE_TIMEOUT_MS / 1000 + 1);
    await waitForCondition(() => h.failures.some(([state]) => state === 'timeout'));
    const session = transport.sessions[0];

    expect(session.livenessChecks).toBe(1);
    expect(session.closed).toBe(false);
    expect(session.streams[0].requests).toBe(1);

    answering = true;
    session.streams[0].emit(poolSample('tank', 100, 1));
    await h.steps(2);
    await waitForCondition(() => h.samples.length >= 1 && h.successes.length >= 1);
    expect(h.failures.map(([state]) => state)).toEqual(['timeout']);
    h.controller.abort();
    await run;
  });

  test('tells a dead connection from a hung pool: no answer to the liveness check is unreachable', async () => {
    const transport = new FakeZfsTransport({ status: OK(TANK_STATUS), influx: () => null, responsive: false });
    timers = mockSetTimeout();
    const h = harness(transport);
    const failed = h.nextFailure();
    const run = h.collector.run();
    timers.restore();
    timers = null;
    for (let i = 0; i < ZFS_SAMPLE_TIMEOUT_MS / 1000 + 1 && h.failures.length === 0; i++) await h.step();
    await failed;
    h.controller.abort();
    await run;

    expect(h.failures[0]).toEqual(['unreachable', null]);
    expect(transport.sessions[0].closed).toBe(true);
  });

  test('keeps another node updating while one node hangs', async () => {
    const hung = harness(new FakeZfsTransport({ status: OK(TANK_STATUS), influx: () => null }));
    const healthy = harness(
      new FakeZfsTransport({ status: OK(TANK_STATUS), influx: (request) => poolSample('tank', request + 1, request) }),
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

  test('waits for every pool of a sample split across a tick instead of writing it without one', async () => {
    const transport = new FakeZfsTransport({
      status: OK(statusOf('backup', 'tank')),
      influx: (request) => poolSample('backup', request + 1, request) + (request === 1 ? '' : poolSample('tank', request + 1, request)),
    });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(2);
    transport.sessions[0].streams[0].emit(poolSample('tank', 2, 1));
    await h.steps(1);
    await waitForCondition(() => h.samples.length >= 2);
    h.controller.abort();
    await run;

    for (const rows of h.samples.slice(0, 2)) {
      expect(pool(rows, 'tank')?.readErrors).toBe('0');
      expect(pool(rows, 'backup')?.readErrors).toBe('0');
    }
    expect(pool(h.samples[1], 'tank')?.readOpsPerSec).toBe(1);
  });

  test('writes status-only rows for a pool zpool_influxdb stopped before', async () => {
    const transport = new FakeZfsTransport({ status: OK(statusOf('backup', 'tank')), influx: (request) => poolLine('backup', request + 1, request) });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(4);
    await waitForCondition(() => h.samples.length >= 1);
    h.controller.abort();
    await run;

    expect(pool(h.samples[0], 'tank')).toMatchObject({ state: 'ONLINE', capacityAllocBytes: '100', capacityFreeBytes: '900', readOpsPerSec: null });
  });

  test('ends a session whose zpool_influxdb prints more lines than any pool has', async () => {
    const flood = Array.from({ length: ZFS_MAX_SAMPLE_LINES + 1 }, (_, i) => poolLine('tank', 1, i)).join('');
    const transport = new FakeZfsTransport({ status: OK(TANK_STATUS), influx: () => flood });
    timers = mockSetTimeout();
    const h = harness(transport);
    const failed = h.nextFailure();
    const run = h.collector.run();
    await failed;
    h.controller.abort();
    await run;
    expect(h.failures[0]).toEqual(['error', null]);
    expect(h.samples).toHaveLength(0);
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

  test('skips a line it does not know, logs it once without its control characters, and still writes the sample', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const transport = new FakeZfsTransport({
        status: OK(TANK_STATUS),
        influx: (request) => `zpool_stats,name=tank \u001b[31mgarbage\r\n${poolSample('tank', request + 1, request)}`,
      });
      const h = harness(transport);
      const run = h.collector.run();
      await h.steps(3);
      await waitForCondition(() => h.samples.length >= 2);
      h.controller.abort();
      await run;
      const logged = errors.mock.calls.filter(([message]) => String(message).includes('cannot read'));

      expect(pool(h.samples[1])?.entity).toBe('tank');
      expect(logged).toHaveLength(1);
      expect(String(logged[0][0])).not.toMatch(/[\u001b\r]/);
    } finally {
      errors.mockRestore();
    }
  });

  test('writes a host row each second for a node with no pools', async () => {
    const transport = new FakeZfsTransport({ status: OK(EMPTY_STATUS), influx: () => null });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(4);
    await waitForCondition(() => h.samples.length >= 2);
    h.controller.abort();
    await run;

    expect(h.samples[0]).toEqual([expect.objectContaining({ host: 'pve1', entityType: 'host', pool: '' })]);
    expect(h.failures).toHaveLength(0);
  });

  test('picks up a pool imported while the channel runs on the next sample', async () => {
    let imported = false;
    const transport = new FakeZfsTransport({
      status: OK(TANK_STATUS),
      influx: (request) => poolSample('tank', request + 1, request) + (imported ? poolSample('backup', request + 1, request) : ''),
    });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(2);
    imported = true;
    await h.steps(3);
    await waitForCondition(() => h.samples.length >= 3);
    h.controller.abort();
    await run;

    expect(pool(h.samples[0], 'backup')).toBeUndefined();
    expect(pool(h.samples.at(-1)!, 'backup')).toMatchObject({ entity: 'backup', entityType: 'pool' });
  });

  test('closes the session within the same turn when it is stopped', async () => {
    const transport = new FakeZfsTransport({ status: OK(TANK_STATUS), influx: (request) => poolSample('tank', request + 1, request) });
    const h = harness(transport);
    const run = h.collector.run();
    await h.steps(1);
    h.collector.stop();
    expect(transport.sessions[0].closed).toBe(true);
    await run;
  });
});
