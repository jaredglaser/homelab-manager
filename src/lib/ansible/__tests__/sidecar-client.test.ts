import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
import { SidecarClient, SidecarError, readSseData } from '@/lib/ansible/sidecar-client';

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const out: string[] = [];
  for await (const data of readSseData(stream)) out.push(data);
  return out;
}

function client(fetchFn: typeof fetch): SidecarClient {
  return new SidecarClient({ sidecarUrl: 'http://sidecar:9095/', sidecarToken: 'tok', fetchFn });
}

describe('readSseData', () => {
  it('yields one payload per frame, including frames split across chunks', async () => {
    expect(await collect(sseStream(['data: {"a":1}\n\nda', 'ta: {"a":2}\n\n']))).toEqual([
      '{"a":1}',
      '{"a":2}',
    ]);
  });

  it('joins multi-line data and skips comments and empty frames', async () => {
    expect(await collect(sseStream([': ping\n\ndata: one\ndata: two\n\n\n\n']))).toEqual([
      'one\ntwo',
    ]);
  });

  it('stops at the end frame and ignores anything after it', async () => {
    expect(await collect(sseStream(['data: a\n\nevent: end\ndata: {}\n\ndata: b\n\n']))).toEqual([
      'a',
    ]);
  });
});

describe('SidecarClient', () => {
  afterEach(() => {
    mock.restore();
  });

  it('posts a run to the trailing-slash-stripped base URL with a bearer token', async () => {
    const fetchFn = mock(async () => new Response(JSON.stringify({ runId: 'r1' }), { status: 202 }));
    await client(fetchFn as unknown as typeof fetch).startRun({
      runId: 'r1',
      playbook: 'host_baseline.yml',
      hosts: ['host-a'],
      check: true,
      extravars: { hlm_baseline_secret: 'shh' },
    });

    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://sidecar:9095/runs');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(JSON.parse(init.body as string).check).toBe(true);
  });

  it('surfaces a 409 as a SidecarError carrying the busy hosts', async () => {
    const fetchFn = mock(
      async () =>
        new Response(JSON.stringify({ error: 'hosts already running: host-a', hosts: ['host-a', 7] }), {
          status: 409,
        }),
    );

    const promise = client(fetchFn as unknown as typeof fetch).startRun({
      runId: 'r1',
      playbook: 'host_baseline.yml',
      hosts: ['host-a'],
      check: false,
      extravars: {},
    });

    const error = await promise.then(() => null, (err: unknown) => err);
    expect(error).toBeInstanceOf(SidecarError);
    expect((error as SidecarError).statusCode).toBe(409);
    expect((error as SidecarError).busyHosts).toEqual(['host-a']);
  });

  it('falls back to the status code when the error body is not JSON', async () => {
    const fetchFn = mock(async () => new Response('boom', { status: 500 }));
    const error = await client(fetchFn as unknown as typeof fetch)
      .cancelRun('r1')
      .then(() => null, (err: unknown) => err as SidecarError);

    expect(error?.message).toBe('sidecar returned 500');
    expect(error?.busyHosts).toBeUndefined();
  });

  it('cancels a run by id', async () => {
    const fetchFn = mock(async () => new Response(JSON.stringify({ cancelled: true }), { status: 202 }));
    await client(fetchFn as unknown as typeof fetch).cancelRun('r 1');
    const [url] = fetchFn.mock.calls[0] as unknown as [string];
    expect(url).toBe('http://sidecar:9095/runs/r%201/cancel');
  });

  it('streams parsed events and logs past an unparseable frame', async () => {
    const consoleError = spyOn(console, 'error').mockImplementation(() => {});
    const fetchFn = mock(
      async () => new Response(sseStream(['data: {"event":"a"}\n\ndata: not-json\n\ndata: {"event":"b"}\n\n']), { status: 200 }),
    );

    const events: unknown[] = [];
    for await (const event of client(fetchFn as unknown as typeof fetch).streamEvents('r1')) {
      events.push(event);
    }

    expect(events).toEqual([{ event: 'a' }, { event: 'b' }]);
    expect(consoleError).toHaveBeenCalled();
  });

  it('rejects a non-ok or bodyless event stream', async () => {
    const failing = mock(async () => new Response(JSON.stringify({ error: 'unknown run' }), { status: 404 }));
    const iterate = async (fetchFn: typeof fetch) => {
      for await (const _ of client(fetchFn).streamEvents('r1')) break;
    };

    await expect(iterate(failing as unknown as typeof fetch)).rejects.toThrow('unknown run');

    const bodyless = mock(async () => new Response(null, { status: 204 }));
    await expect(iterate(bodyless as unknown as typeof fetch)).rejects.toThrow('no body');
  });
});
