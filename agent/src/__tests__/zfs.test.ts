import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import type { ZfsCapabilities } from '../lib/zfs-capabilities';
import { handleZfsStatsStream, handleZfsPools } from '../routes/zfs';
import { readUntil } from '../lib/test/sse-test-utils';
import { waitForCondition } from '../lib/test/wait-for-condition';
import { zZfsStatsFrame } from '../types/protocol';

const originalConsoleError = console.error;

beforeEach(() => {
  console.error = mock(() => {});
});

afterEach(() => {
  console.error = originalConsoleError;
});

const zfsAvailable: ZfsCapabilities = {
  available: true,
  version: '2.2.2',
  tier: 1,
  permissions: [],
};

const zfsUnavailable: ZfsCapabilities = {
  available: false,
  tier: 0,
  permissions: [],
};

const originalSpawn = Bun.spawn;

afterEach(() => {
  Bun.spawn = originalSpawn;
});

const encoder = new TextEncoder();

interface FakeIostat {
  args: string[];
  push: (text: string) => void;
  end: () => void;
  kill: ReturnType<typeof mock>;
}

/** Bun.spawn stand-in that answers `zpool iostat` with a stream the test writes and `zpool status -j` with `statusJson`. */
function fakeZpool(statusJson: () => { exitCode: number; text: string } = () => ({ exitCode: 0, text: statusText({}) })) {
  const iostats: FakeIostat[] = [];
  const statusKills: Array<ReturnType<typeof mock>> = [];
  Bun.spawn = mock((args: string[]) => {
    if (args[1] === 'status') {
      const { exitCode, text } = statusJson();
      const kill = mock(() => {});
      statusKills.push(kill);
      return { stdout: new Response(text).body!, stderr: new Response('').body!, exited: Promise.resolve(exitCode), kill };
    }
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
    const fake: FakeIostat = {
      args,
      push: (text) => controller.enqueue(encoder.encode(text)),
      end: () => controller.close(),
      kill: mock(() => {
        try { controller.close(); } catch { /* a test may have ended the stream first */ }
      }),
    };
    iostats.push(fake);
    return { stdout, stderr: new ReadableStream({ start() {} }), kill: fake.kill, exited: new Promise(() => {}) };
  }) as any;
  return { iostats, statusKills };
}

function statusText(pools: Record<string, { state?: string; spares?: string[] }>): string {
  return JSON.stringify({
    output_version: { command: 'zpool status', vers_major: 0, vers_minor: 1 },
    pools: Object.fromEntries(Object.entries(pools).map(([name, pool]) => [name, {
      name,
      state: pool.state ?? 'ONLINE',
      vdevs: {},
      ...(pool.spares ? { spares: Object.fromEntries(pool.spares.map((s) => [s, { name: s, state: 'AVAIL' }])) } : {}),
    }])),
  });
}

const HEADER = [
  '              capacity     operations     bandwidth',
  'pool        alloc   free   read  write   read  write',
  '----------  -----  -----  -----  -----  -----  -----',
].join('\n') + '\n';
const SEP = '----------  -----  -----  -----  -----  -----  -----\n';
const sample = (...lines: string[]) => HEADER + lines.join('\n') + '\n' + SEP;

/** Collects data frames off the SSE response as they arrive. */
function collectFrames(response: Response): { frames: any[]; done: Promise<void> } {
  const frames: any[] = [];
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const done = (async () => {
    while (true) {
      const { done: finished, value } = await reader.read();
      if (finished) return;
      text += decoder.decode(value, { stream: true });
      const parts = text.split('\n\n');
      text = parts.pop() ?? '';
      for (const part of parts) if (part.startsWith('data: ')) frames.push(JSON.parse(part.slice(6)));
    }
  })();
  return { frames, done };
}

