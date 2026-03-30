import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import { handleStatsStream, computeMetrics, type StatsStreamOptions, type ComputedStats } from '../routes/stats';

beforeAll(() => {
  console.error = mock(() => {});
});

/** Read chunks from the stream until predicate is satisfied or timeout. */
async function readUntil(
  response: Response,
  predicate: (accumulated: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  let text = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`readUntil timed out after ${timeoutMs}ms`)), timeoutMs),
      );
      const { done, value } = await Promise.race([reader.read(), timeoutPromise]);
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) break;
    }
  } finally {
    reader.cancel();
  }
  return text;
}

function makeStatsJson(overrides?: {
  cpuTotal?: number;
  preCpuTotal?: number;
  systemCpu?: number;
  preSystemCpu?: number;
  onlineCpus?: number;
  memUsage?: number;
  memLimit?: number;
  rxBytes?: number;
  txBytes?: number;
  blkioRead?: number;
  blkioWrite?: number;
  read?: string;
  networks?: Record<string, unknown> | null;
  blkioStats?: Record<string, unknown> | null;
}) {
  const o = overrides ?? {};
  const base: Record<string, unknown> = {
    read: o.read ?? '2026-03-29T12:00:00.000000000Z',
    cpu_stats: {
      cpu_usage: { total_usage: o.cpuTotal ?? 2000 },
      system_cpu_usage: o.systemCpu ?? 20000,
      online_cpus: o.onlineCpus ?? 2,
    },
    precpu_stats: {
      cpu_usage: { total_usage: o.preCpuTotal ?? 1000 },
      system_cpu_usage: o.preSystemCpu ?? 10000,
    },
    memory_stats: {
      usage: o.memUsage ?? 256 * 1024 * 1024,
      limit: o.memLimit ?? 1024 * 1024 * 1024,
    },
  };

  // Allow explicit null to omit networks entirely
  if (o.networks === null) {
    // no networks key
  } else {
    base.networks = o.networks ?? { eth0: { rx_bytes: o.rxBytes ?? 1000, tx_bytes: o.txBytes ?? 500 } };
  }

  // Allow explicit null to omit blkio_stats entirely
  if (o.blkioStats === null) {
    // no blkio_stats key
  } else {
    base.blkio_stats = o.blkioStats ?? {
      io_service_bytes_recursive: [
        { op: 'Read', value: o.blkioRead ?? 4096 },
        { op: 'Write', value: o.blkioWrite ?? 2048 },
      ],
    };
  }

  return JSON.stringify(base);
}

/** Parse a flat ComputedStats from SSE text. */
function parseStatsEvent(text: string): ComputedStats {
  const dataEvent = text.split('\n\n').filter(Boolean).find(e => e.includes('"containerId"'));
  if (!dataEvent) throw new Error('No containerId event found in SSE text');
  return JSON.parse(dataEvent.replace(/^data:\s*/, ''));
}

