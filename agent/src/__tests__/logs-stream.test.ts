import { describe, expect, test, mock, beforeAll, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import { handleFleetLogStream, makeBucket, tryConsume } from '../routes/logs-stream';
import { splitTimestamp } from '../lib/log-parse';
import { readUntil, parseDataFrames } from '../lib/test/sse-test-utils';

beforeAll(() => {
  console.error = mock(() => {});
});

const TS = '2026-03-29T12:00:00.000000000Z';

function withTs(text: string, ts = TS): string {
  return `${ts} ${text}`;
}

function muxedFrame(streamType: 1 | 2, text: string): Buffer {
  const body = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

function makeReadable(): EventEmitter & { destroy: ReturnType<typeof mock> } {
  const emitter = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof mock> };
  emitter.destroy = mock(() => {});
  return emitter;
}

/** Resolves once the route registers its `data` listener on the readable, so a test can emit safely. */
function onceAttached(emitter: EventEmitter): Promise<void> {
  return new Promise((resolve) => {
    emitter.once('newListener', (name) => {
      if (name === 'data') resolve();
    });
  });
}

/**
 * `readUntil` cancels the response body's reader in its `finally` block, so a
 * second call against the same response throws "ReadableStream is locked".
 * This holds one reader open across several sequential waits within a test.
 */
function makeStreamReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';

  return {
    reader,
    async waitUntil(predicate: (accumulated: string) => boolean, timeoutMs = 3000): Promise<string> {
      const deadline = Date.now() + timeoutMs;
      while (!predicate(text)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`waitUntil timed out after ${timeoutMs}ms`);
        const { done, value } = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('waitUntil timed out')), remaining)),
        ]);
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
      return text;
    },
    async cancel(): Promise<void> {
      try {
        await reader.cancel();
      } catch {
        // cancel() rejects when the stream already errored, which several tests induce
      }
    },
  };
}

function makeFleetDocker(opts: {
  listContainersImpl: () => Promise<Array<{ Id: string; Names: string[] }>>;
  logsImpl: (id: string) => Promise<EventEmitter>;
}) {
  return {
    listContainers: mock(opts.listContainersImpl),
    getContainer: mock((id: string) => ({
      logs: mock(() => opts.logsImpl(id)),
    })),
  };
}

function eventFrame(text: string, eventName: string): unknown {
  const frame = text.split('\n\n').find((f) => f.includes(`event: ${eventName}`));
  if (!frame) throw new Error(`No ${eventName} event found in SSE text`);
  return JSON.parse(frame.split('\n')[1].replace(/^data:\s*/, ''));
}

describe('splitTimestamp (unit)', () => {
  test('splits a line carrying an RFC3339Nano prefix', () => {
    expect(splitTimestamp(withTs('hello world'))).toEqual({ at: TS, text: 'hello world' });
  });

  test('returns at: null for a line with no timestamp prefix', () => {
    expect(splitTimestamp('no timestamp here')).toEqual({ at: null, text: 'no timestamp here' });
  });
});

describe('token bucket (unit)', () => {
  test('rejects consumption once the burst is exhausted, with no time elapsed', () => {
    const now = Date.now();
    const bucket = makeBucket(3);
    bucket.lastRefillMs = now;
    expect(tryConsume(bucket, 1, 3, now)).toBe(true);
    expect(tryConsume(bucket, 1, 3, now)).toBe(true);
    expect(tryConsume(bucket, 1, 3, now)).toBe(true);
    expect(tryConsume(bucket, 1, 3, now)).toBe(false);
  });

  test('refills proportionally to elapsed time on an injected clock', () => {
    let now = Date.now();
    const bucket = makeBucket(10);
    bucket.lastRefillMs = now;
    for (let i = 0; i < 10; i++) tryConsume(bucket, 5, 10, now);
    expect(tryConsume(bucket, 5, 10, now)).toBe(false);

    now += 1000;
    expect(tryConsume(bucket, 5, 10, now)).toBe(true);
    expect(tryConsume(bucket, 5, 10, now)).toBe(true);
    expect(tryConsume(bucket, 5, 10, now)).toBe(true);
    expect(tryConsume(bucket, 5, 10, now)).toBe(true);
    expect(tryConsume(bucket, 5, 10, now)).toBe(true);
    expect(tryConsume(bucket, 5, 10, now)).toBe(false);
  });

  test('refill is capped at the burst size regardless of elapsed time', () => {
    let now = Date.now();
    const bucket = makeBucket(5);
    bucket.lastRefillMs = now;
    tryConsume(bucket, 5, 5, now);
    now += 1_000_000;
    tryConsume(bucket, 5, 5, now);
    expect(bucket.tokens).toBeLessThanOrEqual(5);
  });
});

