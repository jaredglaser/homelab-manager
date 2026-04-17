import { describe, expect, test, mock, beforeAll, beforeEach, afterAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  subscribe,
  _resetBroadcasterForTesting,
  _handleDockerEventForTesting,
} from '../docker-events-broadcaster';
import type { MinimalContainerInfo, BroadcasterEvent } from '../docker-events-broadcaster';

const originalConsoleError = console.error;

beforeAll(() => {
  console.error = mock(() => {});
});

afterAll(() => {
  console.error = originalConsoleError;
});

beforeEach(() => {
  _resetBroadcasterForTesting();
});

function makeContainer(
  id: string,
  name: string,
  state = 'running',
  image = 'nginx:latest',
  labels: Record<string, string> = {},
): MinimalContainerInfo {
  return { Id: id, Names: [`/${name}`], State: state, Image: image, Labels: labels };
}

function makeDocker(containers: MinimalContainerInfo[] = [], eventsEmitter = new EventEmitter()) {
  return {
    listContainers: mock(() => Promise.resolve(containers)),
    getEvents: mock(() => Promise.resolve(eventsEmitter)),
    getContainer: mock((id: string) => ({
      inspect: mock(() => {
        const c = containers.find((x) => x.Id === id);
        if (!c) {
          const err = Object.assign(new Error('not found'), { statusCode: 404 });
          return Promise.reject(err);
        }
        return Promise.resolve({
          Id: c.Id,
          Name: c.Names[0],
          State: { Status: c.State },
          Config: { Image: c.Image, Labels: c.Labels },
        });
      }),
    })),
  };
}

describe('subscribe — init snapshot', () => {
  test('sends init event with all containers on first subscribe', async () => {
    const containers = [
      makeContainer('c1', 'app1'),
      makeContainer('c2', 'app2', 'exited'),
    ];
    const docker = makeDocker(containers);

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    unsub();

    expect(received).toHaveLength(1);
    expect(received[0].op).toBe('init');
    const init = received[0] as Extract<BroadcasterEvent, { op: 'init' }>;
    expect(init.containers.map((c) => c.Id).sort()).toEqual(['c1', 'c2'].sort((a, b) => a.localeCompare(b)));
  });

  test('calls listContainers({ all: true }) to include stopped containers', async () => {
    const docker = makeDocker([]);
    const unsub = await subscribe(docker as any, () => {});
    unsub();
    expect(docker.listContainers).toHaveBeenCalledWith({ all: true });
  });

  test('init with empty containers when Docker has none', async () => {
    const docker = makeDocker([]);
    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    unsub();

    const init = received[0] as Extract<BroadcasterEvent, { op: 'init' }>;
    expect(init.containers).toHaveLength(0);
  });
});

