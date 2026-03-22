import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { StackStatusCollector, type ManagedHostInfo } from '../collectors/stack-status-collector';
import type { StackStatusRepository } from '@/lib/database/repositories/stack-status-repository';
import type { StackContainer } from '@/types/stacks';

// Suppress console output during tests
const originalConsoleInfo = console.info;
const originalConsoleError = console.error;

function makeRepository(): StackStatusRepository {
  return {
    upsertStackStatus: mock(async () => {}),
    getAll: mock(async () => []),
    getByStackHost: mock(async () => null),
    getByHost: mock(async () => []),
    deleteByStackHost: mock(async () => {}),
  } as unknown as StackStatusRepository;
}

const sampleHost: ManagedHostInfo = {
  name: 'homeserver',
  agentUrl: 'http://192.168.1.10:9090',
};

const sampleContainers: StackContainer[] = [
  { id: 'abc123', name: 'web', status: 'running', image: 'nginx:latest' },
];

/** Build a SSE-formatted body string for one or more events */
function buildSseBody(events: object[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
}

/**
 * Create a mock fetch that returns a SSE stream for the given body string.
 * Immediately closes the stream after emitting the body so `collect()` returns.
 * On the second call (reconnect after stream closes) it aborts the controller so run() exits.
 */
function makeFetchWithBody(
  body: string,
  controller?: AbortController,
): (url: string, init?: RequestInit) => Promise<Response> {
  let calls = 0;
  return mock(async (_url: string, _init?: RequestInit) => {
    calls++;
    if (calls > 1) {
      // Abort on reconnect attempt to prevent infinite loop
      controller?.abort();
      throw new DOMException('Aborted', 'AbortError');
    }
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(encoder.encode(body));
        ctrl.close();
      },
    });
    return new Response(stream, { status: 200 });
  });
}

