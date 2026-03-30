import { describe, expect, test, mock, beforeAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import { handleLogStream } from '../routes/logs';

beforeAll(() => {
  console.error = mock(() => {});
});

function makeRequest(abortController?: AbortController): Request {
  const ctrl = abortController ?? new AbortController();
  return new Request('http://localhost/logs/abc123', { signal: ctrl.signal });
}

/** Build a Docker muxed frame: 8-byte header + payload. */
function buildMuxedFrame(streamType: number, payload: string): Buffer {
  const payloadBuf = Buffer.from(payload);
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payloadBuf.length, 4);
  return Buffer.concat([header, payloadBuf]);
}

/** Drain an SSE ReadableStream to a string, timing out after `ms` ms. */
async function drainStream(response: Response, ms = 500): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let result = '';
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('stream drain timeout')), ms)
  );
  while (true) {
    const { value, done } = await Promise.race([
      reader.read(),
      timeout,
    ] as [Promise<ReadableStreamReadResult<Uint8Array>>, Promise<never>]);
    if (done) break;
    result += decoder.decode(value);
  }
  return result;
}

/** Create two-phase mock container with backlog and live emitters. */
function makeTwoPhaseContainer(isTty: boolean) {
  const backlogEmitter = new EventEmitter();
  const liveEmitter = new EventEmitter();
  const mockContainer = {
    inspect: mock(() => Promise.resolve({ Config: { Tty: isTty } })),
    logs: mock((opts: Record<string, unknown>) => {
      if (!opts.follow) return Promise.resolve(backlogEmitter);
      return Promise.resolve(liveEmitter);
    }),
  };
  return { backlogEmitter, liveEmitter, mockContainer };
}

