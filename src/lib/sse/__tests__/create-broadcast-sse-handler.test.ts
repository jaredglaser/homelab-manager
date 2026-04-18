import { describe, it, expect, mock } from 'bun:test';
import { createBroadcastSseHandler } from '../create-broadcast-sse-handler';

type Event = { n: number };

function setup(serialize: (e: Event) => string = (e) => `data: ${JSON.stringify(e)}\n\n`) {
  let captured: ((event: Event) => void) | null = null;
  const unsubscribe = mock(() => {});
  const subscribe = mock((cb: (event: Event) => void) => {
    captured = cb;
    return unsubscribe;
  });

  const handler = createBroadcastSseHandler<Event>({
    loadSubscribe: async () => subscribe,
    serialize,
  });

  return {
    handler,
    subscribe,
    unsubscribe,
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

describe('createBroadcastSseHandler', () => {
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
    const { handler, unsubscribe } = setup();
    const ac = new AbortController();

    await handler({ request: makeRequest(ac) });
    ac.abort();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('drops events emitted after abort without throwing', async () => {
    const { handler, emit } = setup();
    const ac = new AbortController();

    await handler({ request: makeRequest(ac) });
    ac.abort();

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

    reader.cancel();
  });
});