describe('handleFleetLogStream: setup', () => {
  test('returns SSE response with 200 status and correct headers', () => {
    const docker = makeFleetDocker({
      listContainersImpl: () => Promise.resolve([]),
      logsImpl: () => Promise.resolve(makeReadable()),
    });
    const request = new Request('http://localhost/logs/stream');
    const response = handleFleetLogStream(docker as any, request);

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
  });

  test('emits a ready event with the default sinceSeconds unclamped', async () => {
    const docker = makeFleetDocker({
      listContainersImpl: () => Promise.resolve([]),
      logsImpl: () => Promise.resolve(makeReadable()),
    });
    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('event: ready'));
    ac.abort();

    const payload = eventFrame(text, 'ready') as { sinceSeconds: number; clamped: boolean };
    expect(payload.clamped).toBe(false);
    expect(typeof payload.sinceSeconds).toBe('number');
  });

  test('clamps a since param older than the lookback window', async () => {
    const docker = makeFleetDocker({
      listContainersImpl: () => Promise.resolve([]),
      logsImpl: () => Promise.resolve(makeReadable()),
    });
    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream?since=0', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('event: ready'));
    ac.abort();

    const payload = eventFrame(text, 'ready') as { sinceSeconds: number; clamped: boolean };
    expect(payload.clamped).toBe(true);
  });
});

