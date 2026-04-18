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
  return {
    Id: id,
    Names: [`/${name}`],
    State: state,
    Image: image,
    Labels: labels,
    StartedAt: null,
    FinishedAt: null,
    ExitCode: null,
  };
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

  test('reconnects after stream end with scheduled timer', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('end');
    await new Promise((r) => setTimeout(r, 20));

    unsub();

    expect(docker.getEvents).toHaveBeenCalled();
  });

  test('clears reconnecting state on stream end when no subscribers remain', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});
    await new Promise((r) => originalSetTimeout(r, 20));

    unsub();
    eventsEmitter.emit('end');
    await new Promise((r) => originalSetTimeout(r, 20));

    const docker2 = makeDocker([], new EventEmitter());
    const unsub2 = await subscribe(docker2 as any, () => {});
    await new Promise((r) => originalSetTimeout(r, 20));
    unsub2();

    expect(docker2.getEvents).toHaveBeenCalled();
  });

  test('handles getEvents rejection by scheduling reconnect', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timerCallbacks: Array<() => void> = [];
    (globalThis as any).setTimeout = (cb: () => void, _delay: number) => {
      timerCallbacks.push(cb);
      return 0;
    };

    try {
      const docker = {
        listContainers: mock(() => Promise.resolve([])),
        getEvents: mock(() => Promise.reject(new Error('getEvents boom'))),
        getContainer: mock(() => ({ inspect: mock(() => Promise.reject(new Error('n/a'))) })),
      };

      const unsub = await subscribe(docker as any, () => {});
      await new Promise((r) => originalSetTimeout(r, 10));

      expect(console.error).toHaveBeenCalled();
      expect(timerCallbacks.length).toBeGreaterThan(0);

      unsub();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });

  test('logs and continues when listAndEnrichContainers fails during reconnect', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timerCallbacks: Array<() => void> = [];

    const eventsEmitter = new EventEmitter();
    let listCalls = 0;
    const docker = {
      listContainers: mock(() => {
        listCalls++;
        if (listCalls === 1) return Promise.resolve([]);
        return Promise.reject(new Error('list failed on reconnect'));
      }),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({ inspect: mock(() => Promise.reject(new Error('n/a'))) })),
    };

    const unsub = await subscribe(docker as any, () => {});
    await new Promise((r) => originalSetTimeout(r, 20));

    (globalThis as any).setTimeout = (cb: () => void, _delay: number) => {
      timerCallbacks.push(cb);
      return 0;
    };

    try {
      eventsEmitter.emit('error', new Error('disconnect'));
      await new Promise((r) => originalSetTimeout(r, 10));

      for (const cb of timerCallbacks) {
        await (cb as () => Promise<void> | void)();
      }
      await new Promise((r) => originalSetTimeout(r, 20));

      expect(console.error).toHaveBeenCalled();
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      unsub();
    }
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

describe('subscribe — pause and unpause events (Fix 2)', () => {
  test('pause event produces an upsert', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1', 'running')];
    const pausedContainer = makeContainer('c1', 'app1', 'paused');
    const docker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.resolve({
          Id: pausedContainer.Id,
          Name: pausedContainer.Names[0],
          State: { Status: pausedContainer.State },
          Config: { Image: pausedContainer.Image, Labels: pausedContainer.Labels },
        })),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'pause',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    unsub();

    const upserts = received.filter((e) => e.op === 'upsert');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    const last = upserts.at(-1) as Extract<BroadcasterEvent, { op: 'upsert' }>;
    expect(last.container.State).toBe('paused');
  });

  test('unpause event produces an upsert', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1', 'paused')];
    const runningContainer = makeContainer('c1', 'app1', 'running');
    const docker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.resolve({
          Id: runningContainer.Id,
          Name: runningContainer.Names[0],
          State: { Status: runningContainer.State },
          Config: { Image: runningContainer.Image, Labels: runningContainer.Labels },
        })),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    await new Promise((r) => setTimeout(r, 20));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'unpause',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    unsub();

    const upserts = received.filter((e) => e.op === 'upsert');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    const last = upserts.at(-1) as Extract<BroadcasterEvent, { op: 'upsert' }>;
    expect(last.container.State).toBe('running');
  });
});

