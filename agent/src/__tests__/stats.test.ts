import { describe, expect, test, mock } from 'bun:test';
import { handleStatsStream } from '../routes/stats';

// Minimal Docker stats payload — enough for RateCalculator to produce rates
function makeStats(seed: number) {
  return {
    cpu_stats: {
      cpu_usage: { total_usage: seed * 1_000_000 },
      system_cpu_usage: seed * 10_000_000,
      online_cpus: 2,
    },
    memory_stats: { usage: 256 * 1024 * 1024, limit: 1024 * 1024 * 1024 },
    networks: { eth0: { rx_bytes: seed * 1000, tx_bytes: seed * 500 } },
    blkio_stats: {
      io_service_bytes_recursive: [
        { op: 'read', value: seed * 4096 },
        { op: 'write', value: seed * 2048 },
      ],
    },
  };
}

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

  test('streams container stats in SSE format after two polling cycles', async () => {
    const container = {
      Id: 'abc123def456',
      Names: ['/my-container'],
      Image: 'nginx:latest',
    };

    let statsCallCount = 0;
    const mockContainerObj = {
      stats: mock(async () => {
        statsCallCount++;
        return makeStats(statsCallCount);
      }),
    };

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([container])),
      getContainer: mock(() => mockContainerObj),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request, 10);

    // Read until we get at least one data event, then abort
    const text = await readUntil(response, (s) => s.includes('"containerId"'));
    ac.abort();

    expect(text).toContain('data:');
    expect(text).toContain('"containerId":"abc123def456"');
    expect(text).toContain('"containerName":"my-container"');
    expect(text).toContain('"image":"nginx:latest"');

    // Verify well-formed SSE: each event ends with double newline
    const events = text.split('\n\n').filter(Boolean);
    expect(events.length).toBeGreaterThanOrEqual(1);
    for (const event of events) {
      expect(event.trimStart()).toMatch(/^data:/);
    }

    // Verify the JSON payload has the expected rate fields
    const firstLine = events[0].replace(/^data:\s*/, '');
    const parsed = JSON.parse(firstLine);
    expect(typeof parsed.cpuPercent).toBe('number');
    expect(typeof parsed.memoryUsage).toBe('number');
    expect(typeof parsed.memoryLimit).toBe('number');
    expect(typeof parsed.memoryPercent).toBe('number');
    expect(typeof parsed.networkRxBytesPerSec).toBe('number');
    expect(typeof parsed.networkTxBytesPerSec).toBe('number');
    expect(typeof parsed.blockReadBytesPerSec).toBe('number');
    expect(typeof parsed.blockWriteBytesPerSec).toBe('number');
    expect(typeof parsed.timestamp).toBe('string');
  });

  test('closes stream cleanly when request is aborted', async () => {
    const ac = new AbortController();

    let pollCount = 0;
    const mockDocker = {
      listContainers: mock(async () => {
        pollCount++;
        // Abort after first poll so the stream terminates
        if (pollCount >= 1) {
          ac.abort();
        }
        return [];
      }),
    };

    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request, 10);

    const reader = response.body!.getReader();
    // Drain until done (stream should close after abort)
    let done = false;
    const deadline = Date.now() + 3000;
    while (!done && Date.now() < deadline) {
      const result = await reader.read();
      done = result.done;
    }

    expect(done).toBe(true);
  });

  test('emits error SSE event when listContainers throws', async () => {
    const ac = new AbortController();
    let callCount = 0;

    const mockDocker = {
      listContainers: mock(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Docker daemon unreachable');
        }
        // Abort on second call so the loop terminates
        ac.abort();
        return [];
      }),
    };

    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request, 10);

    const text = await readUntil(
      response,
      (s) => s.includes('event: error'),
    );
    ac.abort();

    expect(text).toContain('event: error');
    expect(text).toContain('"error":"Docker daemon unreachable"');
  });

  test('skips rejected container stats and emits data for successful ones', async () => {
    const goodContainer = {
      Id: 'good111',
      Names: ['/good-container'],
      Image: 'redis:latest',
    };
    const badContainer = {
      Id: 'bad222',
      Names: ['/bad-container'],
      Image: 'broken:latest',
    };

    let statsCallCount = 0;
    const mockDocker = {
      listContainers: mock(() => Promise.resolve([goodContainer, badContainer])),
      getContainer: mock((id: string) => ({
        stats: mock(async () => {
          if (id === 'bad222') {
            throw new Error('stats unavailable');
          }
          statsCallCount++;
          return makeStats(statsCallCount);
        }),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stats/stream', { signal: ac.signal });
    const response = handleStatsStream(mockDocker as any, request, 10);

    // Wait until we see data for the good container
    const text = await readUntil(response, (s) => s.includes('"good111"'));
    ac.abort();

    // Should have data for the good container
    expect(text).toContain('"containerId":"good111"');
    // Should NOT have data for the bad container
    expect(text).not.toContain('"containerId":"bad222"');
    // No top-level error event (the per-container failure is swallowed by Promise.allSettled)
    expect(text).not.toContain('event: error');
  });
});