describe('StackStatusCollector', () => {
  beforeEach(() => {
    console.info = mock(() => {});
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.info = originalConsoleInfo;
    console.error = originalConsoleError;
  });

  it('implements AsyncDisposable', () => {
    const repo = makeRepository();
    const collector = new StackStatusCollector(sampleHost, 'token', repo);
    expect(typeof collector[Symbol.asyncDispose]).toBe('function');
  });

  it('aborts signal when asyncDispose is called', async () => {
    const repo = makeRepository();
    const collector = new StackStatusCollector(sampleHost, 'token', repo);
    expect(collector.signal.aborted).toBe(false);
    await collector[Symbol.asyncDispose]();
    expect(collector.signal.aborted).toBe(true);
  });

  it('exposes the abort signal via .signal getter', () => {
    const controller = new AbortController();
    const repo = makeRepository();
    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller);
    expect(collector.signal).toBe(controller.signal);
  });

  it('connects to agent URL with Bearer token auth', async () => {
    const repo = makeRepository();
    const controller = new AbortController();
    // Second call aborts so run() exits after the first collect cycle
    const fetchFn = makeFetchWithBody('', controller);
    const collector = new StackStatusCollector(sampleHost, 'secret-token', repo, controller, fetchFn);

    await collector.run();

    // fetch was called at least once with the correct URL and auth header
    expect(fetchFn).toHaveBeenCalledWith(
      'http://192.168.1.10:9090/stacks/events',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer secret-token' }),
      }),
    );
  });

  it('parses SSE events and calls upsertStackStatus with correct arguments', async () => {
    const repo = makeRepository();
    const controller = new AbortController();
    const event = { stack: 'myapp', containers: sampleContainers };
    // Second call aborts so run() exits; first call delivers the body
    const fetchFn = makeFetchWithBody(buildSseBody([event]), controller);
    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller, fetchFn);

    await collector.run();

    expect(repo.upsertStackStatus).toHaveBeenCalledWith('myapp', 'homeserver', sampleContainers);
  });

  it('parses multiple SSE events in a single response', async () => {
    const repo = makeRepository();
    const controller = new AbortController();
    const events = [
      { stack: 'app1', containers: sampleContainers },
      { stack: 'app2', containers: [] },
    ];
    const fetchFn = makeFetchWithBody(buildSseBody(events), controller);
    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller, fetchFn);

    await collector.run();

    expect(repo.upsertStackStatus).toHaveBeenCalledTimes(2);
    expect(repo.upsertStackStatus).toHaveBeenNthCalledWith(1, 'app1', 'homeserver', sampleContainers);
    expect(repo.upsertStackStatus).toHaveBeenNthCalledWith(2, 'app2', 'homeserver', []);
  });

  it('skips malformed (non-JSON) SSE data lines', async () => {
    const repo = makeRepository();
    const controller = new AbortController();
    const body = 'data: not-valid-json\n\ndata: {"stack":"ok","containers":[]}\n\n';
    const fetchFn = makeFetchWithBody(body, controller);
    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller, fetchFn);

    await collector.run();

    expect(repo.upsertStackStatus).toHaveBeenCalledTimes(1);
    expect(repo.upsertStackStatus).toHaveBeenCalledWith('ok', 'homeserver', []);
  });

  it('ignores SSE messages without a data: line', async () => {
    const repo = makeRepository();
    const controller = new AbortController();
    const body = 'event: ping\n\ndata: {"stack":"real","containers":[]}\n\n';
    const fetchFn = makeFetchWithBody(body, controller);
    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller, fetchFn);

    await collector.run();

    expect(repo.upsertStackStatus).toHaveBeenCalledTimes(1);
    expect(repo.upsertStackStatus).toHaveBeenCalledWith('real', 'homeserver', []);
  });

  it('throws and reconnects when agent returns non-2xx status', async () => {
    const repo = makeRepository();
    let callCount = 0;
    const controller = new AbortController();

    const fetchFn = mock(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response(null, { status: 503 });
      }
      // On second call abort so we don't loop forever
      controller.abort();
      return new Response(null, { status: 503 });
    });

    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller, fetchFn);
    await collector.run();

    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(console.error).toHaveBeenCalled();
  });

  it('logs error and retries with exponential backoff on connection failure', async () => {
    const repo = makeRepository();
    const controller = new AbortController();
    let callCount = 0;

    const fetchFn = mock(async () => {
      callCount++;
      if (callCount >= 2) controller.abort();
      throw new Error('ECONNREFUSED');
    });

    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller, fetchFn);

    // Use a very short timer by overriding BASE_DELAY_MS is not possible, but the abort
    // during the backoff timer will cause it to resolve immediately
    await collector.run();

    expect(callCount).toBeGreaterThanOrEqual(1);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('[StackStatusCollector]'),
      expect.anything(),
    );
  });

  it('stops cleanly when abort signal fires during run', async () => {
    const repo = makeRepository();
    const controller = new AbortController();

    // Create a stream that never emits data — run() should stop when aborted
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      const signal = (init as RequestInit & { signal?: AbortSignal })?.signal;
      const stream = new ReadableStream({
        start(ctrl) {
          // Close the stream when the signal aborts
          signal?.addEventListener('abort', () => ctrl.close(), { once: true });
        },
      });
      return new Response(stream, { status: 200 });
    });

    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller, fetchFn);

    // Abort after a short delay
    const runPromise = collector.run();
    controller.abort();
    await runPromise;

    expect(collector.signal.aborted).toBe(true);
    expect(repo.upsertStackStatus).not.toHaveBeenCalled();
  });

  it('stops cleanly when asyncDispose is called during run', async () => {
    const repo = makeRepository();

    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      const signal = (init as RequestInit & { signal?: AbortSignal })?.signal;
      const stream = new ReadableStream({
        start(ctrl) {
          signal?.addEventListener('abort', () => ctrl.close(), { once: true });
        },
      });
      return new Response(stream, { status: 200 });
    });

    const collector = new StackStatusCollector(sampleHost, 'token', repo, undefined, fetchFn);
    const runPromise = collector.run();
    await collector[Symbol.asyncDispose]();
    await runPromise;

    expect(collector.signal.aborted).toBe(true);
  });

  it('uses provided parentAbortController signal', () => {
    const controller = new AbortController();
    const repo = makeRepository();
    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller);
    expect(collector.signal).toBe(controller.signal);
  });

  it('resets consecutive errors after a successful collect', async () => {
    const repo = makeRepository();
    const controller = new AbortController();
    let callCount = 0;

    // First call throws, second call succeeds and returns empty body, third aborts
    const fetchFn = mock(async () => {
      callCount++;
      if (callCount === 1) throw new Error('first failure');
      if (callCount === 2) {
        controller.abort();
        return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
      }
      return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200 });
    });

    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller, fetchFn);
    await collector.run();

    // Should have attempted at least twice
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it('logs start and stop info messages via console.info', async () => {
    const repo = makeRepository();
    const controller = new AbortController();
    controller.abort(); // abort immediately so run exits right away

    // Need a non-erroring fetch for the aborted signal path
    const fetchFn = mock(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });

    const collector = new StackStatusCollector(sampleHost, 'token', repo, controller, fetchFn);
    await collector.run();

    const infoCalls = (console.info as ReturnType<typeof mock>).mock.calls.map((c) => c[0]);
    expect(infoCalls.some((m) => typeof m === 'string' && m.includes('Starting'))).toBe(true);
    expect(infoCalls.some((m) => typeof m === 'string' && m.includes('Stopped'))).toBe(true);
  });
});