describe('handleZfsStatsStream', () => {
  const realSetInterval = globalThis.setInterval;
  let intervals: Array<{ cb: () => void; ms: number }>;

  beforeEach(() => {
    intervals = [];
    globalThis.setInterval = mock((cb: () => void, ms: number) => {
      intervals.push({ cb, ms });
      return intervals.length as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;
  });

  afterEach(() => {
    globalThis.setInterval = realSetInterval;
  });

  const statusPoll = () => intervals.find((entry) => entry.ms === 60_000)!.cb;
  const statusSpawns = () => (Bun.spawn as any).mock.calls.filter(([args]: [string[]]) => args[1] === 'status').length;
  /** A poll only spawns once the previous one has finished, so a new spawn proves the last poll is done. */
  const startNextPoll = async () => {
    const before = statusSpawns();
    await waitForCondition(() => {
      statusPoll()();
      return statusSpawns() > before;
    });
  };
  const options = (clock: { now: number }) => ({ statusIntervalMs: 60_000, restartGraceMs: 10_000, now: () => clock.now });

  test('returns 503 with the zfs_unavailable body when ZFS is not available', async () => {
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream'), zfsUnavailable);

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.error).toBe('ZFS is not available on this host');
    expect(body.code).toBe('zfs_unavailable');
  });

  test('returns an SSE response and starts zpool iostat with exact values and no since-import report', () => {
    const { iostats } = fakeZpool();
    const ac = new AbortController();
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(iostats[0].args).toEqual(['zpool', 'iostat', '-v', '-p', '-y', '1']);
    ac.abort();
  });

  test('sends one typed frame per sample with the spares zpool status lists', async () => {
    const { iostats } = fakeZpool(() => ({ exitCode: 0, text: statusText({ tank: { spares: ['sdz'] } }) }));
    const clock = { now: 5000 };
    const ac = new AbortController();
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable, options(clock));
    const { frames } = collectFrames(response);
    await startNextPoll();

    iostats[0].push(sample('tank  100  200  1  2  3  4', '  sda  100  200  1  2  3  4') + HEADER);
    await waitForCondition(() => frames.length === 1);
    ac.abort();

    expect(zZfsStatsFrame.parse(frames[0])).toEqual({
      v: 1,
      time: 5000,
      pools: [{
        name: 'tank',
        capacity: { allocBytes: '100', freeBytes: '200' },
        io: { readOps: 1, writeOps: 2, readBytes: 3, writeBytes: 4 },
        children: [
          { kind: 'disk', name: 'sda', capacity: { allocBytes: '100', freeBytes: '200' }, io: { readOps: 1, writeOps: 2, readBytes: 3, writeBytes: 4 } },
          { kind: 'group', group: 'spares', children: [{ kind: 'disk', name: 'sdz', capacity: null, io: null }] },
        ],
      }],
    });
  });

  test('restarts iostat with -y when zpool status lists a pool iostat does not report, and drops the cut-off sample', async () => {
    let status = statusText({ tank: {} });
    const { iostats } = fakeZpool(() => ({ exitCode: 0, text: status }));
    const clock = { now: 0 };
    const ac = new AbortController();
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable, options(clock));
    const { frames } = collectFrames(response);

    iostats[0].push(sample('tank  1  1  1  1  1  1'));
    iostats[0].push(HEADER);
    await waitForCondition(() => frames.length === 1);
    iostats[0].push('tank  1  1  1  1  1  1\n');

    status = statusText({ tank: {}, imported: {} });
    clock.now = 10_000;
    statusPoll()();
    await waitForCondition(() => iostats.length === 2);

    expect(iostats[0].kill).toHaveBeenCalled();
    expect(iostats[1].args).toContain('-y');
    iostats[1].push(sample('imported  5  5  0  0  0  0', SEP + 'tank  1  1  1  1  1  1'));
    iostats[1].push(HEADER);
    await waitForCondition(() => frames.length === 2);
    ac.abort();

    expect(frames.map((frame) => frame.pools.map((pool: { name: string }) => pool.name))).toEqual([['tank'], ['imported', 'tank']]);
  });

  test('does not restart iostat inside the grace period, nor twice for the same missing pool', async () => {
    const { iostats } = fakeZpool(() => ({ exitCode: 0, text: statusText({ stuck: {} }) }));
    const clock = { now: 0 };
    const ac = new AbortController();
    handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable, options(clock));

    clock.now = 9_999;
    await startNextPoll();
    await startNextPoll();
    expect(iostats).toHaveLength(1);

    clock.now = 10_000;
    await startNextPoll();
    await waitForCondition(() => iostats.length === 2);
    clock.now = 30_000;
    await startNextPoll();
    await startNextPoll();
    ac.abort();

    expect(iostats).toHaveLength(2);
  });

  test('keeps streaming when zpool status fails', async () => {
    const { iostats } = fakeZpool(() => ({ exitCode: 1, text: '' }));
    const ac = new AbortController();
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable, options({ now: 0 }));
    const { frames } = collectFrames(response);

    iostats[0].push(sample('tank  1  1  1  1  1  1'));
    iostats[0].push(HEADER);
    await waitForCondition(() => frames.length === 1);
    ac.abort();

    expect(console.error).toHaveBeenCalledWith('zpool status exited with 1');
  });

  test('closes the stream without a partial sample when zpool iostat exits', async () => {
    const { iostats } = fakeZpool(() => ({ exitCode: 0, text: statusText({ tank: {} }) }));
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream'), zfsAvailable, options({ now: 0 }));
    const { frames, done } = collectFrames(response);

    iostats[0].push(sample('tank  1  1  1  1  1  1'));
    iostats[0].end();
    await done;

    expect(frames).toEqual([]);
  });

  test('kills both subprocesses on client disconnect', async () => {
    let releaseStatus!: () => void;
    const statusKill = mock(() => releaseStatus());
    const { iostats } = fakeZpool();
    const iostatSpawn = Bun.spawn;
    Bun.spawn = mock((args: string[], opts: unknown) => {
      if (args[1] !== 'status') return (iostatSpawn as any)(args, opts);
      return {
        stdout: new ReadableStream({ start(c) { releaseStatus = () => c.close(); } }),
        stderr: new Response('').body!,
        exited: new Promise(() => {}),
        kill: statusKill,
      };
    }) as any;
    const ac = new AbortController();
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable, options({ now: 0 }));
    await readUntil(response, (s) => s.includes(': ok'));

    ac.abort();

    expect(iostats[0].kill).toHaveBeenCalled();
    expect(statusKill).toHaveBeenCalled();
  });

  test('kills a zpool status that outlives its timeout', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const timeouts: Array<{ cb: () => void; ms: number }> = [];
    let resolveArmed!: () => void;
    const armed = new Promise<void>((resolve) => { resolveArmed = resolve; });
    globalThis.setTimeout = mock((cb: () => void, ms: number) => {
      timeouts.push({ cb, ms });
      if (ms === 10_000) resolveArmed();
      return timeouts.length as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;
    const statusKill = mock(() => {});
    try {
      fakeZpool();
      const iostatSpawn = Bun.spawn;
      Bun.spawn = mock((args: string[], opts: unknown) => {
        if (args[1] !== 'status') return (iostatSpawn as any)(args, opts);
        let exit!: (code: number) => void;
        return {
          stdout: new Response('').body!,
          stderr: new Response('').body!,
          exited: new Promise<number>((resolve) => { exit = resolve; }),
          kill: mock(() => { statusKill(); exit(143); }),
        };
      }) as any;
      const ac = new AbortController();
      handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable, options({ now: 0 }));

      await armed;
      expect(statusKill).not.toHaveBeenCalled();
      timeouts.find((entry) => entry.ms === 10_000)!.cb();
      const killsBeforeDisconnect = statusKill.mock.calls.length;
      ac.abort();
      expect(killsBeforeDisconnect).toBe(1);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
  });

  test('arms no status poll when the first zpool iostat cannot be spawned', async () => {
    Bun.spawn = mock(() => { throw new Error('zpool: not found'); }) as any;

    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream'), zfsAvailable, options({ now: 0 }));
    await collectFrames(response).done;

    expect(intervals.some((entry) => entry.ms === 60_000)).toBe(false);
    expect((Bun.spawn as any).mock.calls).toHaveLength(1);
  });

  test('closes the stream when zpool iostat cannot be spawned again for a restart', async () => {
    let status = statusText({ tank: {} });
    const { iostats } = fakeZpool(() => ({ exitCode: 0, text: status }));
    const working = Bun.spawn;
    const clock = { now: 0 };
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream'), zfsAvailable, options(clock));
    const { done } = collectFrames(response);
    iostats[0].push(sample('tank  1  1  1  1  1  1') + HEADER);
    await startNextPoll();

    Bun.spawn = mock((args: string[], opts: unknown) => {
      if (args[1] === 'status') return (working as any)(args, opts);
      throw new Error('fork failed');
    }) as any;
    status = statusText({ tank: {}, imported: {} });
    clock.now = 10_000;
    await startNextPoll();
    await done;

    expect(console.error).toHaveBeenCalledWith('Could not restart zpool iostat, closing the ZFS stats stream:', expect.any(Error));
  });

  test('sends an empty frame while no pool is imported, so the last exported pool drops off', async () => {
    const { iostats } = fakeZpool(() => ({ exitCode: 0, text: statusText({}) }));
    const clock = { now: 7000 };
    const ac = new AbortController();
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable, options(clock));
    const { frames } = collectFrames(response);

    await waitForCondition(() => frames.length === 1);
    ac.abort();

    expect(frames).toEqual([{ v: 1, time: 7000, pools: [] }]);
    expect(iostats).toHaveLength(1);
  });

  test('restarts iostat again when an exported pool is imported again under the same name', async () => {
    let status = statusText({ tank: {} });
    const { iostats } = fakeZpool(() => ({ exitCode: 0, text: status }));
    const clock = { now: 0 };
    const ac = new AbortController();
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable, options(clock));
    const { frames } = collectFrames(response);
    const report = async (fake: FakeIostat, ...pools: string[]) => {
      const before = frames.length;
      fake.push(sample(...pools.flatMap((pool, i) => (i === 0 ? [`${pool}  1  1  1  1  1  1`] : [SEP.trimEnd(), `${pool}  1  1  1  1  1  1`]))) + HEADER);
      await waitForCondition(() => frames.length > before);
    };

    await report(iostats[0], 'tank');
    status = statusText({ tank: {}, imp: {} });
    clock.now = 10_000;
    await startNextPoll();
    await waitForCondition(() => iostats.length === 2);
    await report(iostats[1], 'imp', 'tank');
    await startNextPoll();

    status = statusText({ tank: {} });
    await report(iostats[1], 'tank');
    await startNextPoll();

    status = statusText({ tank: {}, imp: {} });
    clock.now = 30_000;
    await startNextPoll();
    await waitForCondition(() => iostats.length === 3);
    ac.abort();

    expect(iostats[2].args).toContain('-y');
  });

  test('pipes subprocess stderr and drains it into the log', async () => {
    let resolveLogged!: (line: string) => void;
    const logged = new Promise<string>((resolve) => { resolveLogged = resolve; });
    console.error = mock((...args: unknown[]) => {
      if (args[0] === 'zpool iostat:') resolveLogged(String(args[1]));
    });
    let spawnOptions: unknown;
    Bun.spawn = mock((args: string[], opts: unknown) => {
      if (args[1] === 'status') return { stdout: new Response(statusText({})).body!, stderr: new Response('').body!, exited: Promise.resolve(0), kill: mock(() => {}) };
      spawnOptions = opts;
      return {
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start(c) { c.enqueue(encoder.encode("no pools available\ncannot open 'tank': I/O error\n")); } }),
        kill: mock(() => {}),
        exited: new Promise(() => {}),
      };
    }) as any;

    const ac = new AbortController();
    handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable, options({ now: 0 }));

    expect(await logged).toBe("cannot open 'tank': I/O error");
    ac.abort();
    expect(spawnOptions).toMatchObject({ stderr: 'pipe' });
    expect(console.error).not.toHaveBeenCalledWith('zpool iostat:', 'no pools available');
  });

  test('logs when the stdout reader throws and closes the stream', async () => {
    Bun.spawn = mock((args: string[]) => {
      if (args[1] === 'status') return { stdout: new Response(statusText({})).body!, stderr: new Response('').body!, exited: Promise.resolve(0), kill: mock(() => {}) };
      return {
        stdout: new ReadableStream<Uint8Array>({ pull() { throw new Error('read failure'); } }),
        stderr: new ReadableStream({ start() {} }),
        kill: mock(() => {}),
        exited: Promise.resolve(1),
      };
    }) as any;

    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream'), zfsAvailable, options({ now: 0 }));
    await collectFrames(response).done;

    expect(console.error).toHaveBeenCalledWith('ZFS stats stream error:', expect.any(Error));
  });

  test('emits a comment heartbeat while zpool produces no output', async () => {
    fakeZpool();
    const ac = new AbortController();
    const response = handleZfsStatsStream(new Request('http://localhost/zfs/stats/stream', { signal: ac.signal }), zfsAvailable, options({ now: 0 }));

    const heartbeat = intervals.find((entry) => entry.ms === 5000);
    expect(heartbeat).toBeDefined();
    heartbeat!.cb();
    const text = await readUntil(response, (s) => s.split('\n\n').includes(':'));
    ac.abort();

    expect(text.split('\n\n')).toContain(':');
  });
});

