import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { createStatsSseHandler } from '../create-stats-sse-handler';

mock.module('@/lib/auth/sse-auth', () => ({
  authenticateSSE: mock(async () => ({ id: 1, role: 'admin' })),
}));

// Real server-init runs deploy recovery and DB shutdown hooks on import;
// this handler only needs the dynamic import to resolve to a no-op.
mock.module('@/lib/server-init', () => ({}));

type StatsCallback = (rows: unknown[]) => void;
type StatsErrorCallback = () => void;

function setupStatsPollService() {
  let capturedSendData: StatsCallback | null = null;
  let capturedSendError: StatsErrorCallback | null = null;
  const unsubscribe = mock(() => {});
  const subscribe = mock((_source: string, sendData: StatsCallback, sendError?: StatsErrorCallback) => {
    capturedSendData = sendData;
    capturedSendError = sendError ?? null;
    return unsubscribe;
  });

  mock.module('@/lib/database/subscription-service', () => ({
    statsPollService: { subscribe },
  }));

  return {
    subscribe,
    unsubscribe,
    sendRows: (rows: unknown[]) => capturedSendData?.(rows),
    sendError: () => capturedSendError?.(),
  };
}

function makeRequest(ac: AbortController): Request {
  return new Request('http://localhost/', { signal: ac.signal });
}

function readerOf(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!res.body) throw new Error('Response had no body');
  return res.body.getReader();
}

async function readFrame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  if (done) return '';
  return new TextDecoder().decode(value);
}

/** Matches the macrotask flush used in create-sse-stream.test.ts: onStart's
 * subscribe() call needs to resolve (and register cleanup) before an abort
 * assertion can rely on it having happened. */
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createStatsSseHandler', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns 401 when authenticateSSE returns null', async () => {
    const { authenticateSSE } = require('@/lib/auth/sse-auth') as { authenticateSSE: ReturnType<typeof mock> };
    authenticateSSE.mockImplementationOnce(async () => null);

    const handler = createStatsSseHandler('docker');
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });

    expect(res.status).toBe(401);
    ac.abort();
  });

  it('subscribes to the given source and forwards rows as a data frame', async () => {
    const { sendRows } = setupStatsPollService();
    const handler = createStatsSseHandler('docker');
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    expect(await readFrame(reader)).toBe(': ok\n\n');

    sendRows([{ host: 'h1', time: '2026-01-01T00:00:00Z' }]);
    expect(await readFrame(reader)).toBe('data: [{"host":"h1","time":"2026-01-01T00:00:00Z"}]\n\n');

    ac.abort();
    reader.cancel();
  });

  it('subscribes with the exact source string for each stats endpoint', async () => {
    const { subscribe } = setupStatsPollService();
    for (const source of ['docker', 'zfs', 'proxmox'] as const) {
      const handler = createStatsSseHandler(source);
      const ac = new AbortController();
      await handler({ request: makeRequest(ac) });
      ac.abort();
    }

    expect(subscribe.mock.calls.map((call) => call[0])).toEqual(['docker', 'zfs', 'proxmox']);
  });

  it('forwards the poll error callback as an "event: stats_error" frame with an empty payload', async () => {
    const { sendError } = setupStatsPollService();
    const handler = createStatsSseHandler('zfs');
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    await readFrame(reader); // ": ok\n\n"

    sendError();
    expect(await readFrame(reader)).toBe('event: stats_error\ndata: {}\n\n');

    ac.abort();
    reader.cancel();
  });

  it('unsubscribes from the poll service when the request aborts', async () => {
    const { unsubscribe } = setupStatsPollService();
    const handler = createStatsSseHandler('docker');
    const ac = new AbortController();

    await handler({ request: makeRequest(ac) });
    await flushMicrotasks();
    ac.abort();
    await flushMicrotasks();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('emits the same stats_error frame and ends the stream when subscribe() throws synchronously', async () => {
    const subscribe = mock(() => {
      throw new Error('poll service unavailable');
    });
    mock.module('@/lib/database/subscription-service', () => ({
      statsPollService: { subscribe },
    }));

    const handler = createStatsSseHandler('docker');
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);

    const decoder = new TextDecoder();
    let body = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value);
    }

    expect(body).toBe(': ok\n\nevent: stats_error\ndata: {}\n\n');

    ac.abort();
  });

  it('carries the shared heartbeat cadence: a comment frame follows the initial flush on an idle stream', async () => {
    const setSpy = spyOn(globalThis, 'setInterval');
    setupStatsPollService();
    const handler = createStatsSseHandler('docker');
    const ac = new AbortController();

    await handler({ request: makeRequest(ac) });

    // StatsPollService only calls sendData when new rows exist, so before
    // this handler routed through the shared primitive, an idle stream
    // (worker down, no new rows) emitted nothing after ": ok\n\n" and hit
    // the idle-timeout reconnect churn #323 was written to stop.
    expect(setSpy).toHaveBeenCalledWith(expect.any(Function), 5000);

    setSpy.mockRestore();
    ac.abort();
  });
});
