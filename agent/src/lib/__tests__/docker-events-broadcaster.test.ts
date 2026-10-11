import { describe, expect, test, mock, beforeAll, beforeEach, afterAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import type Dockerode from 'dockerode';
import {
  subscribe,
  _resetBroadcasterForTesting,
  _handleDockerEventForTesting,
  normalizePorts,
  normalizeMounts,
  portCandidatesFromInspect,
  portCandidatesFromList,
} from '../docker-events-broadcaster';
import type { MinimalContainerInfo, BroadcasterEvent } from '../docker-events-broadcaster';
import { waitForCondition } from '../test/wait-for-condition';

const originalConsoleError = console.error;

beforeAll(() => {
  console.error = mock(() => {});
});

afterAll(() => {
  console.error = originalConsoleError;
});

beforeEach(() => {
  _resetBroadcasterForTesting();
  (console.error as ReturnType<typeof mock>).mockClear();
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
    Ports: [],
    Mounts: [],
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

describe('subscribe: init snapshot', () => {
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

describe('subscribe: multiple subscribers', () => {
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
    unsub1();

    // Emit a start event; subscriber2 should still receive it
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => received2.some((e) => e.op === 'upsert'));
    unsub2();

    const upserts = received2.filter((e) => e.op === 'upsert');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('subscribe: upsert events', () => {
  test('start event produces an upsert with the container info', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => received.some((e) => e.op === 'upsert'));
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
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'stop',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => received.some((e) => e.op === 'upsert'));
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
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'die',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => received.some((e) => e.op === 'upsert'));
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
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => received.some((e) => e.op === 'destroy'));
    unsub();

    const destroys = received.filter((e) => e.op === 'destroy');
    expect(destroys.length).toBeGreaterThanOrEqual(1);
    const d = destroys[0] as Extract<BroadcasterEvent, { op: 'destroy' }>;
    expect(d.containerId).toBe('c1');
  });
});

describe('subscribe: destroy events', () => {
  test('destroy action emits a destroy event', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'destroy',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => received.some((e) => e.op === 'destroy'));
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
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'destroy',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => received.some((e) => e.op === 'destroy'));

    // A second subscriber should see an init without c1
    const received2: BroadcasterEvent[] = [];
    const unsub2 = await subscribe(docker as any, (e) => received2.push(e));
    unsub();
    unsub2();

    const init2 = received2.find((e) => e.op === 'init') as Extract<BroadcasterEvent, { op: 'init' }>;
    expect(init2.containers.map((c) => c.Id)).not.toContain('c1');
  });
});

describe('subscribe: stream reconnect', () => {
  test('reconnects after stream error with scheduled timer', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});

    // Emit stream error; broadcaster should log and schedule reconnect
    eventsEmitter.emit('error', new Error('stream error'));
    await waitForCondition(() => (console.error as ReturnType<typeof mock>).mock.calls.length > 0);

    unsub();

    expect(console.error).toHaveBeenCalled();
  });

  test('reconnects after stream end with scheduled timer', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});

    eventsEmitter.emit('end');
    await waitForCondition(() => (console.error as ReturnType<typeof mock>).mock.calls.length > 0);

    unsub();

    expect(docker.getEvents).toHaveBeenCalled();
  });

  test('clears reconnecting state on stream end when no subscribers remain', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});
    unsub();
    eventsEmitter.emit('end');

    const docker2 = makeDocker([], new EventEmitter());
    const unsub2 = await subscribe(docker2 as any, () => {});
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
      await waitForCondition(() => (console.error as ReturnType<typeof mock>).mock.calls.length > 0);

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

    (globalThis as any).setTimeout = (cb: () => void, _delay: number) => {
      timerCallbacks.push(cb);
      return 0;
    };

    try {
      eventsEmitter.emit('error', new Error('disconnect'));
      await waitForCondition(() => (console.error as ReturnType<typeof mock>).mock.calls.length > 0);

      for (const cb of timerCallbacks) {
        await (cb as () => Promise<void> | void)();
      }

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

    // Intercept setTimeout to capture the reconnect timer
    (globalThis as any).setTimeout = (cb: () => void, _delay: number) => {
      timerCallbacks.push(cb);
      return 0;
    };

    try {
      eventsEmitter.emit('error', new Error('disconnect'));
      await waitForCondition(() => (console.error as ReturnType<typeof mock>).mock.calls.length > 0);

      // Unsubscribe before the timer fires
      unsub();

      // Fire the captured timer; no subscribers remain, should clear reconnecting
      for (const cb of timerCallbacks) {
        await (cb as () => Promise<void> | void)();
      }

      // A new subscriber should be able to start fresh
      let getEventsCallsBefore = docker.getEvents.mock.calls.length;
      const docker2 = makeDocker([], new EventEmitter());
      const unsub2 = await subscribe(docker2 as any, () => {});
      unsub2();

      // The fresh broadcaster (reset by unsub cleanup) should call getEvents again
      expect(docker2.getEvents.mock.calls.length).toBeGreaterThanOrEqual(1);
      void getEventsCallsBefore;
    } finally {
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});