describe('handleLogStream', () => {
  test('returns SSE response with correct headers', () => {
    const backlogEmitter = new EventEmitter();
    const mockContainer = {
      logs: mock(() => Promise.resolve(backlogEmitter)),
      inspect: mock(() => Promise.resolve({ Config: { Tty: false } })),
    };
    const mockDocker = {
      getContainer: mock(() => mockContainer),
    };
    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
    expect(response.status).toBe(200);
  });

  test('TTY mode: streams log lines as SSE events', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(true);
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    backlogEmitter.emit('data', Buffer.from('2026-03-29T12:00:00Z hello world\n2026-03-29T12:00:01Z foo bar\n'));
    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    liveEmitter.emit('end');

    const body = await drainStream(response);

    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stdout', text: '2026-03-29T12:00:00Z hello world' })}`);
    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stdout', text: '2026-03-29T12:00:01Z foo bar' })}`);
  });

  test('TTY mode: empty lines are filtered out', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(true);
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    backlogEmitter.emit('data', Buffer.from('\n\n'));
    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    liveEmitter.emit('end');

    const body = await drainStream(response);
    // Only backlog_done event, no data events
    const dataLines = body.split('\n').filter((l) => l.startsWith('data:') && !l.includes('backlog_done'));
    expect(dataLines.filter((l) => !l.includes('{}')).length).toBe(0);
  });

  test('muxed (non-TTY) mode: parses stdout and stderr mux frames', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(false);
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    const chunk = Buffer.concat([
      buildMuxedFrame(1, 'stdout line'),
      buildMuxedFrame(2, 'stderr line'),
    ]);
    backlogEmitter.emit('data', chunk);
    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    liveEmitter.emit('end');

    const body = await drainStream(response);

    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stdout', text: 'stdout line' })}`);
    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stderr', text: 'stderr line' })}`);
  });

  test('muxed mode: handles frames split across chunks', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(false);
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    const fullFrame = buildMuxedFrame(1, 'split across chunks');

    // Split the frame in the middle of the payload
    const splitPoint = 12; // 8-byte header + 4 bytes of payload
    const chunk1 = fullFrame.subarray(0, splitPoint);
    const chunk2 = fullFrame.subarray(splitPoint);

    backlogEmitter.emit('data', chunk1);
    backlogEmitter.emit('data', chunk2);
    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    liveEmitter.emit('end');

    const body = await drainStream(response);

    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stdout', text: 'split across chunks' })}`);
  });

  test('stream end: closes the SSE stream cleanly', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(true);
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    liveEmitter.emit('end');

    const body = await drainStream(response);
    expect(body).toContain('event: backlog_done');
  });

  test('stream error: enqueues an SSE error event and closes', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(true);
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    liveEmitter.emit('error', new Error('socket hang up'));

    const body = await drainStream(response);

    expect(body).toContain('event: error');
    expect(body).toContain(`data: ${JSON.stringify({ error: 'socket hang up' })}`);
  });

  test('container inspect failure: enqueues SSE error event and closes', async () => {
    const mockContainer = {
      inspect: mock(() => Promise.reject(new Error('container not found'))),
      logs: mock(() => Promise.resolve(new EventEmitter())),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    const body = await drainStream(response);

    expect(body).toContain('event: error');
    expect(body).toContain(`data: ${JSON.stringify({ error: 'container not found' })}`);
  });

  test('container inspect failure with non-Error throw: enqueues SSE error event', async () => {
    const mockContainer = {
      inspect: mock(() => Promise.reject('string error')),
      logs: mock(() => Promise.resolve(new EventEmitter())),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    const body = await drainStream(response);

    expect(body).toContain('event: error');
    expect(body).toContain(`data: ${JSON.stringify({ error: 'string error' })}`);
  });

  test('abort signal: destroys the underlying Docker log stream', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(true);
    const destroySpy = mock(() => {});
    (liveEmitter as any).destroy = destroySpy;
    const abortController = new AbortController();

    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest(abortController);
    handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    abortController.abort();
    await new Promise((r) => setTimeout(r, 10));

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  test('abort after stream error does not throw (double close)', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(true);
    const abortController = new AbortController();

    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest(abortController);
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    // Stream error closes the controller
    liveEmitter.emit('error', new Error('pipe broken'));
    await new Promise((r) => setTimeout(r, 10));

    // Abort after error — controller.close() will throw TypeError (already closed)
    abortController.abort();
    await new Promise((r) => setTimeout(r, 10));

    const body = await drainStream(response);
    expect(body).toContain('event: error');
    expect(body).toContain('pipe broken');
  });

  test('abort signal: stops enqueuing data after client disconnects', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(true);
    const abortController = new AbortController();

    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest(abortController);
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    // Send some data before abort
    liveEmitter.emit('data', Buffer.from('before abort\n'));

    // Abort the request
    abortController.abort();

    // Data emitted after abort should be silently dropped (no enqueue-after-close error)
    liveEmitter.emit('data', Buffer.from('after abort\n'));

    const body = await drainStream(response);
    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stdout', text: 'before abort' })}`);
    expect(body).not.toContain('after abort');
  });

  test('two-phase: sends backlog lines then backlog_done event', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(true);
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    backlogEmitter.emit('data', Buffer.from('backlog line 1\n'));
    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    liveEmitter.emit('end');

    const body = await drainStream(response);

    // Backlog line must appear before backlog_done
    const backlogLineIdx = body.indexOf(JSON.stringify({ stream: 'stdout', text: 'backlog line 1' }));
    const backlogDoneIdx = body.indexOf('event: backlog_done');
    expect(backlogLineIdx).toBeGreaterThan(-1);
    expect(backlogDoneIdx).toBeGreaterThan(-1);
    expect(backlogLineIdx).toBeLessThan(backlogDoneIdx);

    // container.logs must have been called twice (backlog + live)
    expect(mockContainer.logs).toHaveBeenCalledTimes(2);
  });

  test('two-phase: live stream uses since timestamp from last backlog line', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(false);
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    // Send a muxed backlog frame with a known timestamp prefix
    const timestamp = '2026-03-29T12:30:45.123Z';
    backlogEmitter.emit('data', buildMuxedFrame(1, `${timestamp} some log line`));
    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    liveEmitter.emit('end');
    await drainStream(response);

    // The second call should be the live stream with follow: true and since
    const secondCall = mockContainer.logs.mock.calls[1]![0] as Record<string, unknown>;
    expect(secondCall.follow).toBe(true);
    const expectedSince = new Date(timestamp).getTime() / 1000;
    expect(secondCall.since).toBeCloseTo(expectedSince, 0);
  });

  test('two-phase: live lines stream after backlog_done', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(true);
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    backlogEmitter.emit('data', Buffer.from('history line\n'));
    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    liveEmitter.emit('data', Buffer.from('live line\n'));
    liveEmitter.emit('end');

    const body = await drainStream(response);

    const backlogDoneIdx = body.indexOf('event: backlog_done');
    const liveLineIdx = body.indexOf(JSON.stringify({ stream: 'stdout', text: 'live line' }));
    expect(backlogDoneIdx).toBeGreaterThan(-1);
    expect(liveLineIdx).toBeGreaterThan(-1);
    expect(backlogDoneIdx).toBeLessThan(liveLineIdx);
  });

  test('two-phase: abort during backlog destroys backlog stream', async () => {
    const backlogEmitter = new EventEmitter();
    const destroySpy = mock(() => {});
    (backlogEmitter as any).destroy = destroySpy;

    const liveEmitter = new EventEmitter();
    const abortController = new AbortController();

    const mockContainer = {
      inspect: mock(() => Promise.resolve({ Config: { Tty: true } })),
      logs: mock((opts: Record<string, unknown>) => {
        if (!opts.follow) return Promise.resolve(backlogEmitter);
        return Promise.resolve(liveEmitter);
      }),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest(abortController);
    handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    // Abort before backlog ends
    abortController.abort();
    await new Promise((r) => setTimeout(r, 10));

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  test('two-phase: falls back to current time when backlog has no parseable timestamps', async () => {
    const { backlogEmitter, liveEmitter, mockContainer } = makeTwoPhaseContainer(true);
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    const nowBefore = Date.now() / 1000;

    // Emit a line with no timestamp prefix
    backlogEmitter.emit('data', Buffer.from('no timestamp here\n'));
    backlogEmitter.emit('end');

    await new Promise((r) => setTimeout(r, 10));

    liveEmitter.emit('end');
    await drainStream(response);

    const nowAfter = Date.now() / 1000;

    // The second call should use a since value close to current time
    const secondCall = mockContainer.logs.mock.calls[1]![0] as Record<string, unknown>;
    expect(secondCall.follow).toBe(true);
    const since = secondCall.since as number;
    expect(since).toBeGreaterThanOrEqual(nowBefore - 1);
    expect(since).toBeLessThanOrEqual(nowAfter + 1);
  });
});