describe('computeMetrics (unit)', () => {
  test('computes CPU percent from delta / system delta * online CPUs * 100', () => {
    const stats = JSON.parse(makeStatsJson({ cpuTotal: 3000, preCpuTotal: 1000, systemCpu: 20000, preSystemCpu: 10000, onlineCpus: 4 }));
    const prevFrames = new Map();
    const result = computeMetrics('c1', 'test', 'img', stats, prevFrames);
    // cpuDelta=2000, systemDelta=10000 → (2000/10000)*4*100 = 80
    expect(result.cpuPercent).toBe(80);
  });

  test('returns 0 CPU when system delta is 0', () => {
    const stats = JSON.parse(makeStatsJson({ systemCpu: 10000, preSystemCpu: 10000 }));
    const prevFrames = new Map();
    const result = computeMetrics('c1', 'test', 'img', stats, prevFrames);
    expect(result.cpuPercent).toBe(0);
  });

  test('computes memory usage and percent', () => {
    const stats = JSON.parse(makeStatsJson({ memUsage: 512 * 1024 * 1024, memLimit: 1024 * 1024 * 1024 }));
    const prevFrames = new Map();
    const result = computeMetrics('c1', 'test', 'img', stats, prevFrames);
    expect(result.memoryUsage).toBe(512 * 1024 * 1024);
    expect(result.memoryLimit).toBe(1024 * 1024 * 1024);
    expect(result.memoryPercent).toBe(50);
  });

  test('returns 0 memory percent when limit is 0', () => {
    const stats = JSON.parse(makeStatsJson({ memUsage: 100, memLimit: 0 }));
    const prevFrames = new Map();
    const result = computeMetrics('c1', 'test', 'img', stats, prevFrames);
    expect(result.memoryPercent).toBe(0);
  });

  test('emits 0 rates on first frame', () => {
    const stats = JSON.parse(makeStatsJson({ rxBytes: 5000, txBytes: 3000 }));
    const prevFrames = new Map();
    const result = computeMetrics('c1', 'test', 'img', stats, prevFrames);
    expect(result.networkRxBytesPerSec).toBe(0);
    expect(result.networkTxBytesPerSec).toBe(0);
    expect(result.blockReadBytesPerSec).toBe(0);
    expect(result.blockWriteBytesPerSec).toBe(0);
  });

  test('computes correct rates on second frame', () => {
    const prevFrames = new Map();
    const frame1 = JSON.parse(makeStatsJson({
      rxBytes: 1000, txBytes: 500, blkioRead: 4096, blkioWrite: 2048,
      read: '2026-03-29T12:00:00.000000000Z',
    }));
    computeMetrics('c1', 'test', 'img', frame1, prevFrames);

    const frame2 = JSON.parse(makeStatsJson({
      rxBytes: 3000, txBytes: 1500, blkioRead: 8192, blkioWrite: 4096,
      read: '2026-03-29T12:00:02.000000000Z',
    }));
    const result = computeMetrics('c1', 'test', 'img', frame2, prevFrames);

    // 2 second delta: (3000-1000)/2 = 1000, (1500-500)/2 = 500
    expect(result.networkRxBytesPerSec).toBe(1000);
    expect(result.networkTxBytesPerSec).toBe(500);
    // (8192-4096)/2 = 2048, (4096-2048)/2 = 1024
    expect(result.blockReadBytesPerSec).toBe(2048);
    expect(result.blockWriteBytesPerSec).toBe(1024);
  });

  test('handles missing networks gracefully', () => {
    const stats = JSON.parse(makeStatsJson({ networks: null }));
    const prevFrames = new Map();
    const result = computeMetrics('c1', 'test', 'img', stats, prevFrames);
    expect(result.networkRxBytesPerSec).toBe(0);
    expect(result.networkTxBytesPerSec).toBe(0);
  });

  test('handles missing blkio_stats gracefully', () => {
    const stats = JSON.parse(makeStatsJson({ blkioStats: null }));
    const prevFrames = new Map();
    const result = computeMetrics('c1', 'test', 'img', stats, prevFrames);
    expect(result.blockReadBytesPerSec).toBe(0);
    expect(result.blockWriteBytesPerSec).toBe(0);
  });

  test('uses stats.read as timestamp', () => {
    const ts = '2026-03-29T15:30:00.000000000Z';
    const stats = JSON.parse(makeStatsJson({ read: ts }));
    const prevFrames = new Map();
    const result = computeMetrics('c1', 'test', 'img', stats, prevFrames);
    expect(result.timestamp).toBe(ts);
  });

  test('per-container previous frames are independent', () => {
    const prevFrames = new Map();
    const frame1a = JSON.parse(makeStatsJson({ rxBytes: 1000, read: '2026-03-29T12:00:00.000000000Z' }));
    const frame1b = JSON.parse(makeStatsJson({ rxBytes: 5000, read: '2026-03-29T12:00:00.000000000Z' }));
    computeMetrics('c1', 'a', 'img', frame1a, prevFrames);
    computeMetrics('c2', 'b', 'img', frame1b, prevFrames);

    const frame2a = JSON.parse(makeStatsJson({ rxBytes: 3000, read: '2026-03-29T12:00:01.000000000Z' }));
    const frame2b = JSON.parse(makeStatsJson({ rxBytes: 9000, read: '2026-03-29T12:00:01.000000000Z' }));
    const resultA = computeMetrics('c1', 'a', 'img', frame2a, prevFrames);
    const resultB = computeMetrics('c2', 'b', 'img', frame2b, prevFrames);

    // c1: (3000-1000)/1 = 2000, c2: (9000-5000)/1 = 4000
    expect(resultA.networkRxBytesPerSec).toBe(2000);
    expect(resultB.networkRxBytesPerSec).toBe(4000);
  });
});