describe('subscribe: cleanup (last unsubscribe)', () => {
  test('destroys the events stream when the last subscriber unsubscribes', async () => {
    const eventsEmitter = new EventEmitter();
    const destroySpy = mock(() => {});
    (eventsEmitter as any).destroy = destroySpy;
    const docker = makeDocker([], eventsEmitter);

    const unsub1 = await subscribe(docker as any, () => {});
    const unsub2 = await subscribe(docker as any, () => {});

    unsub1();
    expect(destroySpy).not.toHaveBeenCalled();

    unsub2();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  test('does not destroy stream when first of multiple subscribers unsubscribes', async () => {
    const eventsEmitter = new EventEmitter();
    const destroySpy = mock(() => {});
    (eventsEmitter as any).destroy = destroySpy;
    const docker = makeDocker([], eventsEmitter);

    const unsub1 = await subscribe(docker as any, () => {});
    const unsub2 = await subscribe(docker as any, () => {});

    unsub1();
    expect(destroySpy).not.toHaveBeenCalled();

    unsub2();
  });
});

describe('subscribe: error handling', () => {
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

    const initialLength = received.length;

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'exec_create',
      Actor: { ID: 'c1' },
    }) + '\n'));
    unsub();

    expect(received.length).toBe(initialLength);
  });

  test('ignores non-container event types', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));

    const initialLength = received.length;

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'network',
      Action: 'connect',
      Actor: { ID: 'net1' },
    }) + '\n'));
    unsub();

    expect(received.length).toBe(initialLength);
  });

  test('skips malformed JSON lines in the event stream', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});

    // Should not throw
    eventsEmitter.emit('data', Buffer.from('not valid json\n'));
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
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => (console.error as ReturnType<typeof mock>).mock.calls.length > 0);
    unsub();
  });
});

describe('broadcastToAll: subscriber isolation', () => {
  test('a throwing subscriber does not prevent delivery to other subscribers', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const received1: BroadcasterEvent[] = [];
    const received2: BroadcasterEvent[] = [];
    // Skip 'init' in assertions/throws: init is delivered directly by subscribe(),
    // not via broadcastToAll; throwing there would fail subscribe() itself.
    const throwingCallback = (e: BroadcasterEvent) => {
      if (e.op !== 'init') throw new Error('subscriber1 threw');
    };
    const recordingCallback1 = (e: BroadcasterEvent) => {
      if (e.op !== 'init') received1.push(e);
    };

    const unsubA = await subscribe(docker as any, recordingCallback1);
    const unsubB = await subscribe(docker as any, throwingCallback);
    const unsubC = await subscribe(docker as any, (e) => {
      if (e.op !== 'init') received2.push(e);
    });

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'destroy',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => received1.some((e) => e.op === 'destroy'));
    unsubA();
    unsubB();
    unsubC();

    expect(received1.some((e) => e.op === 'destroy')).toBe(true);
    expect(received2.some((e) => e.op === 'destroy')).toBe(true);
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

describe('subscribe: error handling (data handler catch path)', () => {
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
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => (console.error as ReturnType<typeof mock>).mock.calls.length > 0);
    unsub();

    // The .catch on the handleDockerEvent call should have logged the error
    expect(console.error).toHaveBeenCalled();
  });
});

describe('subscribe: pause and unpause events (Fix 2)', () => {
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
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'pause',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => received.some((e) => e.op === 'upsert'));
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
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'unpause',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await waitForCondition(() => received.some((e) => e.op === 'upsert'));
    unsub();

    const upserts = received.filter((e) => e.op === 'upsert');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
    const last = upserts.at(-1) as Extract<BroadcasterEvent, { op: 'upsert' }>;
    expect(last.container.State).toBe('running');
  });
});

