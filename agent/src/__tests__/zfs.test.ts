import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test';
import type { ZfsCapabilities } from '../lib/zfs-capabilities';
import { handleZfsStatsStream, handleZfsPools } from '../routes/zfs';
import { readUntil, parseDataFrames } from '../lib/test/sse-test-utils';

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

describe('handleZfsStatsStream', () => {
  test('returns 503 when ZFS is not available', () => {
    const request = new Request('http://localhost/zfs/stats/stream');
    const response = handleZfsStatsStream(request, zfsUnavailable);

    expect(response.status).toBe(503);
  });

  test('returns 503 body with error message', async () => {
    const request = new Request('http://localhost/zfs/stats/stream');
    const response = handleZfsStatsStream(request, zfsUnavailable);
    const body = await response.json();

    expect(body.error).toBe('ZFS is not available on this host');
  });

  test('returns SSE response with correct headers when available', () => {
    const killMock = mock(() => {});
    const readableStream = new ReadableStream({
      start(controller) {
        controller.close();
      },
    });
    Bun.spawn = mock(() => ({
      stdout: readableStream,
      stderr: new ReadableStream(),
      kill: killMock,
      exited: Promise.resolve(0),
    })) as any;

    const request = new Request('http://localhost/zfs/stats/stream');
    const response = handleZfsStatsStream(request, zfsAvailable);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
  });

  test('pipes subprocess stderr and drains it into the log', async () => {
    let spawnOptions: unknown;
    let resolveLogged!: (line: string) => void;
    const logged = new Promise<string>((resolve) => {
      resolveLogged = resolve;
    });
    console.error = mock((...args: unknown[]) => {
      if (args[0] === 'zpool iostat:') resolveLogged(String(args[1]));
    });

    Bun.spawn = mock((_cmd: string[], options: unknown) => {
      spawnOptions = options;
      return {
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode("cannot open 'tank': no such pool\n"),
            );
          },
        }),
        kill: mock(() => {}),
        exited: new Promise(() => {}),
      };
    }) as any;

    const ac = new AbortController();
    const request = new Request('http://localhost/zfs/stats/stream', {
      signal: ac.signal,
    });
    handleZfsStatsStream(request, zfsAvailable);

    expect(await logged).toBe("cannot open 'tank': no such pool");
    ac.abort();

    expect(spawnOptions).toMatchObject({ stderr: 'pipe' });
  });

  test('streams parsed lines as SSE events', async () => {
    const killMock = mock(() => {});
    const iostatOutput = [
      '              capacity     operations     bandwidth',
      'pool        alloc   free   read  write   read  write',
      '----------  -----  -----  -----  -----  -----  -----',
      'tank        1.23T  4.56T      5     10  1.20M  3.40M',
    ].join('\n') + '\n';

    const readableStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(iostatOutput));
        controller.close();
      },
    });

    Bun.spawn = mock(() => ({
      stdout: readableStream,
      stderr: new ReadableStream(),
      kill: killMock,
      exited: Promise.resolve(0),
    })) as any;

    const ac = new AbortController();
    const request = new Request('http://localhost/zfs/stats/stream', { signal: ac.signal });
    const response = handleZfsStatsStream(request, zfsAvailable);

    const text = await readUntil(response, (s) => s.includes('tank'));
    ac.abort();

    expect(text).toContain('data:');
    // Each non-empty line should be a separate SSE event
    const events = parseDataFrames(text);

    expect(events.length).toBeGreaterThanOrEqual(1);
    const tankEvent = events.find((e: { line: string }) => e.line.includes('tank'));
    expect(tankEvent).toBeDefined();
    expect(tankEvent.timestamp).toBeNumber();
    expect(tankEvent.line).toContain('tank');
  });

  test('kills subprocess on client disconnect', async () => {
    const killMock = mock(() => {});
    const readableStream = new ReadableStream<Uint8Array>({
      start() {
        // Keep stream open; simulates long-running iostat
      },
    });

    Bun.spawn = mock(() => ({
      stdout: readableStream,
      stderr: new ReadableStream(),
      kill: killMock,
      exited: new Promise(() => {}), // never resolves
    })) as any;

    const ac = new AbortController();
    const request = new Request('http://localhost/zfs/stats/stream', { signal: ac.signal });
    handleZfsStatsStream(request, zfsAvailable);

    // Give the stream time to start
    await new Promise((r) => setTimeout(r, 20));

    ac.abort();
    await new Promise((r) => setTimeout(r, 20));

    expect(killMock).toHaveBeenCalled();
  });

  test('sets closed flag when enqueue throws (controller already closed)', async () => {
    const killMock = mock(() => {});
    // Emit two chunks: one to trigger the enqueue-after-close path
    const encoder = new TextEncoder();
    let resolveSecondChunk: (() => void) | undefined;
    const readableStream = new ReadableStream<Uint8Array>({
      async start(controller) {
        // Enqueue first chunk
        controller.enqueue(encoder.encode('line1\nline2\n'));
        // Wait a bit and enqueue more
        await new Promise<void>((r) => { resolveSecondChunk = r; });
        controller.enqueue(encoder.encode('line3\n'));
        controller.close();
      },
    });

    Bun.spawn = mock(() => ({
      stdout: readableStream,
      stderr: new ReadableStream(),
      kill: killMock,
      exited: Promise.resolve(0),
    })) as any;

    const ac = new AbortController();
    const request = new Request('http://localhost/zfs/stats/stream', { signal: ac.signal });
    const response = handleZfsStatsStream(request, zfsAvailable);

    // Wait for the first chunk to be processed, then abort to close controller
    await readUntil(response, (s) => s.includes('line1'), 2000);
    ac.abort();
    await new Promise((r) => setTimeout(r, 20));

    // Now release the second chunk; enqueue should catch
    resolveSecondChunk?.();
    await new Promise((r) => setTimeout(r, 20));

    // Stream should be closed without errors
    expect(killMock).toHaveBeenCalled();
  });

  test('logs error when stream reader throws unexpectedly', async () => {
    const killMock = mock(() => {});
    const readableStream = new ReadableStream<Uint8Array>({
      start() {
        // Stream that will error when read
      },
      pull() {
        throw new Error('read failure');
      },
    });

    Bun.spawn = mock(() => ({
      stdout: readableStream,
      stderr: new ReadableStream(),
      kill: killMock,
      exited: Promise.resolve(1),
    })) as any;

    const ac = new AbortController();
    const request = new Request('http://localhost/zfs/stats/stream', { signal: ac.signal });
    const response = handleZfsStatsStream(request, zfsAvailable);

    // Wait for the stream to error and close
    const reader = response.body!.getReader();
    const deadline = Date.now() + 3000;
    let done = false;
    while (!done && Date.now() < deadline) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
    ac.abort();

    expect(console.error).toHaveBeenCalled();
  });

  test('logs error when stderr reader throws unexpectedly', async () => {
    let resolveLogged!: (err: unknown) => void;
    const logged = new Promise<unknown>((resolve) => {
      resolveLogged = resolve;
    });
    console.error = mock((...args: unknown[]) => {
      if (args[0] === 'ZFS stats stderr read error:') resolveLogged(args[1]);
    });

    Bun.spawn = mock(() => ({
      stdout: new ReadableStream<Uint8Array>({ start() {} }),
      stderr: new ReadableStream<Uint8Array>({
        start() {},
        pull() {
          throw new Error('stderr read failure');
        },
      }),
      kill: mock(() => {}),
      exited: new Promise(() => {}),
    })) as any;

    const ac = new AbortController();
    const request = new Request('http://localhost/zfs/stats/stream', {
      signal: ac.signal,
    });
    handleZfsStatsStream(request, zfsAvailable);

    expect(await logged).toBeInstanceOf(Error);
    ac.abort();
  });

  test('skips empty lines in output', async () => {
    const killMock = mock(() => {});
    const output = '\n\n  \nactual data line\n\n';
    const readableStream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(output));
        controller.close();
      },
    });

    Bun.spawn = mock(() => ({
      stdout: readableStream,
      stderr: new ReadableStream(),
      kill: killMock,
      exited: Promise.resolve(0),
    })) as any;

    const ac = new AbortController();
    const request = new Request('http://localhost/zfs/stats/stream', { signal: ac.signal });
    const response = handleZfsStatsStream(request, zfsAvailable);

    const text = await readUntil(response, (s) => s.includes('actual data line'));
    ac.abort();

    // Only the non-empty line should appear
    const events = parseDataFrames(text);
    expect(events.length).toBe(1);
    expect(events[0].line).toBe('actual data line');
  });

  test('emits a comment heartbeat while zpool produces no output', async () => {
    // `zpool iostat -v 1` normally ticks every second, but a degraded pool with
    // a hung disk can stall it well past Bun's 10s HTTP idleTimeout.
    const realSetInterval = globalThis.setInterval;
    const ticks: Array<{ cb: () => void; ms: number }> = [];
    globalThis.setInterval = mock((cb: () => void, ms: number) => {
      ticks.push({ cb, ms });
      return ticks.length as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    Bun.spawn = mock(() => ({
      stdout: new ReadableStream<Uint8Array>({ start() {} }),
      stderr: new ReadableStream(),
      kill: mock(() => {}),
      exited: new Promise(() => {}),
    })) as any;

    try {
      const ac = new AbortController();
      const request = new Request('http://localhost/zfs/stats/stream', { signal: ac.signal });
      const response = handleZfsStatsStream(request, zfsAvailable);

      expect(ticks).toHaveLength(1);
      expect(ticks[0].ms).toBe(5000);

      ticks[0].cb();
      const text = await readUntil(response, (s) => s.split('\n\n').includes(':'));
      ac.abort();

      expect(text.split('\n\n')).toContain(':');
    } finally {
      globalThis.setInterval = realSetInterval;
    }
  });
});

describe('handleZfsPools', () => {
  test('returns 503 when ZFS is not available', async () => {
    const response = await handleZfsPools(zfsUnavailable);

    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body.error).toBe('ZFS is not available on this host');
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
    const body = await response.json();
    expect(body.error).toBe('Failed to list ZFS pools');
    expect(body.detail).toBe('no such command');
  });

  test('returns 500 when spawn throws', async () => {
    Bun.spawn = mock(() => {
      throw new Error('spawn failed');
    }) as any;

    const response = await handleZfsPools(zfsAvailable);

    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body.error).toBe('Failed to list ZFS pools');
    expect(body.detail).toBe('spawn failed');
  });
});
