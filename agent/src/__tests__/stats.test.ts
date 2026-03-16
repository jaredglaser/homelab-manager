import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import { handleStatsStream, type StatsStreamOptions } from '../routes/stats';

beforeAll(() => {
  console.error = mock(() => {});
});

// Read chunks from the stream until predicate is satisfied or timeout
async function readUntil(
  response: Response,
  predicate: (accumulated: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      if (Date.now() > deadline) break;
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) break;
    }
  } finally {
    reader.cancel();
  }
  return text;
}

function makeStatsJson() {
  return JSON.stringify({
    cpu_stats: { cpu_usage: { total_usage: 1000 }, system_cpu_usage: 10000, online_cpus: 2 },
    memory_stats: { usage: 256 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
    networks: { eth0: { rx_bytes: 1000, tx_bytes: 500 } },
  });
}

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

  test('streams raw Docker stats frames as SSE events', async () => {
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
    const eventData = text.split('\n\n').filter(Boolean)[0];
    const parsed = JSON.parse(eventData.replace(/^data:\s*/, ''));

    expect(parsed.containerId).toBe('abc123def456');
    expect(parsed.containerName).toBe('my-container');
    expect(parsed.image).toBe('nginx:latest');
    expect(parsed.stats.cpu_stats).toBeDefined();
    expect(parsed.stats.memory_stats).toBeDefined();
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
      s.includes('"good111"') && s.includes('container-error')
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

    const eventData = text.split('\n\n').filter(Boolean)[0];
    const parsed = JSON.parse(eventData.replace(/^data:\s*/, ''));
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