describe('subscribe: reconnect fresh init (Fix 3)', () => {
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

      // Intercept setTimeout to capture the reconnect callback (fires immediately)
      (globalThis as any).setTimeout = (cb: () => void) => {
        capturedReconnectCallback = cb;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      };

      // Simulate stream error to trigger scheduleReconnect
      eventsEmitter.emit('error', new Error('disconnected'));
      await waitForCondition(() => (console.error as ReturnType<typeof mock>).mock.calls.length > 0);

      // Verify we captured the reconnect callback
      expect(capturedReconnectCallback).not.toBeNull();

      // Restore real setTimeout before firing the callback (it awaits async operations)
      globalThis.setTimeout = originalSetTimeout;

      // Fire the reconnect; triggers startEventsSubscription(docker, true)
      // which calls listContainers (reconnect path) and broadcasts fresh init
      await (capturedReconnectCallback as unknown as () => Promise<void>)();

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

describe('subscribe: init enrichment via inspect', () => {
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

  test('inspect failure on ONE container does not crash init, others populated', async () => {
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

describe('_resetBroadcasterForTesting: with active reconnect timer', () => {
  test('clears pending reconnect timer during reset', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const timerCallbacks: Array<() => void> = [];

    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const unsub = await subscribe(docker as any, () => {});

    // Intercept setTimeout to capture the reconnect timer
    (globalThis as any).setTimeout = (cb: () => void, _delay: number) => {
      timerCallbacks.push(cb);
      return {} as any;  // Return a truthy object so reconnectTimer is set
    };

    try {
      // Trigger a stream error; scheduleReconnect will capture a timer via mocked setTimeout
      eventsEmitter.emit('error', new Error('disconnect'));
      await waitForCondition(() => (console.error as ReturnType<typeof mock>).mock.calls.length > 0);

      // Reset while the timer is pending; exercises lines 224-225
      _resetBroadcasterForTesting();

      // Timer callback was captured but should now be a no-op (state cleared)
      expect(timerCallbacks.length).toBeGreaterThan(0);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      unsub();
    }
  });
});

describe('portCandidatesFromInspect + normalizePorts: inspect shape', () => {
  test('published port coerces string HostPort to number', () => {
    const result = normalizePorts(portCandidatesFromInspect({
      '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
    }));
    expect(result).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }]);
  });

  test('unpublished exposed port has null bindings array', () => {
    const result = normalizePorts(portCandidatesFromInspect({
      '80/tcp': null as unknown as Array<{ HostIp: string; HostPort: string }>,
    }));
    expect(result).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: null }]);
  });

  test('udp port normalizes with its protocol', () => {
    const result = normalizePorts(portCandidatesFromInspect({
      '53/udp': [{ HostIp: '0.0.0.0', HostPort: '5353' }],
    }));
    expect(result).toEqual([{ containerPort: 53, protocol: 'udp', hostIp: '0.0.0.0', hostPort: 5353 }]);
  });

  test('multiple host bindings (ipv4 and ipv6) each produce a distinct entry', () => {
    const result = normalizePorts(portCandidatesFromInspect({
      '80/tcp': [
        { HostIp: '0.0.0.0', HostPort: '8080' },
        { HostIp: '::', HostPort: '8080' },
      ],
    }));
    expect(result).toEqual([
      { containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
      { containerPort: 80, protocol: 'tcp', hostIp: '::', hostPort: 8080 },
    ]);
  });

  test('sorts deterministically by containerPort, protocol, hostIp, hostPort', () => {
    const result = normalizePorts(portCandidatesFromInspect({
      '443/tcp': [{ HostIp: '0.0.0.0', HostPort: '8443' }],
      '80/udp': [{ HostIp: '0.0.0.0', HostPort: '8081' }],
      '80/tcp': [
        { HostIp: '::', HostPort: '8080' },
        { HostIp: '0.0.0.0', HostPort: '8080' },
      ],
    }));
    expect(result).toEqual([
      { containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 },
      { containerPort: 80, protocol: 'tcp', hostIp: '::', hostPort: 8080 },
      { containerPort: 80, protocol: 'udp', hostIp: '0.0.0.0', hostPort: 8081 },
      { containerPort: 443, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8443 },
    ]);
  });

  test('skips a malformed binding with non-numeric HostPort', () => {
    const result = normalizePorts(portCandidatesFromInspect({
      '80/tcp': [{ HostIp: '0.0.0.0', HostPort: 'not-a-port' }],
    }));
    expect(result).toEqual([]);
  });

  test('null/undefined Ports map produces no entries', () => {
    expect(normalizePorts(portCandidatesFromInspect(null))).toEqual([]);
    expect(normalizePorts(portCandidatesFromInspect(undefined))).toEqual([]);
  });

  test('skips a malformed port key with no "/protocol" suffix', () => {
    const result = normalizePorts(portCandidatesFromInspect({
      garbage: null as unknown as Array<{ HostIp: string; HostPort: string }>,
    }));
    expect(result).toEqual([]);
  });

  test('empty-string HostIp normalizes to null, matching the list shape', () => {
    const result = normalizePorts(portCandidatesFromInspect({
      '80/tcp': [{ HostIp: '', HostPort: '8080' }],
    }));
    expect(result).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: 8080 }]);
  });

  test('empty-string HostPort normalizes to null rather than Number("") === 0', () => {
    const result = normalizePorts(portCandidatesFromInspect({
      '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '' }],
    }));
    expect(result).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: null }]);
  });
});