describe('handleFleetLogStream: multiplexing', () => {
  test('multiple containers multiplex onto one stream, each line carrying its container id', async () => {
    const readableA = makeReadable();
    const readableB = makeReadable();
    const attachedA = onceAttached(readableA);
    const attachedB = onceAttached(readableB);

    const docker = makeFleetDocker({
      listContainersImpl: () =>
        Promise.resolve([
          { Id: 'aaa', Names: ['/web'] },
          { Id: 'bbb', Names: ['/db'] },
        ]),
      logsImpl: (id) => Promise.resolve(id === 'aaa' ? readableA : readableB),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    await Promise.all([attachedA, attachedB]);

    readableA.emit('data', muxedFrame(1, withTs('hello from web')));
    readableB.emit('data', muxedFrame(2, withTs('oops from db')));

    const text = await readUntil(response, (s) => {
      const frames = parseDataFrames(s);
      return frames.some((f) => f.containerId === 'aaa') && frames.some((f) => f.containerId === 'bbb');
    });
    ac.abort();

    const frames = parseDataFrames(text);
    const a = frames.find((f) => f.containerId === 'aaa');
    const b = frames.find((f) => f.containerId === 'bbb');

    expect(a.containerName).toBe('web');
    expect(a.text).toBe('hello from web');
    expect(a.stream).toBe('stdout');
    expect(b.containerName).toBe('db');
    expect(b.text).toBe('oops from db');
    expect(b.stream).toBe('stderr');
  });

  test('TTY and non-TTY containers coexist on the same stream', async () => {
    const ttyReadable = makeReadable();
    const muxReadable = makeReadable();
    const attachedTty = onceAttached(ttyReadable);
    const attachedMux = onceAttached(muxReadable);

    const docker = makeFleetDocker({
      listContainersImpl: () =>
        Promise.resolve([
          { Id: 'tty1', Names: ['/interactive'] },
          { Id: 'mux1', Names: ['/batch'] },
        ]),
      logsImpl: (id) => Promise.resolve(id === 'tty1' ? ttyReadable : muxReadable),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    await Promise.all([attachedTty, attachedMux]);

    ttyReadable.emit('data', Buffer.from(withTs('tty output line') + '\n'));
    muxReadable.emit('data', muxedFrame(1, withTs('mux output line')));

    const text = await readUntil(response, (s) => {
      const frames = parseDataFrames(s);
      return frames.some((f) => f.containerId === 'tty1') && frames.some((f) => f.containerId === 'mux1');
    });
    ac.abort();

    const frames = parseDataFrames(text);
    const ttyFrame = frames.find((f) => f.containerId === 'tty1');
    const muxFrame = frames.find((f) => f.containerId === 'mux1');

    expect(ttyFrame.text).toBe('tty output line');
    expect(ttyFrame.stream).toBe('stdout');
    expect(muxFrame.text).toBe('mux output line');
    expect(muxFrame.stream).toBe('stdout');
  });
});

describe('handleFleetLogStream: refresh reconcile', () => {
  test('a container appearing between refreshes gets attached', async () => {
    const readable1 = makeReadable();
    const readable2 = makeReadable();
    const attached1 = onceAttached(readable1);
    const attached2 = onceAttached(readable2);

    let callCount = 0;
    const docker = makeFleetDocker({
      listContainersImpl: () => {
        callCount++;
        return Promise.resolve(
          callCount === 1
            ? [{ Id: 'c1', Names: ['/first'] }]
            : [{ Id: 'c1', Names: ['/first'] }, { Id: 'c2', Names: ['/second'] }],
        );
      },
      logsImpl: (id) => Promise.resolve(id === 'c1' ? readable1 : readable2),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request, { refreshIntervalMs: 0, pollIntervalMs: 5 });

    await attached1;
    await attached2;
    readable2.emit('data', muxedFrame(1, withTs('hello from second')));

    const text = await readUntil(
      response,
      (s) => parseDataFrames(s).some((f) => f.containerId === 'c2'),
      3000,
    );
    ac.abort();

    expect(text).toContain('"id":"c2"');
    expect(text).toContain('"name":"second"');
    const frame = parseDataFrames(text).find((f) => f.containerId === 'c2');
    expect(frame.text).toBe('hello from second');
  });

  test('a container disappearing gets detached and its stream destroyed', async () => {
    const readable1 = makeReadable();
    const attached1 = onceAttached(readable1);

    let callCount = 0;
    const docker = makeFleetDocker({
      listContainersImpl: () => {
        callCount++;
        return Promise.resolve(callCount === 1 ? [{ Id: 'rm1', Names: ['/removeme'] }] : []);
      },
      logsImpl: () => Promise.resolve(readable1),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request, { refreshIntervalMs: 0, pollIntervalMs: 5 });

    await attached1;

    const text = await readUntil(
      response,
      (s) => s.split('\n\n').filter((f) => f.includes('event: containers')).length >= 2,
      3000,
    );
    ac.abort();

    expect(readable1.destroy).toHaveBeenCalledTimes(1);
    const lastContainersFrame = text.split('\n\n').filter((f) => f.includes('event: containers')).pop()!;
    expect(lastContainersFrame).toContain('"containers":[]');
  });

  test('a container whose stream ends gets reattached with since derived from its last timestamp', async () => {
    const readable1 = makeReadable();
    const readable2 = makeReadable();
    const attached1 = onceAttached(readable1);

    let logsCallCount = 0;
    const sinceByCall: number[] = [];
    const docker = {
      listContainers: mock(() => Promise.resolve([{ Id: 'end1', Names: ['/ender'] }])),
      getContainer: mock(() => ({
        logs: mock((opts: { since: number }) => {
          logsCallCount++;
          sinceByCall.push(opts.since);
          return Promise.resolve(logsCallCount === 1 ? readable1 : readable2);
        }),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request, { refreshIntervalMs: 0, pollIntervalMs: 5 });
    const stream = makeStreamReader(response);

    await attached1;
    readable1.emit('data', muxedFrame(1, withTs('before restart')));
    await stream.waitUntil((s) => parseDataFrames(s).some((f) => f.containerId === 'end1'));

    const attached2 = onceAttached(readable2);
    readable1.emit('end');
    await attached2;
    ac.abort();
    await stream.cancel();

    expect(logsCallCount).toBe(2);
    const expectedSince = (new Date(TS).getTime() + 1) / 1000;
    expect(sinceByCall[1]).toBeCloseTo(expectedSince, 5);
  });
});

describe('handleFleetLogStream: abort teardown', () => {
  test('client abort tears down every per-container stream', async () => {
    const readableA = makeReadable();
    const readableB = makeReadable();
    const attachedA = onceAttached(readableA);
    const attachedB = onceAttached(readableB);

    const docker = makeFleetDocker({
      listContainersImpl: () =>
        Promise.resolve([
          { Id: 'aaa', Names: ['/a'] },
          { Id: 'bbb', Names: ['/b'] },
        ]),
      logsImpl: (id) => Promise.resolve(id === 'aaa' ? readableA : readableB),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    handleFleetLogStream(docker as any, request);

    await Promise.all([attachedA, attachedB]);
    ac.abort();

    expect(readableA.destroy).toHaveBeenCalledTimes(1);
    expect(readableB.destroy).toHaveBeenCalledTimes(1);
  });

  test('client abort during an in-flight refresh still tears down attached streams', async () => {
    const readable1 = makeReadable();
    const attached1 = onceAttached(readable1);

    let callCount = 0;
    let resolveSecondCallStarted: () => void;
    const secondCallStarted = new Promise<void>((resolve) => {
      resolveSecondCallStarted = resolve;
    });
    // Never resolves: the test only needs the refresh's listContainers call to be
    // in flight when abort fires, not to complete.
    const heldForever = new Promise<Array<{ Id: string; Names: string[] }>>(() => {});

    const docker = makeFleetDocker({
      listContainersImpl: () => {
        callCount++;
        if (callCount === 1) return Promise.resolve([{ Id: 'c1', Names: ['/first'] }]);
        resolveSecondCallStarted();
        return heldForever;
      },
      logsImpl: () => Promise.resolve(readable1),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request, { refreshIntervalMs: 0, pollIntervalMs: 5 });

    await attached1;
    await secondCallStarted;

    ac.abort();

    expect(readable1.destroy).toHaveBeenCalledTimes(1);

    const reader = response.body!.getReader();
    let done = false;
    const deadline = Date.now() + 3000;
    while (!done && Date.now() < deadline) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
  });

  test('abort mid-attach destroys the readable that resolves after teardown and never registers it', async () => {
    let resolveLogsCalled: () => void;
    const logsCalled = new Promise<void>((resolve) => {
      resolveLogsCalled = resolve;
    });
    let resolveLateLogs: (readable: EventEmitter) => void;
    const lateLogsPromise = new Promise<EventEmitter>((resolve) => {
      resolveLateLogs = resolve;
    });
    const lateReadable = makeReadable();

    const docker = makeFleetDocker({
      listContainersImpl: () => Promise.resolve([{ Id: 'late1', Names: ['/late'] }]),
      logsImpl: () => {
        resolveLogsCalled();
        return lateLogsPromise;
      },
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    handleFleetLogStream(docker as any, request);

    await logsCalled;
    ac.abort();

    resolveLateLogs!(lateReadable);
    await lateLogsPromise;

    expect(lateReadable.destroy).toHaveBeenCalledTimes(1);
    expect(lateReadable.listenerCount('data')).toBe(0);
  });
});

describe('handleFleetLogStream: failure isolation', () => {
  test("one container's open failure does not affect other containers", async () => {
    const goodReadable = makeReadable();
    const attachedGood = onceAttached(goodReadable);

    const docker = makeFleetDocker({
      listContainersImpl: () =>
        Promise.resolve([
          { Id: 'good1', Names: ['/good'] },
          { Id: 'bad1', Names: ['/bad'] },
        ]),
      logsImpl: (id) => (id === 'bad1' ? Promise.reject(new Error('permission denied')) : Promise.resolve(goodReadable)),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    await attachedGood;
    goodReadable.emit('data', muxedFrame(1, withTs('still alive')));

    const text = await readUntil(
      response,
      (s) => s.includes('"type":"open_failed"') && parseDataFrames(s).some((f) => f.containerId === 'good1'),
    );
    ac.abort();

    expect(text).toContain('"containerId":"bad1"');
    expect(text).toContain('"error":"permission denied"');
    const frames = parseDataFrames(text);
    expect(frames.find((f) => f.containerId === 'good1')?.text).toBe('still alive');
  });

  test('a stream error (non-gone) reports container-error without stopping others', async () => {
    const goodReadable = makeReadable();
    const errReadable = makeReadable();
    const attachedGood = onceAttached(goodReadable);
    const attachedErr = onceAttached(errReadable);

    const docker = makeFleetDocker({
      listContainersImpl: () =>
        Promise.resolve([
          { Id: 'good3', Names: ['/good3'] },
          { Id: 'err1', Names: ['/errctr'] },
        ]),
      logsImpl: (id) => Promise.resolve(id === 'err1' ? errReadable : goodReadable),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    await Promise.all([attachedGood, attachedErr]);

    errReadable.emit('error', new Error('connection reset'));
    goodReadable.emit('data', muxedFrame(1, withTs('still going')));

    const text = await readUntil(
      response,
      (s) => s.includes('"type":"stream_error"') && parseDataFrames(s).some((f) => f.containerId === 'good3'),
    );
    ac.abort();

    expect(text).toContain('"containerId":"err1"');
    expect(text).toContain('"error":"connection reset"');
    const frames = parseDataFrames(text);
    expect(frames.find((f) => f.containerId === 'good3')?.text).toBe('still going');
  });

  test('a container-gone stream error is treated as normal lifecycle, not a failure', async () => {
    const goodReadable = makeReadable();
    const goneReadable = makeReadable();
    const attachedGood = onceAttached(goodReadable);
    const attachedGone = onceAttached(goneReadable);

    const docker = makeFleetDocker({
      listContainersImpl: () =>
        Promise.resolve([
          { Id: 'good2', Names: ['/good2'] },
          { Id: 'gone1', Names: ['/gone'] },
        ]),
      logsImpl: (id) => Promise.resolve(id === 'gone1' ? goneReadable : goodReadable),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    await Promise.all([attachedGood, attachedGone]);

    goneReadable.emit('error', new Error('No such container: gone1 (HTTP code 404)'));
    goodReadable.emit('data', muxedFrame(1, withTs('carry on')));

    const text = await readUntil(response, (s) => parseDataFrames(s).some((f) => f.containerId === 'good2'));
    ac.abort();

    expect(text).not.toContain('"containerId":"gone1"');
    const frames = parseDataFrames(text);
    expect(frames.find((f) => f.containerId === 'good2')?.text).toBe('carry on');
  });

  test('a container that repeatedly fails to open is abandoned after MAX_CONTAINER_OPEN_FAILURES and not retried', async () => {
    let callCount = 0;
    const docker = makeFleetDocker({
      listContainersImpl: () => Promise.resolve([{ Id: 'flaky1', Names: ['/flaky'] }]),
      logsImpl: () => {
        callCount++;
        return Promise.reject(new Error('connection refused'));
      },
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request, { refreshIntervalMs: 0, pollIntervalMs: 5 });
    const stream = makeStreamReader(response);

    const abandonedText = await stream.waitUntil((s) => s.includes('"type":"attach_abandoned"'), 5000);
    const callsAtAbandon = callCount;
    const containersEventsAtAbandon = abandonedText.split('\n\n').filter((f) => f.includes('event: containers')).length;

    const laterText = await stream.waitUntil(
      (s) => s.split('\n\n').filter((f) => f.includes('event: containers')).length >= containersEventsAtAbandon + 3,
      5000,
    );
    ac.abort();
    await stream.cancel();

    const abandonedFrames = laterText.split('\n\n').filter((f) => f.includes('"type":"attach_abandoned"'));
    expect(abandonedFrames.length).toBe(1);
    expect(callCount).toBe(callsAtAbandon);
  });

  test('reaching maxConsecutiveFailures on refresh failures emits a fatal error and closes the stream', async () => {
    let callCount = 0;
    const docker = makeFleetDocker({
      listContainersImpl: () => {
        callCount++;
        if (callCount === 1) return Promise.resolve([]);
        return Promise.reject(new Error('docker daemon unreachable'));
      },
      logsImpl: () => Promise.resolve(makeReadable()),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', {
      signal: ac.signal,
    });
    const response = handleFleetLogStream(docker as any, request, {
      refreshIntervalMs: 0,
      pollIntervalMs: 5,
      maxConsecutiveFailures: 3,
    });
    const stream = makeStreamReader(response);

    const text = await stream.waitUntil((s) => s.includes('event: error'), 5000);

    expect(text).toContain('"error":"Docker daemon unreachable, stream closed"');
    const refreshFailedCount = text.split('\n\n').filter((f) => f.includes('"type":"refresh_failed"')).length;
    expect(refreshFailedCount).toBe(3);

    const result = await stream.reader.read();
    expect(result.done).toBe(true);
    ac.abort();
  });
});

describe('handleFleetLogStream: line caps', () => {
  test('truncates a line exceeding MAX_LINE_BYTES and marks it truncated', async () => {
    const readable = makeReadable();
    const attached = onceAttached(readable);

    const docker = makeFleetDocker({
      listContainersImpl: () => Promise.resolve([{ Id: 'big1', Names: ['/big'] }]),
      logsImpl: () => Promise.resolve(readable),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    await attached;

    const longText = 'a'.repeat(9000);
    readable.emit('data', muxedFrame(1, withTs(longText)));

    const text = await readUntil(response, (s) => parseDataFrames(s).some((f) => f.containerId === 'big1'));
    ac.abort();

    const frame = parseDataFrames(text).find((f) => f.containerId === 'big1');
    expect(frame.truncated).toBe(true);
    expect(Buffer.byteLength(frame.text)).toBe(8192);
  });

  test('does not truncate a line at or under MAX_LINE_BYTES', async () => {
    const readable = makeReadable();
    const attached = onceAttached(readable);

    const docker = makeFleetDocker({
      listContainersImpl: () => Promise.resolve([{ Id: 'small1', Names: ['/small'] }]),
      logsImpl: () => Promise.resolve(readable),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    await attached;

    readable.emit('data', muxedFrame(1, withTs('short line')));

    const text = await readUntil(response, (s) => parseDataFrames(s).some((f) => f.containerId === 'small1'));
    ac.abort();

    const frame = parseDataFrames(text).find((f) => f.containerId === 'small1');
    expect(frame.truncated).toBeUndefined();
    expect(frame.text).toBe('short line');
  });

  test('the per-container token bucket drops lines beyond the burst cap and admits at most the burst', async () => {
    const readable = makeReadable();
    const attached = onceAttached(readable);

    const docker = makeFleetDocker({
      listContainersImpl: () => Promise.resolve([{ Id: 'burst1', Names: ['/burst'] }]),
      logsImpl: () => Promise.resolve(readable),
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    await attached;

    const burst = Buffer.concat(Array.from({ length: 450 }, (_, i) => muxedFrame(1, withTs(`line ${i}`))));
    readable.emit('data', burst);

    const text = await readUntil(response, (s) => parseDataFrames(s).some((f) => f.containerId === 'burst1'));
    ac.abort();

    const admitted = parseDataFrames(text).filter((f) => f.containerId === 'burst1');
    expect(admitted.length).toBeLessThanOrEqual(400);
  });

  test('the first throttle notice batches drops over the full window instead of firing on the very first rejection', async () => {
    const readable = makeReadable();
    const attached = onceAttached(readable);

    const docker = makeFleetDocker({
      listContainersImpl: () => Promise.resolve([{ Id: 'burst2', Names: ['/burst2'] }]),
      logsImpl: () => Promise.resolve(readable),
    });

    let now = 1_700_000_000_000;
    const dateNowSpy = spyOn(Date, 'now').mockImplementation(() => now);

    const ac = new AbortController();
    const request = new Request('http://localhost/logs/stream', { signal: ac.signal });
    const response = handleFleetLogStream(docker as any, request);

    await attached;

    const burst = Buffer.concat(Array.from({ length: 450 }, (_, i) => muxedFrame(1, withTs(`line ${i}`))));
    readable.emit('data', burst);
    // Bucket refills to its burst size after the window elapses, so a second
    // over-cap burst is needed to trigger another drop and flush the notice.
    now += 5000;
    readable.emit('data', burst);

    const text = await readUntil(response, (s) => s.includes('event: throttled'));
    ac.abort();
    dateNowSpy.mockRestore();

    const throttlePayload = eventFrame(text, 'throttled') as { containerId: string | null; dropped: number; windowMs: number };
    expect(throttlePayload.containerId).toBe('burst2');
    expect(throttlePayload.dropped).toBe(51);
    expect(throttlePayload.windowMs).toBe(5000);
  });
});
