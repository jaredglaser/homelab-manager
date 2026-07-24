import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { createSseStream, isCloseRelatedError, type SseEmitter } from '../sse-stream';

interface IntervalHandle {
  cb: () => void;
  ms: number;
  cleared: boolean;
}

/** Replaces setInterval/clearInterval so the heartbeat is a callback tests can fire deterministically. */
function createIntervalHarness() {
  const intervals: IntervalHandle[] = [];
  const setSpy = spyOn(globalThis, 'setInterval').mockImplementation(((cb: () => void, ms: number) => {
    const handle: IntervalHandle = { cb, ms, cleared: false };
    intervals.push(handle);
    return handle as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  const clearSpy = spyOn(globalThis, 'clearInterval').mockImplementation(((h: unknown) => {
    const handle = h as IntervalHandle;
    if (handle) handle.cleared = true;
  }) as typeof clearInterval);
  return {
    intervals,
    restore() {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    },
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


async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value);
  }
  return out;
}

/** Sets up a stream whose onStart hands the test direct access to `emit`/`signal`. */
function setup(opts: { heartbeatMs?: number; cleanup?: () => void } = {}) {
  let capturedEmit: SseEmitter | null = null;
  let capturedSignal: AbortSignal | null = null;
  const cleanup = opts.cleanup ?? mock(() => {});

  const ac = new AbortController();
  const res = createSseStream(makeRequest(ac), {
    heartbeatMs: opts.heartbeatMs,
    onStart: (emit, signal) => {
      capturedEmit = emit;
      capturedSignal = signal;
      return cleanup;
    },
  });

  return {
    res,
    ac,
    cleanup,
    getEmit: () => capturedEmit!,
    getSignal: () => capturedSignal!,
  };
}

describe('createSseStream', () => {
  let harness: ReturnType<typeof createIntervalHarness>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    harness = createIntervalHarness();
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
    harness.restore();
  });

  it('returns the standard SSE response headers', () => {
    const { res, ac } = setup();

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Connection')).toBe('keep-alive');

    ac.abort();
  });

  it('flushes ": ok\\n\\n" as the first frame', async () => {
    const { res, ac } = setup();
    const reader = readerOf(res);

    expect(await readFrame(reader)).toBe(': ok\n\n');

    ac.abort();
    reader.cancel();
  });

  it('arms exactly one heartbeat timer at the default 5000ms cadence', () => {
    const { ac } = setup();

    expect(harness.intervals).toHaveLength(1);
    expect(harness.intervals[0].ms).toBe(5000);

    ac.abort();
  });

  it('respects a caller-supplied heartbeatMs', () => {
    const { ac } = setup({ heartbeatMs: 1234 });

    expect(harness.intervals[0].ms).toBe(1234);

    ac.abort();
  });

  it('writes a bare ":\\n\\n" comment on each heartbeat tick', async () => {
    const { res, ac } = setup();
    const reader = readerOf(res);
    await readFrame(reader); // ": ok\n\n"

    harness.intervals[0].cb();
    expect(await readFrame(reader)).toBe(':\n\n');

    harness.intervals[0].cb();
    expect(await readFrame(reader)).toBe(':\n\n');

    ac.abort();
    reader.cancel();
  });

  it('clears the heartbeat timer on abort so no further ticks are written', async () => {
    const { ac } = setup();

    ac.abort();

    expect(harness.intervals[0].cleared).toBe(true);
  });

  it('emit.data writes a "data: <JSON>\\n\\n" frame', async () => {
    const { res, ac, getEmit } = setup();
    const reader = readerOf(res);
    await readFrame(reader); // flush comment

    getEmit().data({ n: 1 });
    expect(await readFrame(reader)).toBe('data: {"n":1}\n\n');

    ac.abort();
    reader.cancel();
  });

  it('emit.event writes an "event: <name>\\ndata: <JSON>\\n\\n" frame', async () => {
    const { res, ac, getEmit } = setup();
    const reader = readerOf(res);
    await readFrame(reader);

    getEmit().event('stats_error', { message: 'db down' });
    expect(await readFrame(reader)).toBe('event: stats_error\ndata: {"message":"db down"}\n\n');

    ac.abort();
    reader.cancel();
  });

  it('emit.raw writes a pre-formatted string frame verbatim', async () => {
    const { res, ac, getEmit } = setup();
    const reader = readerOf(res);
    await readFrame(reader);

    getEmit().raw('event: custom\ndata: 42\n\n');
    expect(await readFrame(reader)).toBe('event: custom\ndata: 42\n\n');

    ac.abort();
    reader.cancel();
  });

  it('emit.raw writes bytes verbatim without re-encoding', async () => {
    const { res, ac, getEmit } = setup();
    const reader = readerOf(res);
    await readFrame(reader);

    const bytes = new TextEncoder().encode('data: raw-bytes\n\n');
    getEmit().raw(bytes);
    const frame = await reader.read();
    expect(new TextDecoder().decode(frame.value)).toBe('data: raw-bytes\n\n');

    ac.abort();
    reader.cancel();
  });

  it('runs the onStart-returned cleanup exactly once on abort', async () => {
    let markCleanup = () => {};
    const cleanupDone = new Promise<void>((resolve) => { markCleanup = resolve; });
    const cleanup = mock(() => markCleanup());
    const { ac } = setup({ cleanup });

    ac.abort();
    ac.abort(); // idempotent; guards the assertion anyway
    await cleanupDone;

    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('runs cleanup once even when onStart resolves after the abort already tore the stream down', async () => {
    let markCleanup = () => {};
    const cleanupDone = new Promise<void>((resolve) => { markCleanup = resolve; });
    const cleanup = mock(() => markCleanup());
    const ac = new AbortController();
    let releaseOnStart: (() => void) | null = null;

    const res = createSseStream(makeRequest(ac), {
      onStart: async () => {
        // Simulates slow setup that hasn't returned its cleanup by the time the client disconnects.
        await new Promise<void>((resolve) => {
          releaseOnStart = resolve;
        });
        return cleanup;
      },
    });
    const reader = readerOf(res);
    await readFrame(reader); // ": ok\n\n"

    ac.abort();
    expect(cleanup).not.toHaveBeenCalled();

    releaseOnStart!();
    await cleanupDone;

    expect(cleanup).toHaveBeenCalledTimes(1);

    reader.cancel();
  });

  it('emit.close() ends the stream immediately: clears the heartbeat and runs cleanup', async () => {
    const cleanup = mock(() => {});
    const { res, ac, getEmit } = setup({ cleanup });
    const reader = readerOf(res);
    await readFrame(reader);

    getEmit().close();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(harness.intervals[0].cleared).toBe(true);

    const { done } = await reader.read();
    expect(done).toBe(true);

    ac.abort();
  });

  it('drops writes issued after teardown without throwing', async () => {
    const { ac, getEmit } = setup();
    ac.abort();

    expect(() => getEmit().data({ n: 1 })).not.toThrow();
  });

  it('classifies a close-related write failure without logging, but still tears down', async () => {
    const cleanup = mock(() => {});
    const { res, ac, getEmit } = setup({ cleanup });
    const reader = readerOf(res);
    await readFrame(reader);

    // Serialization throws a close-shaped TypeError, exercising write()'s isCloseRelatedError branch.
    const payload = {
      toJSON() {
        throw new TypeError('The stream is closed');
      },
    };

    getEmit().data(payload);

    expect(errorSpy).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);

    ac.abort();
    reader.cancel();
  });

  it('isCloseRelatedError classifies TypeErrors mentioning "closed" and nothing else', () => {
    expect(isCloseRelatedError(new TypeError('The stream is closed'))).toBe(true);
    expect(isCloseRelatedError(new TypeError('Invalid state: Controller is already closed'))).toBe(true);
    expect(isCloseRelatedError(new TypeError('something unrelated'))).toBe(false);
    expect(isCloseRelatedError(new Error('closed'))).toBe(false);
    expect(isCloseRelatedError('not an error')).toBe(false);
  });

  it('logs and tears down on an unexpected (non-close) write failure', async () => {
    const cleanup = mock(() => {});
    const { res, ac, getEmit } = setup({ cleanup });
    const reader = readerOf(res);
    await readFrame(reader);

    const circular: Record<string, unknown> = {};
    circular.self = circular;

    getEmit().data(circular);

    expect(errorSpy).toHaveBeenCalledWith('Unexpected error during SSE enqueue:', expect.any(Error));
    expect(cleanup).toHaveBeenCalledTimes(1);

    ac.abort();
    reader.cancel();
  });

  it('logs but does not crash the stream when onStart itself rejects', async () => {
    const ac = new AbortController();
    const res = createSseStream(makeRequest(ac), {
      onStart: async () => {
        throw new Error('setup failed');
      },
    });
    const reader = readerOf(res);

    const body = await readAll(reader);

    expect(body).toBe(': ok\n\n');
    expect(errorSpy).toHaveBeenCalledWith('Unexpected error in SSE onStart handler:', expect.any(Error));
  });
});