describe('handleStatsStream', () => {
  test('returns SSE response with correct headers and 200 status', () => {
    const mockDocker = { listContainers: mock(() => Promise.resolve([])) };
    const request = new Request('http://localhost/stats/stream');
    const response = handleStatsStream(mockDocker as any, request);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
  });

  test('streams flat computed stats as SSE events', async () => {
    const statsEmitter = new EventEmitter();

    const container = {
      Id: 'abc123def456',
      Names: ['/my-container'],
      Image: 'nginx:latest',
    };

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([container])),
      getContainer: mock(() => ({
        stats: mock(() => Promise.resolve(statsEmitter)),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 20));

    statsEmitter.emit('data', Buffer.from(makeStatsJson() + '\n'));

    const text = await readUntil(response, (s) => s.includes('"containerId"'));
    ac.abort();

    expect(text).toContain('data:');
    const parsed = parseStatsEvent(text);

    expect(parsed.containerId).toBe('abc123def456');
    expect(parsed.containerName).toBe('my-container');
    expect(parsed.image).toBe('nginx:latest');
    expect(typeof parsed.cpuPercent).toBe('number');
    expect(typeof parsed.memoryUsage).toBe('number');
    expect(typeof parsed.memoryLimit).toBe('number');
    expect(typeof parsed.memoryPercent).toBe('number');
    expect(typeof parsed.networkRxBytesPerSec).toBe('number');
    expect(typeof parsed.networkTxBytesPerSec).toBe('number');
    expect(typeof parsed.blockReadBytesPerSec).toBe('number');
    expect(typeof parsed.blockWriteBytesPerSec).toBe('number');
    expect(typeof parsed.timestamp).toBe('string');
    // Should NOT have nested stats object
    expect((parsed as any).stats).toBeUndefined();
  });

  test('closes stream and destroys Docker streams on abort', async () => {
    const statsEmitter = new EventEmitter();
    const destroySpy = mock(() => {});
    (statsEmitter as any).destroy = destroySpy;

    const container = {
      Id: 'abc123',
      Names: ['/test'],
      Image: 'test:latest',
    };

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([container])),
      getContainer: mock(() => ({
        stats: mock(() => Promise.resolve(statsEmitter)),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 20));

    statsEmitter.emit('data', Buffer.from(makeStatsJson() + '\n'));
    await new Promise((r) => setTimeout(r, 10));

    ac.abort();
    await new Promise((r) => setTimeout(r, 10));

    expect(destroySpy).toHaveBeenCalledTimes(1);

    const reader = response.body!.getReader();
    let done = false;
    const deadline = Date.now() + 3000;
    while (!done && Date.now() < deadline) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
  });

  test('emits error SSE event when listContainers throws', async () => {
    const mockDocker = {
      listContainers: mock(() => Promise.reject(new Error('Docker daemon unreachable'))),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request);

    const text = await readUntil(response, (s) => s.includes('event: error'));
    ac.abort();

    expect(text).toContain('event: error');
    expect(text).toContain('"error":"Docker daemon unreachable"');
  });

  test('emits container-error when stats stream fails for one container', async () => {
    const goodEmitter = new EventEmitter();
    const container1 = { Id: 'good111', Names: ['/good'], Image: 'redis:latest' };
    const container2 = { Id: 'bad222', Names: ['/bad'], Image: 'broken:latest' };

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([container1, container2])),
      getContainer: mock((id: string) => ({
        stats: mock(() => {
          if (id === 'bad222') return Promise.reject(new Error('stats unavailable'));
          return Promise.resolve(goodEmitter);
        }),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 20));

    goodEmitter.emit('data', Buffer.from(makeStatsJson() + '\n'));

    const text = await readUntil(response, (s) =>
      s.includes('container-error') && s.includes('"containerId":"good111"')
    );
    ac.abort();

    expect(text).toContain('"containerId":"good111"');
    expect(text).toContain('event: container-error');
    expect(text).toContain('"containerId":"bad222"');
    expect(text).toContain('"error":"stats unavailable"');
  });

  test('emits container-error SSE event when stats stream emits error', async () => {
    const statsEmitter = new EventEmitter();
    const container = { Id: 'err1', Names: ['/errtest'], Image: 'test:latest' };

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([container])),
      getContainer: mock(() => ({
        stats: mock(() => Promise.resolve(statsEmitter)),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 20));

    statsEmitter.emit('error', new Error('connection reset'));

    const text = await readUntil(response, (s) => s.includes('container-error'));
    ac.abort();

    expect(text).toContain('event: container-error');
    expect(text).toContain('"containerId":"err1"');
    expect(text).toContain('"error":"connection reset"');
  });

  test('cleans up container stream on end event', async () => {
    const statsEmitter = new EventEmitter();
    const destroySpy = mock(() => {});
    (statsEmitter as any).destroy = destroySpy;

    const container = { Id: 'end1', Names: ['/endtest'], Image: 'test:latest' };
    const mockDocker = {
      listContainers: mock(() => Promise.resolve([container])),
      getContainer: mock(() => ({
        stats: mock(() => Promise.resolve(statsEmitter)),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    handleStatsStream(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 20));

    // Emit end — the stream should be cleaned up
    statsEmitter.emit('end');
    await new Promise((r) => setTimeout(r, 10));

    // Now abort — destroy should NOT be called since stream already ended and was removed
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));

    expect(destroySpy).not.toHaveBeenCalled();
  });

  test('falls back to container ID when Names is empty', async () => {
    const statsEmitter = new EventEmitter();

    const container = {
      Id: 'noname123',
      Names: [],
      Image: 'test:latest',
    };

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([container])),
      getContainer: mock(() => ({
        stats: mock(() => Promise.resolve(statsEmitter)),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 20));

    statsEmitter.emit('data', Buffer.from(makeStatsJson() + '\n'));

    const text = await readUntil(response, (s) => s.includes('"containerId"'));
    ac.abort();

    const parsed = parseStatsEvent(text);
    expect(parsed.containerName).toBe('noname123');
  });

  test('skips malformed JSON frames without crashing', async () => {
    const statsEmitter = new EventEmitter();
    const container = { Id: 'json1', Names: ['/jsontest'], Image: 'test:latest' };

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([container])),
      getContainer: mock(() => ({
        stats: mock(() => Promise.resolve(statsEmitter)),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 20));

    // Send malformed JSON followed by valid JSON
    statsEmitter.emit('data', Buffer.from('not valid json\n' + makeStatsJson() + '\n'));

    const text = await readUntil(response, (s) => s.includes('"containerId"'));
    ac.abort();

    // The valid frame should still come through
    expect(text).toContain('"containerId":"json1"');
  });

  test('forwards multiple NDJSON frames from a single chunk', async () => {
    const statsEmitter = new EventEmitter();

    const container = { Id: 'multi1', Names: ['/multi'], Image: 'test:latest' };

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([container])),
      getContainer: mock(() => ({
        stats: mock(() => Promise.resolve(statsEmitter)),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 20));

    // Send two JSON frames in a single chunk
    const twoFrames = makeStatsJson() + '\n' + makeStatsJson() + '\n';
    statsEmitter.emit('data', Buffer.from(twoFrames));

    const text = await readUntil(response, (s) => {
      const matches = s.match(/data:/g);
      return (matches?.length ?? 0) >= 2;
    });
    ac.abort();

    const events = text.split('\n\n').filter(Boolean);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});

const fastOptions: StatsStreamOptions = { refreshIntervalMs: 0, pollIntervalMs: 10 };

describe('handleStatsStream — container refresh', () => {
  test('detects new containers and opens streams for them', async () => {
    const container1 = { Id: 'c1', Names: ['/first'], Image: 'a:latest' };
    const container2 = { Id: 'c2', Names: ['/second'], Image: 'b:latest' };
    const emitter1 = new EventEmitter();
    const emitter2 = new EventEmitter();

    let callCount = 0;
    const mockDocker = {
      listContainers: mock(() => {
        callCount++;
        // First call returns 1 container, second returns 2
        return Promise.resolve(callCount <= 1 ? [container1] : [container1, container2]);
      }),
      getContainer: mock((id: string) => ({
        stats: mock(() => Promise.resolve(id === 'c1' ? emitter1 : emitter2)),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request, fastOptions);

    // Wait for initial load + at least one refresh cycle
    await new Promise((r) => setTimeout(r, 80));

    // Emit data from the new container
    emitter2.emit('data', Buffer.from(makeStatsJson() + '\n'));

    const text = await readUntil(response, (s) =>
      s.includes('event: containers') && s.includes('"c2"')
    );
    ac.abort();

    expect(text).toContain('event: containers');
    expect(text).toContain('"c2"');
  });

  test('destroys streams for removed containers', async () => {
    const container1 = { Id: 'rm1', Names: ['/removeme'], Image: 'x:latest' };
    const emitter1 = new EventEmitter();
    const destroySpy = mock(() => {});
    (emitter1 as any).destroy = destroySpy;

    let callCount = 0;
    const mockDocker = {
      listContainers: mock(() => {
        callCount++;
        // First call returns container, second returns empty
        return Promise.resolve(callCount <= 1 ? [container1] : []);
      }),
      getContainer: mock(() => ({
        stats: mock(() => Promise.resolve(emitter1)),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request, fastOptions);

    // Wait for initial + refresh
    const text = await readUntil(response, (s) => s.includes('event: containers'), 2000);
    ac.abort();

    expect(destroySpy).toHaveBeenCalledTimes(1);
    expect(text).toContain('event: containers');
  });

  test('closes stream after max consecutive refresh failures (circuit breaker)', async () => {
    let callCount = 0;
    const mockDocker = {
      listContainers: mock(() => {
        callCount++;
        if (callCount <= 1) return Promise.resolve([]);
        return Promise.reject(new Error('daemon gone'));
      }),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request, {
      ...fastOptions,
      maxConsecutiveFailures: 3,
    });

    const text = await readUntil(response, (s) => s.includes('event: error'), 5000);
    ac.abort();

    expect(text).toContain('event: error');
    expect(text).toContain('Docker daemon unreachable, stream closed');
    // Should have 3 refresh_failed events before the final error
    const refreshFailures = (text.match(/refresh_failed/g) || []).length;
    expect(refreshFailures).toBe(3);
  });

  test('emits refresh_failed event on container list error during refresh', async () => {
    let callCount = 0;
    const mockDocker = {
      listContainers: mock(() => {
        callCount++;
        if (callCount <= 1) return Promise.resolve([]);
        return Promise.reject(new Error('Docker daemon down'));
      }),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request, fastOptions);

    const text = await readUntil(response, (s) => s.includes('refresh_failed'), 2000);
    ac.abort();

    expect(text).toContain('event: container-error');
    expect(text).toContain('"type":"refresh_failed"');
    expect(text).toContain('"error":"Docker daemon down"');
  });
});