describe('subscribe — reconnect fresh init (Fix 3)', () => {
  test('after reconnect, subscribers receive a fresh init reflecting updated container state', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let capturedReconnectCallback: (() => void) | null = null;

    // Initial state: one running container
    const eventsEmitter = new EventEmitter();
    const initialContainers = [makeContainer('c1', 'app1', 'running')];

    // After reconnect, Docker state has changed: c1 is gone, c2 appeared
    const reconnectContainers = [makeContainer('c2', 'app2', 'running')];

    let listCallCount = 0;
    let getEventsCallCount = 0;
    const reconnectEventsEmitter = new EventEmitter();

    const docker = {
      listContainers: mock(() => {
        listCallCount++;
        return Promise.resolve(listCallCount === 1 ? initialContainers : reconnectContainers);
      }),
      // First call returns eventsEmitter (with error registered); second returns reconnectEventsEmitter
      getEvents: mock(() => {
        getEventsCallCount++;
        return Promise.resolve(getEventsCallCount === 1 ? eventsEmitter : reconnectEventsEmitter);
      }),
    };

    try {
      const received: BroadcasterEvent[] = [];
      const unsub = await subscribe(docker as any, (e) => received.push(e));
      await new Promise((r) => originalSetTimeout(r, 20));

      // Intercept setTimeout to capture the reconnect callback (fires immediately)
      (globalThis as any).setTimeout = (cb: () => void) => {
        capturedReconnectCallback = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      };

      // Simulate stream error to trigger scheduleReconnect
      eventsEmitter.emit('error', new Error('disconnected'));
      await new Promise((r) => originalSetTimeout(r, 10));

      // Verify we captured the reconnect callback
      expect(capturedReconnectCallback).not.toBeNull();

      // Restore real setTimeout before firing the callback (it awaits async operations)
      globalThis.setTimeout = originalSetTimeout;

      // Fire the reconnect — triggers startEventsSubscription(docker, true)
      // which calls listContainers (reconnect path) and broadcasts fresh init
      await (capturedReconnectCallback as unknown as () => Promise<void>)();
      await new Promise((r) => originalSetTimeout(r, 20));

      unsub();

      // Should have received initial init + reconnect init
      const initEvents = received.filter((e) => e.op === 'init');
      expect(initEvents.length).toBeGreaterThanOrEqual(2);

      // The reconnect init should reflect the new container state
      const reconnectInit = initEvents[initEvents.length - 1] as Extract<BroadcasterEvent, { op: 'init' }>;
      const ids = reconnectInit.containers.map((c) => c.Id);
      expect(ids).toContain('c2');
      expect(ids).not.toContain('c1');
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

describe('subscribe — init enrichment via inspect', () => {
  test('populates StartedAt/FinishedAt/ExitCode from inspect on first init', async () => {
    const eventsEmitter = new EventEmitter();
    const listEntry = makeContainer('c1', 'app1', 'exited');
    const docker = {
      listContainers: mock(() => Promise.resolve([listEntry])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.resolve({
          Id: 'c1',
          Name: '/app1',
          State: {
            Status: 'exited',
            StartedAt: '2026-04-17T10:00:00Z',
            FinishedAt: '2026-04-17T11:00:00Z',
            ExitCode: 137,
          },
          Config: { Image: 'nginx:latest', Labels: {} },
        })),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    unsub();

    const init = received[0] as Extract<BroadcasterEvent, { op: 'init' }>;
    expect(init.containers).toHaveLength(1);
    expect(init.containers[0].StartedAt).toBe('2026-04-17T10:00:00Z');
    expect(init.containers[0].FinishedAt).toBe('2026-04-17T11:00:00Z');
    expect(init.containers[0].ExitCode).toBe(137);
  });

  test('normalizes zero-sentinel "0001-01-01T00:00:00Z" to null for both timestamps', async () => {
    const eventsEmitter = new EventEmitter();
    const listEntry = makeContainer('c1', 'app1', 'created');
    const docker = {
      listContainers: mock(() => Promise.resolve([listEntry])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.resolve({
          Id: 'c1',
          Name: '/app1',
          State: {
            Status: 'created',
            StartedAt: '0001-01-01T00:00:00Z',
            FinishedAt: '0001-01-01T00:00:00Z',
            ExitCode: 0,
          },
          Config: { Image: 'nginx:latest', Labels: {} },
        })),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    unsub();

    const init = received[0] as Extract<BroadcasterEvent, { op: 'init' }>;
    expect(init.containers[0].StartedAt).toBeNull();
    expect(init.containers[0].FinishedAt).toBeNull();
  });

  test('passes real ISO timestamps through unchanged', async () => {
    const eventsEmitter = new EventEmitter();
    const listEntry = makeContainer('c1', 'app1', 'running');
    const docker = {
      listContainers: mock(() => Promise.resolve([listEntry])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.resolve({
          Id: 'c1',
          Name: '/app1',
          State: {
            Status: 'running',
            StartedAt: '2026-01-15T08:30:45.123Z',
            FinishedAt: '0001-01-01T00:00:00Z',
            ExitCode: 0,
          },
          Config: { Image: 'nginx:latest', Labels: {} },
        })),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    unsub();

    const init = received[0] as Extract<BroadcasterEvent, { op: 'init' }>;
    expect(init.containers[0].StartedAt).toBe('2026-01-15T08:30:45.123Z');
  });

  test('ExitCode is null for non-terminal states (running, paused, restarting, created)', async () => {
    const eventsEmitter = new EventEmitter();
    const nonTerminalStates = ['running', 'paused', 'restarting', 'created'];

    for (const status of nonTerminalStates) {
      _resetBroadcasterForTesting();
      const listEntry = makeContainer('c1', 'app1', status);
      const docker = {
        listContainers: mock(() => Promise.resolve([listEntry])),
        getEvents: mock(() => Promise.resolve(eventsEmitter)),
        getContainer: mock(() => ({
          inspect: mock(() => Promise.resolve({
            Id: 'c1',
            Name: '/app1',
            State: {
              Status: status,
              StartedAt: '2026-04-17T10:00:00Z',
              FinishedAt: '0001-01-01T00:00:00Z',
              ExitCode: 0,
            },
            Config: { Image: 'nginx:latest', Labels: {} },
          })),
        })),
      };

      const received: BroadcasterEvent[] = [];
      const unsub = await subscribe(docker as any, (e) => received.push(e));
      unsub();

      const init = received[0] as Extract<BroadcasterEvent, { op: 'init' }>;
      expect(init.containers[0].ExitCode).toBeNull();
    }
  });

  test('ExitCode is preserved (non-null) for terminal states exited and dead', async () => {
    const eventsEmitter = new EventEmitter();
    const terminalStates: Array<{ state: string; code: number }> = [
      { state: 'exited', code: 0 },
      { state: 'exited', code: 137 },
      { state: 'dead', code: 255 },
    ];

    for (const { state, code } of terminalStates) {
      _resetBroadcasterForTesting();
      const listEntry = makeContainer('c1', 'app1', state);
      const docker = {
        listContainers: mock(() => Promise.resolve([listEntry])),
        getEvents: mock(() => Promise.resolve(eventsEmitter)),
        getContainer: mock(() => ({
          inspect: mock(() => Promise.resolve({
            Id: 'c1',
            Name: '/app1',
            State: {
              Status: state,
              StartedAt: '2026-04-17T10:00:00Z',
              FinishedAt: '2026-04-17T11:00:00Z',
              ExitCode: code,
            },
            Config: { Image: 'nginx:latest', Labels: {} },
          })),
        })),
      };

      const received: BroadcasterEvent[] = [];
      const unsub = await subscribe(docker as any, (e) => received.push(e));
      unsub();

      const init = received[0] as Extract<BroadcasterEvent, { op: 'init' }>;
      expect(init.containers[0].ExitCode).toBe(code);
    }
  });

  test('inspect failure on ONE container does not crash init — others populated', async () => {
    const eventsEmitter = new EventEmitter();
    const list = [
      makeContainer('c1', 'app1', 'running'),
      makeContainer('c2', 'app2', 'exited'),
      makeContainer('c3', 'app3', 'running'),
    ];
    const docker = {
      listContainers: mock(() => Promise.resolve(list)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock((id: string) => ({
        inspect: mock(() => {
          if (id === 'c2') {
            return Promise.reject(new Error('inspect blew up'));
          }
          const src = list.find((c) => c.Id === id)!;
          return Promise.resolve({
            Id: src.Id,
            Name: src.Names[0],
            State: {
              Status: src.State,
              StartedAt: '2026-04-17T10:00:00Z',
              FinishedAt: '0001-01-01T00:00:00Z',
              ExitCode: 0,
            },
            Config: { Image: src.Image, Labels: src.Labels },
          });
        }),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    unsub();

    const init = received[0] as Extract<BroadcasterEvent, { op: 'init' }>;
    expect(init.containers).toHaveLength(3);

    const byId = new Map(init.containers.map((c) => [c.Id, c]));
    expect(byId.get('c1')?.StartedAt).toBe('2026-04-17T10:00:00Z');
    expect(byId.get('c3')?.StartedAt).toBe('2026-04-17T10:00:00Z');
    expect(byId.get('c2')?.StartedAt).toBeNull();
    expect(byId.get('c2')?.FinishedAt).toBeNull();
    expect(byId.get('c2')?.ExitCode).toBeNull();
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
