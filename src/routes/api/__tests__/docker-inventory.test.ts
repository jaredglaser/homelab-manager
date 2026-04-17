import { describe, it, expect, mock, beforeAll } from 'bun:test';
import type { DockerInventoryBroadcastEvent } from '@/types/docker-inventory';

// ---------------------------------------------------------------------------
// Mock server-init and the broadcast service so the handler never touches
// a real database or pool. Both modules are narrow-scope (not React or
// broad barrel exports), so mock.module() is safe here.
// ---------------------------------------------------------------------------

type SubscribeCallback = (event: DockerInventoryBroadcastEvent) => void;

/** Mutable reference the broadcast service mock reads at call time. */
let currentCallback: SubscribeCallback | null = null;
const unsubscribeMock = mock(() => { currentCallback = null; });
const subscribeMock = mock((cb: SubscribeCallback) => {
  currentCallback = cb;
  return unsubscribeMock;
});

beforeAll(() => {
  mock.module('@/lib/server-init', () => ({}));
  mock.module('@/lib/docker/docker-inventory-broadcast-service', () => ({
    dockerInventoryBroadcastService: { subscribe: subscribeMock },
    rowToInventory: () => ({}),
    notifyPayloadToInventory: () => ({}),
    DockerInventoryBroadcastService: class {},
    DockerInventoryBroadcastServiceDeps: undefined,
  }));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emit(event: DockerInventoryBroadcastEvent) {
  currentCallback?.(event);
}

function makeAbortController() {
  const ac = new AbortController();
  return ac;
}

async function getHandler() {
  const { Route } = await import('@/routes/api/docker-inventory');
  const handlers = Route.options.server?.handlers as Record<string, (ctx: { request: Request }) => Promise<Response>>;
  return handlers?.['GET'];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /api/docker-inventory handler', () => {
  it('subscribes to the broadcast service and returns SSE response', async () => {
    subscribeMock.mockClear();
    const handler = await getHandler();
    expect(handler).toBeDefined();

    const ac = makeAbortController();
    const request = new Request('http://localhost/api/docker-inventory', {
      signal: ac.signal,
    });

    const response = await handler({ request });

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
    expect(subscribeMock).toHaveBeenCalledTimes(1);

    ac.abort();
  });

  it('forwards broadcast events as SSE data lines', async () => {
    const handler = await getHandler();

    const ac = makeAbortController();
    const request = new Request('http://localhost/api/docker-inventory', {
      signal: ac.signal,
    });

    const response = await handler({ request });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const initEvent: DockerInventoryBroadcastEvent = {
      type: 'init',
      containers: [],
    };

    emit(initEvent);

    const { value } = await reader.read();
    const text = decoder.decode(value);
    expect(text).toBe(`data: ${JSON.stringify(initEvent)}\n\n`);

    ac.abort();
    reader.cancel();
  });

  it('unsubscribes and closes stream on request abort', async () => {
    unsubscribeMock.mockClear();
    const handler = await getHandler();

    const ac = makeAbortController();
    const request = new Request('http://localhost/api/docker-inventory', {
      signal: ac.signal,
    });

    await handler({ request });

    ac.abort();

    // Unsubscribe is called synchronously in the abort handler
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it('does not enqueue after stream is closed', async () => {
    const handler = await getHandler();

    const ac = makeAbortController();
    const request = new Request('http://localhost/api/docker-inventory', {
      signal: ac.signal,
    });

    const response = await handler({ request });
    const reader = response.body!.getReader();

    ac.abort();

    // Emitting after abort must not throw
    expect(() => {
      emit({ type: 'init', containers: [] });
    }).not.toThrow();

    reader.cancel();
  });
});
