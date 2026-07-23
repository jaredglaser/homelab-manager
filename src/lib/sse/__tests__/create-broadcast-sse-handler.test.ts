import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { createBroadcastSseHandler } from '../create-broadcast-sse-handler';

mock.module('@/lib/auth/sse-auth', () => ({
  authenticateSSE: mock(async () => ({ id: 1, role: 'admin' })),
}));

type Event = { n: number };

function setup(serialize: (e: Event) => string = (e) => `data: ${JSON.stringify(e)}\n\n`) {
  let captured: ((event: Event) => void) | null = null;
  let markSubscribed = () => {};
  let markUnsubscribed = () => {};
  // createSseStream runs onStart (loadSubscribe + subscribe) inside the stream's async
  // start(), so tests wait on these instead of a timer to know when the subscription is
  // live and when abort teardown has called unsubscribe.
  const subscribed = new Promise<void>((resolve) => { markSubscribed = resolve; });
  const unsubscribed = new Promise<void>((resolve) => { markUnsubscribed = resolve; });
  const unsubscribe = mock(() => markUnsubscribed());
  const subscribe = mock((cb: (event: Event) => void) => {
    captured = cb;
    markSubscribed();
    return unsubscribe;
  });

  const handler = createBroadcastSseHandler<Event>({
    loadSubscribe: async () => subscribe,
    serialize,
    errorEvent: 'test_error',
  });

  return {
    handler,
    subscribe,
    unsubscribe,
    subscribed,
    unsubscribed,
    emit: (e: Event) => captured?.(e),
  };
}

function makeRequest(ac: AbortController): Request {
  return new Request('http://localhost/', { signal: ac.signal });
}

function readerOf(res: Response): ReadableStreamDefaultReader<Uint8Array> {
  if (!res.body) throw new Error('Response had no body');
  return res.body.getReader();
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

describe('createBroadcastSseHandler', () => {
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('returns an SSE response with the standard headers', async () => {
    const { handler } = setup();
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Connection')).toBe('keep-alive');

    ac.abort();
  });

  it('emits the heartbeat before any subscribed event', async () => {
    const { handler, emit } = setup();
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    const decoder = new TextDecoder();

    const first = await reader.read();
    expect(decoder.decode(first.value)).toBe(': ok\n\n');

    emit({ n: 1 });
    const second = await reader.read();
    expect(decoder.decode(second.value)).toBe('data: {"n":1}\n\n');

    ac.abort();
    reader.cancel();
  });

  it('emits comment heartbeats on the shared 5s cadence to keep idle streams warm', async () => {
    let heartbeatFn: (() => void) | null = null;
    const intervalSpy = spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void, ms: number) => {
      heartbeatFn = fn;
      expect(ms).toBe(5000); // the cadence now comes only from createSseStream's default
      return 123 as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    try {
      const { handler } = setup();
      const ac = new AbortController();

      const res = await handler({ request: makeRequest(ac) });
      const reader = readerOf(res);
      const decoder = new TextDecoder();
      await reader.read(); // : ok

      expect(heartbeatFn).not.toBeNull();
      heartbeatFn!();
      const frame = await reader.read();
      expect(decoder.decode(frame.value)).toBe(':\n\n');

      ac.abort();
      // Aborting tears down the stream, which must stop the heartbeat timer.
      expect(clearSpy).toHaveBeenCalledWith(123);

      reader.cancel();
    } finally {
      intervalSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it('uses the caller-provided serializer verbatim', async () => {
    const serialize = mock((e: Event) => `event: custom\ndata: ${e.n}\n\n`);
    const { handler, emit } = setup(serialize);
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    const decoder = new TextDecoder();
    await reader.read(); // heartbeat

    emit({ n: 42 });
    const frame = await reader.read();

    expect(serialize).toHaveBeenCalledWith({ n: 42 });
    expect(decoder.decode(frame.value)).toBe('event: custom\ndata: 42\n\n');

    ac.abort();
    reader.cancel();
  });

  it('unsubscribes when the request aborts', async () => {
    const { handler, unsubscribe, subscribed, unsubscribed } = setup();
    const ac = new AbortController();

    await handler({ request: makeRequest(ac) });
    await subscribed;
    ac.abort();
    await unsubscribed;

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('drops events emitted after abort without throwing', async () => {
    const { handler, emit, subscribed, unsubscribed } = setup();
    const ac = new AbortController();

    await handler({ request: makeRequest(ac) });
    await subscribed;
    ac.abort();
    await unsubscribed;

    expect(() => emit({ n: 99 })).not.toThrow();
  });

  it('tears down when the serializer throws', async () => {
    const throwing = () => { throw new Error('boom'); };
    const { handler, emit, unsubscribe } = setup(throwing);
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    await reader.read(); // heartbeat

    emit({ n: 1 });

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(() => emit({ n: 2 })).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();

    reader.cancel();
  });

  it('emits the caller-provided error event when loadSubscribe rejects, then closes', async () => {
    const handler = createBroadcastSseHandler<Event>({
      loadSubscribe: async () => {
        throw new Error('db offline');
      },
      serialize: (e) => `data: ${JSON.stringify(e)}\n\n`,
      errorEvent: 'inventory_error',
    });
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    const body = await readAll(reader);

    expect(body).toContain(': ok\n\n');
    expect(body).toContain('event: inventory_error\n');
    expect(body).toContain('data: {"message":"db offline"}\n\n');
    expect(errorSpy).toHaveBeenCalled();

    ac.abort();
  });

  it('logs and tears down on unexpected (non-close) enqueue errors', async () => {
    const unrelated = () => { throw new TypeError('something unrelated'); };
    const { handler, emit, unsubscribe } = setup(unrelated);
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    await reader.read(); // heartbeat

    emit({ n: 1 });

    expect(errorSpy).toHaveBeenCalledWith(
      'Unexpected error during SSE enqueue:',
      expect.any(TypeError),
    );
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    reader.cancel();
    ac.abort();
  });

  it('silently swallows close-related TypeErrors from enqueue', async () => {
    const closeTypeError = () => {
      throw new TypeError('The stream is closed');
    };
    const { handler, emit, unsubscribe } = setup(closeTypeError);
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });
    const reader = readerOf(res);
    await reader.read(); // heartbeat

    emit({ n: 1 });

    expect(errorSpy).not.toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledTimes(1);

    reader.cancel();
    ac.abort();
  });

  it('returns 401 when authenticateSSE returns null', async () => {
    const { authenticateSSE } = require('@/lib/auth/sse-auth') as { authenticateSSE: ReturnType<typeof mock> };
    authenticateSSE.mockImplementationOnce(async () => null);

    const { handler } = setup();
    const ac = new AbortController();

    const res = await handler({ request: makeRequest(ac) });

    expect(res.status).toBe(401);
    ac.abort();
  });
});