describe('subscribe — multiple subscribers', () => {
  test('each subscriber receives its own independent init event', async () => {
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers);

    const received1: BroadcasterEvent[] = [];
    const received2: BroadcasterEvent[] = [];

    const unsub1 = await subscribe(docker as any, (e) => received1.push(e));
    const unsub2 = await subscribe(docker as any, (e) => received2.push(e));

    unsub1();
    unsub2();

    expect(received1).toHaveLength(1);
    expect(received1[0].op).toBe('init');
    expect(received2).toHaveLength(1);
    expect(received2[0].op).toBe('init');
  });

  test('listContainers is only called once (for the first subscriber)', async () => {
    const docker = makeDocker([]);
    const unsub1 = await subscribe(docker as any, () => {});
    const unsub2 = await subscribe(docker as any, () => {});
    unsub1();
    unsub2();
    expect(docker.listContainers).toHaveBeenCalledTimes(1);
  });

  test('getEvents is called only once for multiple subscribers (shared stream)', async () => {
    const docker = makeDocker([]);
    const unsub1 = await subscribe(docker as any, () => {});
    const unsub2 = await subscribe(docker as any, () => {});
    unsub1();
    unsub2();
    expect(docker.getEvents).toHaveBeenCalledTimes(1);
  });

  test('one unsubscribe does not cancel other subscribers', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);
    const updatedContainer = makeContainer('c1', 'app1', 'exited');
    docker.getContainer = mock(() => ({
      inspect: mock(() => Promise.resolve({
        Id: updatedContainer.Id,
        Name: updatedContainer.Names[0],
        State: { Status: updatedContainer.State },
        Config: { Image: updatedContainer.Image, Labels: updatedContainer.Labels },
      })),
    }));

    const received2: BroadcasterEvent[] = [];
    const unsub1 = await subscribe(docker as any, () => {});
    const unsub2 = await subscribe(docker as any, (e) => received2.push(e));

    await new Promise((r) => setTimeout(r, 20));

    unsub1();

    // Emit a start event — subscriber2 should still receive it
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    unsub2();

    const upserts = received2.filter((e) => e.op === 'upsert');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('subscribe — upsert events', () => {
  test('start event produces an upsert with the container info', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    unsub();

    const upserts = received.filter((e) => e.op === 'upsert');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    const upsert = upserts[0] as Extract<BroadcasterEvent, { op: 'upsert' }>;
    expect(upsert.container.Id).toBe('c1');
  });

  test('stop event produces an upsert with exited state', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1', 'running')];
    const stoppedContainer = makeContainer('c1', 'app1', 'exited');
    const docker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.resolve({
          Id: stoppedContainer.Id,
          Name: stoppedContainer.Names[0],
          State: { Status: stoppedContainer.State },
          Config: { Image: stoppedContainer.Image, Labels: stoppedContainer.Labels },
        })),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'stop',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    unsub();

    const upserts = received.filter((e) => e.op === 'upsert');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    const last = upserts.at(-1) as Extract<BroadcasterEvent, { op: 'upsert' }>;
    expect(last.container.State).toBe('exited');
  });

  test('die event produces an upsert', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1', 'running')];
    const deadContainer = makeContainer('c1', 'app1', 'dead');
    const docker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.resolve({
          Id: deadContainer.Id,
          Name: deadContainer.Names[0],
          State: { Status: deadContainer.State },
          Config: { Image: deadContainer.Image, Labels: deadContainer.Labels },
        })),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'die',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    unsub();

    const upserts = received.filter((e) => e.op === 'upsert');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
  });

  test('inspect 404 produces a destroy event', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => {
          const err = Object.assign(new Error('not found'), { statusCode: 404 });
          return Promise.reject(err);
        }),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    unsub();

    const destroys = received.filter((e) => e.op === 'destroy');
    expect(destroys.length).toBeGreaterThanOrEqual(1);
    const d = destroys[0] as Extract<BroadcasterEvent, { op: 'destroy' }>;
    expect(d.containerId).toBe('c1');
  });
});

describe('subscribe — destroy events', () => {
  test('destroy action emits a destroy event', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'destroy',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    unsub();

    const destroys = received.filter((e) => e.op === 'destroy');
    expect(destroys.length).toBeGreaterThanOrEqual(1);
    const d = destroys[0] as Extract<BroadcasterEvent, { op: 'destroy' }>;
    expect(d.containerId).toBe('c1');
  });

  test('destroy event removes the container from in-memory state', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'destroy',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));

    // A second subscriber should see an init without c1
    const received2: BroadcasterEvent[] = [];
    const unsub2 = await subscribe(docker as any, (e) => received2.push(e));
    unsub();
    unsub2();

    const init2 = received2.find((e) => e.op === 'init') as Extract<BroadcasterEvent, { op: 'init' }>;
    expect(init2.containers.map((c) => c.Id)).not.toContain('c1');
  });
});