describe('portCandidatesFromList + normalizePorts: list shape', () => {
  test('published port uses number PublicPort directly', () => {
    const result = normalizePorts(portCandidatesFromList([
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
    ]));
    expect(result).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }]);
  });

  test('unpublished port has absent IP and PublicPort', () => {
    const result = normalizePorts(portCandidatesFromList([
      { PrivatePort: 80, Type: 'tcp' } as unknown as Dockerode.Port,
    ]));
    expect(result).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: null, hostPort: null }]);
  });

  test('null Ports array produces no entries', () => {
    expect(normalizePorts(portCandidatesFromList(null))).toEqual([]);
  });

  test('equivalence: inspect shape and list shape normalize a published port identically', () => {
    const fromInspect = normalizePorts(portCandidatesFromInspect({
      '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }],
    }));
    const fromList = normalizePorts(portCandidatesFromList([
      { IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' },
    ]));
    expect(fromList).toEqual(fromInspect);
  });

  test('equivalence: inspect shape and list shape normalize an unpublished port identically', () => {
    const fromInspect = normalizePorts(portCandidatesFromInspect({
      '80/tcp': null as unknown as Array<{ HostIp: string; HostPort: string }>,
    }));
    const fromList = normalizePorts(portCandidatesFromList([
      { PrivatePort: 80, Type: 'tcp' } as unknown as Dockerode.Port,
    ]));
    expect(fromList).toEqual(fromInspect);
  });

  test('equivalence: multiple ports of mixed protocols normalize to the same sorted output', () => {
    const fromInspect = normalizePorts(portCandidatesFromInspect({
      '443/tcp': [{ HostIp: '0.0.0.0', HostPort: '8443' }],
      '53/udp': [{ HostIp: '0.0.0.0', HostPort: '5353' }],
      '80/tcp': null as unknown as Array<{ HostIp: string; HostPort: string }>,
    }));
    const fromList = normalizePorts(portCandidatesFromList([
      { IP: '0.0.0.0', PrivatePort: 53, PublicPort: 5353, Type: 'udp' },
      { PrivatePort: 80, Type: 'tcp' } as unknown as Dockerode.Port,
      { IP: '0.0.0.0', PrivatePort: 443, PublicPort: 8443, Type: 'tcp' },
    ]));
    expect(fromList).toEqual(fromInspect);
  });
});

describe('normalizeMounts', () => {
  test('bind mount with rw true', () => {
    const result = normalizeMounts([{ Type: 'bind', Source: '/host/data', Destination: '/data', RW: true }]);
    expect(result).toEqual([{ type: 'bind', source: '/host/data', destination: '/data', rw: true }]);
  });

  test('bind mount with rw false (read-only)', () => {
    const result = normalizeMounts([{ Type: 'bind', Source: '/host/data', Destination: '/data', RW: false }]);
    expect(result).toEqual([{ type: 'bind', source: '/host/data', destination: '/data', rw: false }]);
  });

  test('volume type mount', () => {
    const result = normalizeMounts([{ Type: 'volume', Source: 'my-volume', Destination: '/var/lib/data', RW: true }]);
    expect(result).toEqual([{ type: 'volume', source: 'my-volume', destination: '/var/lib/data', rw: true }]);
  });

  test('volume type prefers Name over Source when both are present', () => {
    const result = normalizeMounts([{
      Type: 'volume',
      Name: 'my-volume',
      Source: '/var/lib/docker/volumes/my-volume/_data',
      Destination: '/var/lib/data',
      RW: true,
    }]);
    expect(result).toEqual([{ type: 'volume', source: 'my-volume', destination: '/var/lib/data', rw: true }]);
  });

  test('equivalence: a named volume normalizes identically from the inspect shape (resolved path Source) and the list shape (empty Source)', () => {
    const fromInspect = normalizeMounts([{
      Type: 'volume',
      Name: 'my-volume',
      Source: '/var/lib/docker/volumes/my-volume/_data',
      Destination: '/var/lib/data',
      RW: true,
    }]);
    const fromList = normalizeMounts([{
      Type: 'volume',
      Name: 'my-volume',
      Source: '',
      Destination: '/var/lib/data',
      RW: true,
    }]);
    expect(fromList).toEqual(fromInspect);
  });

  test('sorts by destination', () => {
    const result = normalizeMounts([
      { Type: 'bind', Source: '/b', Destination: '/z', RW: true },
      { Type: 'bind', Source: '/a', Destination: '/a', RW: true },
    ]);
    expect(result.map((m) => m.destination)).toEqual(['/a', '/z']);
  });

  test('skips a malformed entry missing Type or Destination', () => {
    const result = normalizeMounts([
      { Source: '/a', Destination: '/a', RW: true },
      { Type: 'bind', Source: '/b', RW: true },
      { Type: 'bind', Source: '/c', Destination: '/c', RW: true },
    ]);
    expect(result).toEqual([{ type: 'bind', source: '/c', destination: '/c', rw: true }]);
  });

  test('null/undefined mounts produces no entries', () => {
    expect(normalizeMounts(null)).toEqual([]);
    expect(normalizeMounts(undefined)).toEqual([]);
  });
});