describe('handleZfsPools', () => {
  test('returns 503 when ZFS is not available', async () => {
    const response = await handleZfsPools(zfsUnavailable);

    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string; code: string };
    expect(body.error).toBe('ZFS is not available on this host');
    expect(body.code).toBe('zfs_unavailable');
  });

  test('returns parsed pool data from zpool list -Hp output', async () => {
    // zpool list -Hp columns: name, size, alloc, free, ckpoint, expandsz, frag, cap, dedup, health, altroot
    const zpoolOutput = 'tank\t10737418240\t5368709120\t5368709120\t-\t-\t12\t50\t1.00\tONLINE\t-\n';

    Bun.spawn = mock(() => ({
      stdout: new Response(zpoolOutput).body!,
      stderr: new Response('').body!,
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    })) as any;

    const response = await handleZfsPools(zfsAvailable);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.pools).toHaveLength(1);
    expect(body.pools[0]).toEqual({
      name: 'tank',
      size: 10737418240,
      allocated: 5368709120,
      free: 5368709120,
      fragmentation: 12,
      capacity: 50,
      dedup: 1.0,
      health: 'ONLINE',
    });
  });

  test('handles multiple pools', async () => {
    const zpoolOutput = [
      'tank\t10737418240\t5368709120\t5368709120\t-\t-\t12\t50\t1.00\tONLINE\t-',
      'backup\t21474836480\t1073741824\t20401094656\t-\t-\t-\t5\t1.00\tONLINE\t-',
    ].join('\n') + '\n';

    Bun.spawn = mock(() => ({
      stdout: new Response(zpoolOutput).body!,
      stderr: new Response('').body!,
      exited: Promise.resolve(0),
      kill: mock(() => {}),
    })) as any;

    const response = await handleZfsPools(zfsAvailable);
    const body = await response.json();

    expect(body.pools).toHaveLength(2);
    expect(body.pools[0].name).toBe('tank');
    expect(body.pools[1].name).toBe('backup');
    // '-' fragmentation should parse as null
    expect(body.pools[1].fragmentation).toBeNull();
  });

  test('returns 500 when zpool command fails', async () => {
    Bun.spawn = mock(() => ({
      stdout: new Response('').body!,
      stderr: new Response('no such command').body!,
      exited: Promise.resolve(1),
      kill: mock(() => {}),
    })) as any;

    const response = await handleZfsPools(zfsAvailable);

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; code: string; detail: string };
    expect(body.error).toBe('Failed to list ZFS pools');
    expect(body.code).toBe('zfs_pool_list_failed');
    expect(body.detail).toBe('no such command');
  });

  test('returns 500 when spawn throws', async () => {
    Bun.spawn = mock(() => {
      throw new Error('spawn failed');
    }) as any;

    const response = await handleZfsPools(zfsAvailable);

    expect(response.status).toBe(500);
    const body = (await response.json()) as { error: string; code: string; detail: string };
    expect(body.error).toBe('Failed to list ZFS pools');
    expect(body.code).toBe('zfs_pool_list_failed');
    expect(body.detail).toBe('spawn failed');
  });
});
