import { describe, it, expect, mock } from 'bun:test';
import { AgentSseStreamError, connectAgentSseStream } from '../agent-sse-stream';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Build a ReadableStream that emits SSE-formatted `data:` frames, then closes. */
function createMockSSEStream(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
  });
}

async function collect(gen: AsyncGenerator<unknown, void, void>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const frame of gen) out.push(frame);
  return out;
}

describe('connectAgentSseStream', () => {
  it('sends the bearer token from the signer and joins the path onto the agent URL', async () => {
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    await connectAgentSseStream({
      agentUrl: 'http://192.168.1.10:9090',
      path: '/stats/stream',
      signer: async () => 'test-token',
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const mockFn = fetchFn as unknown as { mock: { calls: unknown[][] } };
    const [url, init] = mockFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://192.168.1.10:9090/stats/stream');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-token');
    expect(init.redirect).toBe('manual');
  });

  it('normalizes a trailing slash on the agent URL via URL join', async () => {
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    await connectAgentSseStream({
      agentUrl: 'http://192.168.1.10:9090/',
      path: '/zfs/stats/stream',
      signer: async () => 'tok',
      signal: new AbortController().signal,
      fetchFn,
    });

    const mockFn = fetchFn as unknown as { mock: { calls: unknown[][] } };
    const [url] = mockFn.mock.calls[0] as [string];
    expect(url).toBe('http://192.168.1.10:9090/zfs/stats/stream');
  });

  it('falls back to naive concatenation when the agent URL fails to parse', async () => {
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream([]), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    await connectAgentSseStream({
      agentUrl: 'not-a-valid-url',
      path: '/containers/events',
      signer: async () => 'tok',
      signal: new AbortController().signal,
      fetchFn,
    });

    const mockFn = fetchFn as unknown as { mock: { calls: unknown[][] } };
    const [url] = mockFn.mock.calls[0] as [string];
    expect(url).toBe('not-a-valid-url/containers/events');
  });

  it('throws AgentSseStreamError on a non-ok response', async () => {
    const fetchFn: FetchFn = mock(async () => new Response('Unauthorized', { status: 401 }));

    await expect(
      connectAgentSseStream({
        agentUrl: 'http://host:9090',
        path: '/stats/stream',
        signer: async () => 'tok',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow('Agent returned 401');
  });

  it('throws AgentSseStreamError with the status code attached', async () => {
    const fetchFn: FetchFn = mock(async () => new Response('Service Unavailable', { status: 503 }));

    try {
      await connectAgentSseStream({
        agentUrl: 'http://host:9090',
        path: '/stats/stream',
        signer: async () => 'tok',
        signal: new AbortController().signal,
        fetchFn,
      });
      expect.unreachable('expected connectAgentSseStream to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(AgentSseStreamError);
      expect((err as AgentSseStreamError).statusCode).toBe(503);
    }
  });

  it('throws AgentSseStreamError when the response has no body', async () => {
    const fetchFn: FetchFn = mock(async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, 'body', { value: null });
      return response;
    });

    await expect(
      connectAgentSseStream({
        agentUrl: 'http://host:9090',
        path: '/stats/stream',
        signer: async () => 'tok',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow('Agent response has no body');
  });

  it('throws AgentSseStreamError when the agent URL returns an opaque redirect', async () => {
    const fetchFn: FetchFn = mock(async () => {
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
      return response;
    });

    await expect(
      connectAgentSseStream({
        agentUrl: 'http://host:9090',
        path: '/stats/stream',
        signer: async () => 'tok',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(/redirect/);
  });

  it('throws AgentSseStreamError when the agent URL returns a 3xx status', async () => {
    const fetchFn: FetchFn = mock(async () =>
      new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/metadata' } }),
    );

    await expect(
      connectAgentSseStream({
        agentUrl: 'http://host:9090',
        path: '/stats/stream',
        signer: async () => 'tok',
        signal: new AbortController().signal,
        fetchFn,
      }),
    ).rejects.toThrow(/redirect/);
  });

  it('yields the parsed JSON body of each data: frame', async () => {
    const events = [{ foo: 1 }, { foo: 2 }];
    const fetchFn: FetchFn = mock(async () =>
      new Response(createMockSSEStream(events), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const gen = await connectAgentSseStream({
      agentUrl: 'http://host:9090',
      path: '/stats/stream',
      signer: async () => 'tok',
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(await collect(gen)).toEqual(events);
  });

  it('reassembles a data: frame split across multiple chunks', async () => {
    const encoder = new TextEncoder();
    const part1 = `data: {"foo":"ba`;
    const part2 = `r"}\n\n`;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(part1));
        controller.enqueue(encoder.encode(part2));
        controller.close();
      },
    });
    const fetchFn: FetchFn = mock(async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const gen = await connectAgentSseStream({
      agentUrl: 'http://host:9090',
      path: '/stats/stream',
      signer: async () => 'tok',
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(await collect(gen)).toEqual([{ foo: 'bar' }]);
  });

  it('tolerates heartbeat comment frames (bare `:` lines) interleaved with data frames', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        controller.enqueue(encoder.encode(`data: {"foo":1}\n\n`));
        controller.enqueue(encoder.encode(`: heartbeat\n\n`));
        controller.close();
      },
    });
    const fetchFn: FetchFn = mock(async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const gen = await connectAgentSseStream({
      agentUrl: 'http://host:9090',
      path: '/stats/stream',
      signer: async () => 'tok',
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(await collect(gen)).toEqual([{ foo: 1 }]);
  });

  it('skips named SSE events (e.g. "event: containers") entirely', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`event: containers\ndata: {"ids":["abc123"]}\n\n`));
        controller.enqueue(encoder.encode(`data: {"foo":1}\n\n`));
        controller.close();
      },
    });
    const fetchFn: FetchFn = mock(async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const gen = await connectAgentSseStream({
      agentUrl: 'http://host:9090',
      path: '/stats/stream',
      signer: async () => 'tok',
      signal: new AbortController().signal,
      fetchFn,
    });

    expect(await collect(gen)).toEqual([{ foo: 1 }]);
  });

  it('drops malformed JSON frames and continues with the next valid one', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: {not valid json}\n\n`));
        controller.enqueue(encoder.encode(`data: {"foo":1}\n\n`));
        controller.close();
      },
    });
    const fetchFn: FetchFn = mock(async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const origError = console.error;
    console.error = () => {};
    try {
      const gen = await connectAgentSseStream({
        agentUrl: 'http://host:9090',
        path: '/stats/stream',
        signer: async () => 'tok',
        signal: new AbortController().signal,
        fetchFn,
      });

      expect(await collect(gen)).toEqual([{ foo: 1 }]);
    } finally {
      console.error = origError;
    }
  });

  it('stops yielding once the abort signal fires', async () => {
    const encoder = new TextEncoder();
    const abortController = new AbortController();
    let pullCount = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        pullCount++;
        if (pullCount <= 5) {
          controller.enqueue(encoder.encode(`data: {"n":${pullCount}}\n\n`));
          await new Promise((resolve) => setTimeout(resolve, 10));
        } else {
          controller.close();
        }
      },
    });
    const fetchFn: FetchFn = mock(async () =>
      new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } }),
    );

    const gen = await connectAgentSseStream({
      agentUrl: 'http://host:9090',
      path: '/stats/stream',
      signer: async () => 'tok',
      signal: abortController.signal,
      fetchFn,
    });

    setTimeout(() => abortController.abort(new DOMException('Shutdown', 'AbortError')), 15);

    const results = await collect(gen);
    expect(results.length).toBeGreaterThan(0);
    expect(results.length).toBeLessThan(5);
  });
});
