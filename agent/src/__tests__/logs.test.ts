import { describe, expect, test, mock } from 'bun:test';
import { EventEmitter } from 'node:events';
import { handleLogStream } from '../routes/logs';

function makeRequest(abortController?: AbortController): Request {
  const ctrl = abortController ?? new AbortController();
  return new Request('http://localhost/logs/abc123', { signal: ctrl.signal });
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

describe('handleLogStream', () => {
  test('returns SSE response with correct headers', () => {
    const mockContainer = {
      logs: mock(() => Promise.resolve(Buffer.from(''))),
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
    const logEmitter = new EventEmitter();

    const mockContainer = {
      inspect: mock(() => Promise.resolve({ Config: { Tty: true } })),
      logs: mock(() => Promise.resolve(logEmitter)),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    // Allow the async start() to run through inspect + logs setup
    await new Promise((r) => setTimeout(r, 10));

    logEmitter.emit('data', Buffer.from('hello world\nfoo bar\n'));
    logEmitter.emit('end');

    const body = await drainStream(response);

    // Each non-empty line becomes a stdout LogLine SSE event
    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stdout', text: 'hello world' })}`);
    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stdout', text: 'foo bar' })}`);
  });

  test('TTY mode: empty lines are filtered out', async () => {
    const logEmitter = new EventEmitter();

    const mockContainer = {
      inspect: mock(() => Promise.resolve({ Config: { Tty: true } })),
      logs: mock(() => Promise.resolve(logEmitter)),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    // Chunk containing only newlines
    logEmitter.emit('data', Buffer.from('\n\n'));
    logEmitter.emit('end');

    const body = await drainStream(response);
    // Nothing meaningful should be emitted
    expect(body.trim()).toBe('');
  });

  test('muxed (non-TTY) mode: parses stdout and stderr mux frames', async () => {
    const logEmitter = new EventEmitter();

    const mockContainer = {
      inspect: mock(() => Promise.resolve({ Config: { Tty: false } })),
      logs: mock(() => Promise.resolve(logEmitter)),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    // Build a muxed chunk with one stdout frame and one stderr frame
    const stdoutPayload = Buffer.from('stdout line');
    const stderrPayload = Buffer.from('stderr line');

    const stdoutHeader = Buffer.alloc(8);
    stdoutHeader[0] = 1; // stdout
    stdoutHeader.writeUInt32BE(stdoutPayload.length, 4);

    const stderrHeader = Buffer.alloc(8);
    stderrHeader[0] = 2; // stderr
    stderrHeader.writeUInt32BE(stderrPayload.length, 4);

    const chunk = Buffer.concat([stdoutHeader, stdoutPayload, stderrHeader, stderrPayload]);
    logEmitter.emit('data', chunk);
    logEmitter.emit('end');

    const body = await drainStream(response);

    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stdout', text: 'stdout line' })}`);
    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stderr', text: 'stderr line' })}`);
  });

  test('stream end: closes the SSE stream cleanly', async () => {
    const logEmitter = new EventEmitter();

    const mockContainer = {
      inspect: mock(() => Promise.resolve({ Config: { Tty: true } })),
      logs: mock(() => Promise.resolve(logEmitter)),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    // Emit end immediately with no data
    logEmitter.emit('end');

    // drainStream should resolve (not hang), since the stream is closed
    const body = await drainStream(response);
    expect(body).toBe('');
  });

  test('stream error: enqueues an SSE error event and closes', async () => {
    const logEmitter = new EventEmitter();

    const mockContainer = {
      inspect: mock(() => Promise.resolve({ Config: { Tty: true } })),
      logs: mock(() => Promise.resolve(logEmitter)),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest();
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    logEmitter.emit('error', new Error('socket hang up'));

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

  test('abort signal: stops enqueuing data after client disconnects', async () => {
    const logEmitter = new EventEmitter();
    const abortController = new AbortController();

    const mockContainer = {
      inspect: mock(() => Promise.resolve({ Config: { Tty: true } })),
      logs: mock(() => Promise.resolve(logEmitter)),
    };
    const mockDocker = { getContainer: mock(() => mockContainer) };

    const request = makeRequest(abortController);
    const response = handleLogStream(mockDocker as any, 'abc123', request);

    await new Promise((r) => setTimeout(r, 10));

    // Send some data before abort
    logEmitter.emit('data', Buffer.from('before abort\n'));

    // Abort the request
    abortController.abort();

    // Data emitted after abort should be silently dropped (no enqueue-after-close error)
    logEmitter.emit('data', Buffer.from('after abort\n'));

    const body = await drainStream(response);
    expect(body).toContain(`data: ${JSON.stringify({ stream: 'stdout', text: 'before abort' })}`);
    expect(body).not.toContain('after abort');
  });
});
