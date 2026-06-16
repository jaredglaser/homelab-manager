import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { DatabaseConfig } from '@/lib/clients/database-client';
import { HostsListener, type HostChangeHandler } from '../hosts-listener';

const originalConsoleError = console.error;

function createMockDbConfig(): DatabaseConfig {
  return {
    host: 'localhost',
    port: 5432,
    database: 'test',
    user: 'test',
    password: 'test',
    sslRejectUnauthorized: true,
  };
}

function setupPgClientMocks(
  listener: HostsListener,
  onImpl?: (event: string, cb: (...args: any[]) => unknown) => unknown,
) {
  // Reach into the private pg.Client to install spies before start().
  const pgClient = (listener as unknown as { client: any }).client;
  spyOn(pgClient, 'connect').mockResolvedValue(undefined);
  spyOn(pgClient, 'query').mockResolvedValue({ rows: [] });
  if (onImpl) {
    spyOn(pgClient, 'on').mockImplementation(onImpl);
  } else {
    spyOn(pgClient, 'on').mockReturnValue(pgClient);
  }
  const endSpy = spyOn(pgClient, 'end').mockResolvedValue(undefined);
  return { pgClient, endSpy };
}

describe('HostsListener', () => {
  beforeEach(() => {
    console.error = mock(() => {});
  });

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it('connects, runs LISTEN on managed_hosts_change, and is AsyncDisposable', async () => {
    const handler: HostChangeHandler = mock(() => {});
    const controller = new AbortController();
    const listener = new HostsListener(createMockDbConfig(), handler, controller.signal);
    const { pgClient } = setupPgClientMocks(listener);

    await listener.start();

    expect(pgClient.connect).toHaveBeenCalled();
    expect(pgClient.query).toHaveBeenCalledWith('LISTEN managed_hosts_change');
    expect(Symbol.asyncDispose in listener).toBe(true);

    controller.abort();
    await listener[Symbol.asyncDispose]();
  });

  it('parses well-formed payloads and forwards to handler', async () => {
    const handler: HostChangeHandler = mock(() => {});
    const controller = new AbortController();
    const listener = new HostsListener(createMockDbConfig(), handler, controller.signal);

    let notify: ((msg: { payload: string | null }) => void) | undefined;
    setupPgClientMocks(listener, (event, cb) => {
      if (event === 'notification') notify = cb as typeof notify;
    });

    await listener.start();
    expect(notify).toBeDefined();

    notify!({ payload: JSON.stringify({ op: 'add', name: 'newhost' }) });
    // dispatch is async via void; allow the microtask queue to drain
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith({ op: 'add', name: 'newhost' });

    controller.abort();
    await listener[Symbol.asyncDispose]();
  });

  it('passes null payload to handler when notify is malformed', async () => {
    const handler: HostChangeHandler = mock(() => {});
    const controller = new AbortController();
    const listener = new HostsListener(createMockDbConfig(), handler, controller.signal);

    let notify: ((msg: { payload: string | null }) => void) | undefined;
    setupPgClientMocks(listener, (event, cb) => {
      if (event === 'notification') notify = cb as typeof notify;
    });

    await listener.start();

    notify!({ payload: 'not-json' });
    await Promise.resolve();
    await Promise.resolve();

    // handler still called so reconcile can fall back to full diff
    expect(handler).toHaveBeenCalledWith(null);

    notify!({ payload: null });
    await Promise.resolve();
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith(null);

    controller.abort();
    await listener[Symbol.asyncDispose]();
  });

  it('rejects payloads with unknown op values by passing null', async () => {
    const handler: HostChangeHandler = mock(() => {});
    const controller = new AbortController();
    const listener = new HostsListener(createMockDbConfig(), handler, controller.signal);

    let notify: ((msg: { payload: string | null }) => void) | undefined;
    setupPgClientMocks(listener, (event, cb) => {
      if (event === 'notification') notify = cb as typeof notify;
    });

    await listener.start();

    notify!({ payload: JSON.stringify({ op: 'sneaky', name: 'x' }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(handler).toHaveBeenCalledWith(null);

    controller.abort();
    await listener[Symbol.asyncDispose]();
  });

  it('logs and swallows errors thrown by handler', async () => {
    const handler: HostChangeHandler = mock(() => {
      throw new Error('reconcile blew up');
    });
    const controller = new AbortController();
    const listener = new HostsListener(createMockDbConfig(), handler, controller.signal);

    let notify: ((msg: { payload: string | null }) => void) | undefined;
    setupPgClientMocks(listener, (event, cb) => {
      if (event === 'notification') notify = cb as typeof notify;
    });

    await listener.start();

    notify!({ payload: JSON.stringify({ op: 'add', name: 'h' }) });
    await Promise.resolve();
    await Promise.resolve();

    expect(console.error).toHaveBeenCalled();

    controller.abort();
    await listener[Symbol.asyncDispose]();
  });

  it('logs pg client errors without throwing', async () => {
    const controller = new AbortController();
    const listener = new HostsListener(createMockDbConfig(), () => {}, controller.signal);

    let errorCb: ((err: Error) => void) | undefined;
    setupPgClientMocks(listener, (event, cb) => {
      if (event === 'error') errorCb = cb as typeof errorCb;
    });

    await listener.start();

    expect(errorCb).toBeDefined();
    expect(() => errorCb!(new Error('lost conn'))).not.toThrow();
    expect(console.error).toHaveBeenCalled();

    // Abort before the reconnect loop's first backoff sleep elapses so the
    // background reconnect exits instead of dialing a real database.
    controller.abort();
    await listener[Symbol.asyncDispose]();
  });

  it('calls client.end on dispose when started', async () => {
    const controller = new AbortController();
    const listener = new HostsListener(createMockDbConfig(), () => {}, controller.signal);
    const { endSpy } = setupPgClientMocks(listener);

    await listener.start();
    await listener[Symbol.asyncDispose]();

    expect(endSpy).toHaveBeenCalled();
    controller.abort();
  });

  it('dispose without start does not throw', async () => {
    const controller = new AbortController();
    const listener = new HostsListener(createMockDbConfig(), () => {}, controller.signal);
    await expect(listener[Symbol.asyncDispose]()).resolves.toBeUndefined();
    controller.abort();
  });

  it('ends the client on dispose even when LISTEN throws after connect', async () => {
    const controller = new AbortController();
    const listener = new HostsListener(createMockDbConfig(), () => {}, controller.signal);

    const pgClient = (listener as unknown as { client: any }).client;
    spyOn(pgClient, 'connect').mockResolvedValue(undefined);
    // First query (LISTEN) rejects; nothing else should be called
    spyOn(pgClient, 'query').mockRejectedValue(new Error('LISTEN failed'));
    spyOn(pgClient, 'on').mockReturnValue(pgClient);
    const endSpy = spyOn(pgClient, 'end').mockResolvedValue(undefined);

    await expect(listener.start()).rejects.toThrow('LISTEN failed');

    // Despite the LISTEN failure, dispose must close the live socket.
    await listener[Symbol.asyncDispose]();
    expect(endSpy).toHaveBeenCalled();

    controller.abort();
  });

  it('forwards ssl config to the pg.Client constructor', () => {
    const controller = new AbortController();
    const dbConfig: DatabaseConfig = {
      ...createMockDbConfig(),
      ssl: true,
      sslRejectUnauthorized: false,
    };
    const listener = new HostsListener(dbConfig, () => {}, controller.signal);
    const pgClient = (listener as unknown as { client: { connectionParameters: any } }).client;

    // pg.Client stores connection params on connectionParameters
    expect(pgClient.connectionParameters.ssl).toEqual({ rejectUnauthorized: false });

    controller.abort();
  });

  it('does not request ssl on the pg.Client when ssl is unset', () => {
    const controller = new AbortController();
    const listener = new HostsListener(createMockDbConfig(), () => {}, controller.signal);
    const pgClient = (listener as unknown as { client: { connectionParameters: any } }).client;
    // pg defaults connection ssl to false (not undefined) when no ssl key is
    // passed; the important thing is that we don't accidentally enable TLS.
    expect(pgClient.connectionParameters.ssl).toBeFalsy();
    controller.abort();
  });

  describe('reconnect', () => {
    const originalConsoleInfo = console.info;
    let setTimeoutSpy: ReturnType<typeof spyOn>;

    beforeEach(() => {
      console.info = mock(() => {});
      // Fire backoff timers immediately so the reconnect loop runs in
      // microtasks instead of waiting out real 500ms+ delays.
      setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
        cb: () => void,
      ) => {
        cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as never);
    });

    afterEach(() => {
      console.info = originalConsoleInfo;
      setTimeoutSpy.mockRestore();
    });

    // The reconnect chain (end old client, backoff sleep, connect, LISTEN,
    // reconcile dispatch) is pure microtasks once setTimeout fires
    // synchronously; one macrotask hop drains all of it.
    const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

    function createFakeClient(overrides: Record<string, unknown> = {}) {
      return {
        connect: mock(() => Promise.resolve()),
        query: mock(() => Promise.resolve({ rows: [] })),
        end: mock(() => Promise.resolve()),
        on: mock(() => {}),
        removeAllListeners: mock(() => {}),
        ...overrides,
      };
    }

    function setupListenerWithErrorCapture(handler: HostChangeHandler, signal: AbortSignal) {
      const listener = new HostsListener(createMockDbConfig(), handler, signal);
      let errorCb: ((err: Error) => void) | undefined;
      setupPgClientMocks(listener, (event, cb) => {
        if (event === 'error') errorCb = cb as typeof errorCb;
      });
      return { listener, getErrorCb: () => errorCb };
    }

    it('reconnects after a client error, re-issues LISTEN, and dispatches a reconcile', async () => {
      const handler: HostChangeHandler = mock(() => {});
      const controller = new AbortController();
      const { listener, getErrorCb } = setupListenerWithErrorCapture(handler, controller.signal);

      const fakeClient = createFakeClient();
      const createClientSpy = spyOn(
        listener as unknown as { createClient: () => unknown },
        'createClient',
      ).mockReturnValue(fakeClient);

      await listener.start();
      getErrorCb()!(new Error('server closed the connection unexpectedly'));
      await flush();

      expect(createClientSpy).toHaveBeenCalledTimes(1);
      expect(fakeClient.connect).toHaveBeenCalled();
      expect(fakeClient.query).toHaveBeenCalledWith('LISTEN managed_hosts_change');
      // Null payload forces a full reconcile to cover changes missed offline.
      expect(handler).toHaveBeenCalledWith(null);

      controller.abort();
      await listener[Symbol.asyncDispose]();
    });

    it('retries with backoff until a reconnect attempt succeeds', async () => {
      const handler: HostChangeHandler = mock(() => {});
      const controller = new AbortController();
      const { listener, getErrorCb } = setupListenerWithErrorCapture(handler, controller.signal);

      const failingClient = createFakeClient({
        connect: mock(() => Promise.reject(new Error('still down'))),
      });
      const workingClient = createFakeClient();
      const createClientSpy = spyOn(
        listener as unknown as { createClient: () => unknown },
        'createClient',
      )
        .mockReturnValueOnce(failingClient)
        .mockReturnValueOnce(workingClient);

      await listener.start();
      getErrorCb()!(new Error('lost conn'));
      await flush();

      expect(createClientSpy).toHaveBeenCalledTimes(2);
      // Failed attempt must close its half-open socket before retrying.
      expect(failingClient.end).toHaveBeenCalled();
      expect(workingClient.query).toHaveBeenCalledWith('LISTEN managed_hosts_change');
      expect(handler).toHaveBeenCalledWith(null);

      controller.abort();
      await listener[Symbol.asyncDispose]();
    });

    it('does not reconnect when the shutdown signal is already aborted', async () => {
      const controller = new AbortController();
      const { listener, getErrorCb } = setupListenerWithErrorCapture(() => {}, controller.signal);

      const createClientSpy = spyOn(
        listener as unknown as { createClient: () => unknown },
        'createClient',
      ).mockReturnValue(createFakeClient());

      await listener.start();
      controller.abort();
      getErrorCb()!(new Error('lost conn during shutdown'));
      await flush();

      expect(createClientSpy).not.toHaveBeenCalled();
      await listener[Symbol.asyncDispose]();
    });

    it('stops retrying when aborted during the backoff wait', async () => {
      const controller = new AbortController();
      const { listener, getErrorCb } = setupListenerWithErrorCapture(() => {}, controller.signal);

      const createClientSpy = spyOn(
        listener as unknown as { createClient: () => unknown },
        'createClient',
      ).mockReturnValue(createFakeClient());

      // Capture the backoff timer without firing it so the loop is parked
      // in abortableSleep when the shutdown signal arrives.
      setTimeoutSpy.mockImplementation(
        (() => 0 as unknown as ReturnType<typeof setTimeout>) as never,
      );

      await listener.start();
      getErrorCb()!(new Error('lost conn'));
      await flush();

      controller.abort();
      await flush();

      expect(createClientSpy).not.toHaveBeenCalled();
      await listener[Symbol.asyncDispose]();
    });

    it('ignores a second error event while a reconnect is already in flight', async () => {
      const handler: HostChangeHandler = mock(() => {});
      const controller = new AbortController();
      const { listener, getErrorCb } = setupListenerWithErrorCapture(handler, controller.signal);

      const fakeClient = createFakeClient();
      const createClientSpy = spyOn(
        listener as unknown as { createClient: () => unknown },
        'createClient',
      ).mockReturnValue(fakeClient);

      await listener.start();
      const errorCb = getErrorCb()!;
      errorCb(new Error('first failure'));
      errorCb(new Error('duplicate failure'));
      await flush();

      expect(createClientSpy).toHaveBeenCalledTimes(1);

      controller.abort();
      await listener[Symbol.asyncDispose]();
    });
  });
});