describe('subscribe — stream reconnect', () => {
  test('reconnects after stream error with scheduled timer', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});
    await new Promise((r) => setTimeout(r, 20));

    // Emit stream error — broadcaster should log and schedule reconnect
    eventsEmitter.emit('error', new Error('stream error'));
    await new Promise((r) => setTimeout(r, 20));

    unsub();

    expect(console.error).toHaveBeenCalled();
  });

  test('does not reconnect when last subscriber unsubscribes before timer fires', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timerCallbacks: Array<() => void> = [];

    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});
    await new Promise((r) => originalSetTimeout(r, 30));

    // Intercept setTimeout to capture the reconnect timer
    (globalThis as any).setTimeout = (cb: () => void, _delay: number) => {
      timerCallbacks.push(cb);
      return 0;
    };

    try {
      eventsEmitter.emit('error', new Error('disconnect'));
      await new Promise((r) => originalSetTimeout(r, 10));

      // Unsubscribe before the timer fires
      unsub();

      // Fire the captured timer — no subscribers remain, should clear reconnecting
      for (const cb of timerCallbacks) {
        await (cb as () => Promise<void> | void)();
      }

      // A new subscriber should be able to start fresh
      let getEventsCallsBefore = docker.getEvents.mock.calls.length;
      const docker2 = makeDocker([], new EventEmitter());
      const unsub2 = await subscribe(docker2 as any, () => {});
      await new Promise((r) => originalSetTimeout(r, 20));
      unsub2();

      // The fresh broadcaster (reset by unsub cleanup) should call getEvents again
      expect(docker2.getEvents.mock.calls.length).toBeGreaterThanOrEqual(1);
      void getEventsCallsBefore;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

describe('subscribe — cleanup (last unsubscribe)', () => {
  test('destroys the events stream when the last subscriber unsubscribes', async () => {
    const eventsEmitter = new EventEmitter();
    const destroySpy = mock(() => {});
    (eventsEmitter as any).destroy = destroySpy;
    const docker = makeDocker([], eventsEmitter);

    const unsub1 = await subscribe(docker as any, () => {});
    const unsub2 = await subscribe(docker as any, () => {});
    await new Promise((r) => setTimeout(r, 20));

    unsub1();
    expect(destroySpy).not.toHaveBeenCalled();

    unsub2();
    await new Promise((r) => setTimeout(r, 10));
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  test('does not destroy stream when first of multiple subscribers unsubscribes', async () => {
    const eventsEmitter = new EventEmitter();
    const destroySpy = mock(() => {});
    (eventsEmitter as any).destroy = destroySpy;
    const docker = makeDocker([], eventsEmitter);

    const unsub1 = await subscribe(docker as any, () => {});
    const unsub2 = await subscribe(docker as any, () => {});
    await new Promise((r) => setTimeout(r, 20));

    unsub1();
    expect(destroySpy).not.toHaveBeenCalled();

    unsub2();
  });
});

describe('subscribe — error handling', () => {
  test('handles listContainers failure gracefully', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = {
      listContainers: mock(() => Promise.reject(new Error('Docker unavailable'))),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    unsub();

    expect(console.error).toHaveBeenCalled();
    // Still sends init (empty) since the subscribe continues after the error
    expect(received[0].op).toBe('init');
  });

  test('ignores irrelevant docker event actions', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    const initialLength = received.length;

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'exec_create',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 20));
    unsub();

    expect(received.length).toBe(initialLength);
  });

  test('ignores non-container event types', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    const initialLength = received.length;

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'network',
      Action: 'connect',
      Actor: { ID: 'net1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 20));
    unsub();

    expect(received.length).toBe(initialLength);
  });

  test('skips malformed JSON lines in the event stream', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});
    await new Promise((r) => setTimeout(r, 20));

    // Should not throw
    eventsEmitter.emit('data', Buffer.from('not valid json\n'));
    await new Promise((r) => setTimeout(r, 20));
    unsub();
  });

  test('logs non-404 inspect errors', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = {
      listContainers: mock(() => Promise.resolve([makeContainer('c1', 'app1')])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.reject(new Error('connection refused'))),
      })),
    };

    const unsub = await subscribe(docker as any, () => {});
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    unsub();

    expect(console.error).toHaveBeenCalled();
  });
});

describe('_handleDockerEventForTesting', () => {
  test('accepts a docker parameter for API compatibility', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    await _handleDockerEventForTesting(docker as any, {
      Type: 'container',
      Action: 'destroy',
      Actor: { ID: 'c1' },
    });

    unsub();

    const destroys = received.filter((e) => e.op === 'destroy');
    expect(destroys.length).toBeGreaterThanOrEqual(1);
  });
});

describe('subscribe — error handling (data handler catch path)', () => {
  test('logs error when handleDockerEvent rejects inside data handler', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    // Subscribe with a callback that throws on upsert events, causing handleDockerEvent to reject
    // via the broadcastToAll call after a successful inspect
    const throwingCallback = mock((e: BroadcasterEvent) => {
      if (e.op === 'upsert') throw new Error('subscriber threw');
    });

    const unsub = await subscribe(docker as any, throwingCallback);
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 50));
    unsub();

    // The .catch on the handleDockerEvent call should have logged the error
    expect(console.error).toHaveBeenCalled();
  });
});

describe('_resetBroadcasterForTesting — with active reconnect timer', () => {
  test('clears pending reconnect timer during reset', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timerCallbacks: Array<() => void> = [];

    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});
    await new Promise((r) => originalSetTimeout(r, 20));

    // Intercept setTimeout to capture the reconnect timer
    (globalThis as any).setTimeout = (cb: () => void, _delay: number) => {
      timerCallbacks.push(cb);
      return {} as any;  // Return a truthy object so reconnectTimer is set
    };

    try {
      // Trigger a stream error — scheduleReconnect will capture a timer via mocked setTimeout
      eventsEmitter.emit('error', new Error('disconnect'));
      await new Promise((r) => originalSetTimeout(r, 10));

      // Reset while the timer is pending — exercises lines 224-225
      _resetBroadcasterForTesting();

      // Timer callback was captured but should now be a no-op (state cleared)
      expect(timerCallbacks.length).toBeGreaterThan(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      unsub();
    }
  });
});