describe('subscribe: init and upsert carry ports and mounts', () => {
  test('init event includes ports and mounts from inspect', async () => {
    const eventsEmitter = new EventEmitter();
    const listEntry = makeContainer('c1', 'app1', 'running');
    const docker = {
      listContainers: mock(() => Promise.resolve([listEntry])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.resolve({
          Id: 'c1',
          Name: '/app1',
          State: { Status: 'running' },
          Config: { Image: 'nginx:latest', Labels: {} },
          NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } },
          Mounts: [{ Type: 'bind', Source: '/host', Destination: '/data', RW: true }],
        })),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    unsub();

    const init = received[0] as Extract<BroadcasterEvent, { op: 'init' }>;
    expect(init.containers[0].Ports).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }]);
    expect(init.containers[0].Mounts).toEqual([{ type: 'bind', source: '/host', destination: '/data', rw: true }]);
  });

  test('upsert event includes ports and mounts from inspect', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.resolve({
          Id: 'c1',
          Name: '/app1',
          State: { Status: 'running' },
          Config: { Image: 'nginx:latest', Labels: {} },
          NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } },
          Mounts: [{ Type: 'volume', Source: 'vol1', Destination: '/var/data', RW: true }],
        })),
      })),
    };

    const received: BroadcasterEvent[] = [];
    let resolveUpsert: (() => void) | null = null;
    const upsertReceived = new Promise<void>((resolve) => {
      resolveUpsert = resolve;
    });
    // subscribe() awaits startEventsSubscription internally, so by the time it
    // resolves the 'data' listener is already attached; no need to wait before emitting.
    const unsub = await subscribe(docker as any, (e) => {
      received.push(e);
      if (e.op === 'upsert') resolveUpsert?.();
    });

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await upsertReceived;
    unsub();

    const upserts = received.filter((e) => e.op === 'upsert');
    const upsert = upserts[0] as Extract<BroadcasterEvent, { op: 'upsert' }>;
    expect(upsert.container.Ports).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }]);
    expect(upsert.container.Mounts).toEqual([{ type: 'volume', source: 'vol1', destination: '/var/data', rw: true }]);
  });

  test('init falls back to list normalization (Ports/Mounts) when inspect fails', async () => {
    const eventsEmitter = new EventEmitter();
    const listEntry = {
      Id: 'c1',
      Names: ['/app1'],
      State: 'running',
      Image: 'nginx:latest',
      Labels: {},
      Ports: [{ IP: '0.0.0.0', PrivatePort: 80, PublicPort: 8080, Type: 'tcp' }],
      Mounts: [{ Type: 'bind', Source: '/host', Destination: '/data', RW: true, Mode: 'rw' }],
    };
    const docker = {
      listContainers: mock(() => Promise.resolve([listEntry])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.reject(new Error('inspect blew up'))),
      })),
    };

    const received: BroadcasterEvent[] = [];
    const unsub = await subscribe(docker as any, (e) => received.push(e));
    unsub();

    const init = received[0] as Extract<BroadcasterEvent, { op: 'init' }>;
    expect(init.containers[0].Ports).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }]);
    expect(init.containers[0].Mounts).toEqual([{ type: 'bind', source: '/host', destination: '/data', rw: true }]);
  });
});
