import { describe, test, expect, beforeEach, afterEach, mock, spyOn, type Mock } from 'bun:test';
import { startMockServiceWorker } from '@/lib/mock/start';

interface MockedResponseEvent {
  response: { body: { cancel: () => Promise<void> } | null };
}

type ResponseMockedHandler = (event: MockedResponseEvent) => void;

interface WorkerStartOptions {
  serviceWorker: { url: string };
  onUnhandledRequest: string;
  quiet: boolean;
}

const workerStart = mock(async (_options: WorkerStartOptions): Promise<void> => {});
const workerEventsOn = mock((_event: string, _handler: ResponseMockedHandler): void => {});

mock.module('@/lib/mock/browser', () => ({
  worker: { start: workerStart, events: { on: workerEventsOn } },
}));

const TAKEOVER_RELOAD_KEY = 'msw:takeover-reload';
const ENV_KEYS = ['BASE_URL', 'VITE_ENABLE_MSW', 'VITE_DEMO_MODE'] as const;
const env = import.meta.env as unknown as Record<string, string | undefined>;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('startMockServiceWorker', () => {
  let addEventListener: Mock<(type: string, handler: () => void, options?: { once?: boolean }) => void>;
  let controllerChange: (() => void) | undefined;
  let listenerRegistered: { promise: Promise<void>; resolve: () => void };
  let serviceWorker: { controller: object | null; addEventListener: typeof addEventListener };
  let reload: Mock<() => void>;
  let consoleError: Mock<typeof console.error>;
  let timeoutSpy: Mock<typeof setTimeout> | undefined;
  let savedEnv: Record<string, string | undefined>;

  function setController(controller: object | null): void {
    serviceWorker.controller = controller;
  }

  function stubTimeout(mode: 'immediate' | 'never'): void {
    timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
    ): ReturnType<typeof setTimeout> => {
      if (mode === 'immediate') callback();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  }

  beforeEach(() => {
    workerStart.mockClear();
    workerEventsOn.mockClear();
    sessionStorage.clear();

    controllerChange = undefined;
    listenerRegistered = deferred();
    addEventListener = mock((type: string, handler: () => void) => {
      if (type !== 'controllerchange') return;
      controllerChange = handler;
      listenerRegistered.resolve();
    });
    serviceWorker = { controller: null, addEventListener };
    Object.defineProperty(navigator, 'serviceWorker', {
      value: serviceWorker,
      configurable: true,
      writable: true,
    });

    reload = mock(() => {});
    Object.defineProperty(window.location, 'reload', {
      value: reload,
      configurable: true,
      writable: true,
    });

    consoleError = spyOn(console, 'error').mockImplementation(() => {});

    savedEnv = {};
    for (const key of ENV_KEYS) {
      savedEnv[key] = env[key];
      delete env[key];
    }
  });

  afterEach(() => {
    timeoutSpy?.mockRestore();
    timeoutSpy = undefined;
    consoleError.mockRestore();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete env[key];
      else env[key] = savedEnv[key];
    }
  });

  test('registers the worker script at the origin root when no base path is set', async () => {
    setController({});

    await startMockServiceWorker();

    expect(workerStart).toHaveBeenCalledTimes(1);
    const options = workerStart.mock.calls[0][0];
    expect(options.serviceWorker.url).toBe('/mockServiceWorker.js');
    expect(options.onUnhandledRequest).toBe('bypass');
    expect(options.quiet).toBe(true);
  });

  test('registers the worker script under the deploy base path', async () => {
    setController({});
    env.BASE_URL = '/homelab/';

    await startMockServiceWorker();

    expect(workerStart.mock.calls[0][0].serviceWorker.url).toBe('/homelab/mockServiceWorker.js');
  });

  test('drains the teed body of every mocked response', async () => {
    setController({});

    await startMockServiceWorker();

    expect(workerEventsOn).toHaveBeenCalledTimes(1);
    expect(workerEventsOn.mock.calls[0][0]).toBe('response:mocked');

    const handler = workerEventsOn.mock.calls[0][1];
    const cancel = mock(async () => {});
    handler({ response: { body: { cancel } } });
    expect(cancel).toHaveBeenCalledTimes(1);

    expect(() => handler({ response: { body: null } })).not.toThrow();
  });

  test('swallows a cancel that rejects because the consumer already closed the body', async () => {
    setController({});

    await startMockServiceWorker();
    const handler = workerEventsOn.mock.calls[0][1];

    let failCancel!: (error: Error) => void;
    const cancelled = new Promise<void>((_resolve, reject) => {
      failCancel = reject;
    });

    expect(() => handler({ response: { body: { cancel: () => cancelled } } })).not.toThrow();
    failCancel(new Error('stream already cancelled'));

    await cancelled.catch(() => {});
  });

  test('skips the takeover wait when the worker already controls the page', async () => {
    setController({});
    stubTimeout('never');

    await startMockServiceWorker();

    expect(addEventListener).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('resolves without waiting when the environment exposes no service worker', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: undefined,
      configurable: true,
      writable: true,
    });
    stubTimeout('never');

    await startMockServiceWorker();

    expect(workerStart).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalled();
  });

  test('stays pending until the worker takes control of the page', async () => {
    stubTimeout('never');

    let settled = false;
    const started = startMockServiceWorker().then(() => {
      settled = true;
    });

    await listenerRegistered.promise;
    expect(settled).toBe(false);

    setController({});
    controllerChange?.();
    await started;

    expect(consoleError).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  test('gives up after the 3-second safety net when controllerchange never fires', async () => {
    env.VITE_DEMO_MODE = 'true';
    stubTimeout('immediate');

    await startMockServiceWorker();

    expect(timeoutSpy?.mock.calls[0][1]).toBe(3000);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  test('fails the MSW e2e build instead of degrading to the real backend', async () => {
    env.VITE_ENABLE_MSW = 'true';
    stubTimeout('immediate');

    await expect(startMockServiceWorker()).rejects.toThrow(/never took control/);
    expect(reload).not.toHaveBeenCalled();
  });

  test('reloads a demo tab once, then leaves it alone', async () => {
    env.VITE_DEMO_MODE = 'true';
    stubTimeout('immediate');

    await startMockServiceWorker();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(TAKEOVER_RELOAD_KEY)).toBe('1');

    await startMockServiceWorker();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('leaves a non-demo, non-e2e build unreloaded and unthrown', async () => {
    stubTimeout('immediate');

    await startMockServiceWorker();

    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(TAKEOVER_RELOAD_KEY)).toBeNull();
  });

  test('does not reload when sessionStorage is unavailable', async () => {
    env.VITE_DEMO_MODE = 'true';
    stubTimeout('immediate');
    const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('sessionStorage is disabled');
      },
    });

    try {
      await startMockServiceWorker();
      expect(reload).not.toHaveBeenCalled();
    } finally {
      if (original) Object.defineProperty(globalThis, 'sessionStorage', original);
      else Reflect.deleteProperty(globalThis, 'sessionStorage');
    }
  });
});
