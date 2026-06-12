import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { createStatsSseHandler } from '../create-stats-sse-handler';

mock.module('@/lib/auth/sse-auth', () => ({
  authenticateSSE: mock(async () => ({ id: 1, role: 'admin' })),
}));

mock.module('@/lib/server-init', () => ({}));

type SendData = (rows: unknown[]) => void;
type SendError = () => void;

const unsubscribe = mock(() => {});
const subscribeState: {
  sendData: SendData | null;
  sendError: SendError | null;
  impl: (() => void) | null;
} = { sendData: null, sendError: null, impl: null };

const subscribe = mock((_source: string, sendData: SendData, sendError: SendError) => {
  subscribeState.sendData = sendData;
  subscribeState.sendError = sendError;
  subscribeState.impl?.();
  return unsubscribe;
});

mock.module('@/lib/database/subscription-service', () => ({
  statsPollService: { subscribe },
}));

function makeRequest(ac: AbortController): Request {
  return new Request('http://localhost/', { signal: ac.signal });
}

function readerOf(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!res.body) throw new Error('Response had no body');
  return res.body.getReader();
}

describe('createStatsSseHandler', () => {
  beforeEach(() => {
    unsubscribe.mockClear();
    subscribe.mockClear();
    subscribeState.sendData = null;
    subscribeState.sendError = null;
    subscribeState.impl = null;
  });

  it('returns an SSE response with the standard headers', async () => {
    const handler = createStatsSseHandler('docker');
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Connection')).toBe('keep-alive');

    ac.abort();
  });

  it('subscribes with the configured source and streams rows after the flush comment', async () => {
    const handler = createStatsSseHandler('zfs');
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(': ok\n\n');
    expect(subscribe).toHaveBeenCalledWith('zfs', expect.any(Function), expect.any(Function));

    subscribeState.sendData?.([{ host: 'h1' }]);
    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe('data: [{"host":"h1"}]\n\n');

    ac.abort();
    reader.cancel();
  });

  it('emits a stats_error frame when the poll service reports an error', async () => {
    const handler = createStatsSseHandler('proxmox');
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    const decoder = new TextDecoder();
    await reader.read(); // flush comment

    subscribeState.sendError?.();
    const frame = await reader.read();
    expect(decoder.decode(frame.value)).toBe('event: stats_error\ndata: {}\n\n');

    ac.abort();
    reader.cancel();
  });

  it('emits stats_error and closes the stream when subscribe throws', async () => {
    subscribeState.impl = () => {
      throw new Error('db offline');
    };
    const handler = createStatsSseHandler('docker');
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    const decoder = new TextDecoder();

    let body = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value);
    }

    expect(body).toContain(': ok\n\n');
    expect(body).toContain('event: stats_error\ndata: {}\n\n');

    ac.abort();
  });

  it('unsubscribes when the request aborts and drops later rows', async () => {
    const handler = createStatsSseHandler('docker');
    const ac = new AbortController();

    await handler({ request: makeRequest(ac) });
    ac.abort();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(() => subscribeState.sendData?.([{ host: 'late' }])).not.toThrow();
  });

  it('emits periodic comment pings on the heartbeat interval', async () => {
    const handler = createStatsSseHandler('docker', { heartbeatIntervalMs: 5 });
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(': ok\n\n');

    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe(': ping\n\n');

    ac.abort();
    reader.cancel();
  });

  it('tears down when the heartbeat ping hits a dead consumer', async () => {
    const handler = createStatsSseHandler('docker', { heartbeatIntervalMs: 5 });
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    await reader.read(); // flush comment

    // Cancelling the reader closes the controller without firing abort, so
    // the next ping's enqueue throws and must trigger teardown.
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 30));

    expect(unsubscribe).toHaveBeenCalledTimes(1);

    ac.abort();
  });

  it('returns 401 when authenticateSSE returns null', async () => {
    const { authenticateSSE } = require('@/lib/auth/sse-auth') as { authenticateSSE: ReturnType<typeof mock> };
    authenticateSSE.mockImplementationOnce(async () => null);

    const handler = createStatsSseHandler('docker');
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });

    expect(res.status).toBe(401);
    expect(subscribe).not.toHaveBeenCalled();
    ac.abort();
  });
});
