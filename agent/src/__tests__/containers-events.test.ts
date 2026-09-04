import { describe, expect, test, mock, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import { handleContainerEvents } from '../routes/containers-events';
import { _resetBroadcasterForTesting } from '../lib/docker-events-broadcaster';
import { zInventorySnapshotContainer } from '../types/protocol';
import { readUntil, parseDataFrames } from '../lib/test/sse-test-utils';
import { waitFor } from '../lib/test/wait-for';

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

function countDataFrames(text: string): number {
  return text.split('\n\n').filter((frame) => frame.startsWith('data: ')).length;
}

/**
 * A docker events stream whose teardown is awaitable. The broadcaster destroys
 * it once its last subscriber unsubscribes, which is how a test observes that a
 * disconnected client released its subscription.
 */
function makeDestroyableEventsStream(): { stream: EventEmitter; destroyed: Promise<void> } {
  const stream = new EventEmitter();
  let markDestroyed = () => {};
  const destroyed = new Promise<void>((resolve) => {
    markDestroyed = resolve;
  });
  Object.assign(stream, { destroy: mock(() => markDestroyed()) });
  return { stream, destroyed };
}

function makeContainer(id: string, name: string, state = 'running', image = 'nginx:latest') {
  return {
    Id: id,
    Names: [`/${name}`],
    State: state,
    Image: image,
    Labels: {},
  };
}

function makeDocker(
  containers: ReturnType<typeof makeContainer>[],
  eventsEmitter = new EventEmitter(),
  inspectOverride?: (id: string) => unknown,
) {
  return {
    listContainers: mock(() => Promise.resolve(containers)),
    getEvents: mock(() => Promise.resolve(eventsEmitter)),
    getContainer: mock((id: string) => ({
      inspect: mock(() => {
        if (inspectOverride) return inspectOverride(id);
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

describe('handleContainerEvents: response headers', () => {
  test('returns SSE response with correct headers and 200 status', async () => {
    const docker = makeDocker([]);
    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);
    ac.abort();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
  });
});

describe('handleContainerEvents: init snapshot', () => {
  test('emits init event with all containers on connect', async () => {
    const containers = [
      makeContainer('c1', 'app1', 'running'),
      makeContainer('c2', 'app2', 'exited'),
    ];
    const docker = makeDocker(containers);

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('"op":"init"'));
    ac.abort();

    const event = parseDataFrames(text)[0];
    expect(event.op).toBe('init');
    expect(event.containers).toHaveLength(2);
    expect(event.containers.map((c: { id: string }) => c.id).sort()).toEqual(['c1', 'c2'].sort((a, b) => a.localeCompare(b)));
  });

  test('init includes containers regardless of compose label (non-compose included)', async () => {
    const containers = [
      makeContainer('c1', 'standalone-app'),
      { ...makeContainer('c2', 'compose-app'), Labels: { 'com.docker.compose.project': 'mystack' } },
    ];
    const docker = makeDocker(containers);

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('"op":"init"'));
    ac.abort();

    const event = parseDataFrames(text)[0];
    expect(event.containers).toHaveLength(2);
  });

  test('inventory container shape is correct', async () => {
    const containers = [makeContainer('abc123', 'my-app', 'running', 'myapp:v1')];
    const docker = makeDocker(containers);

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('"op":"init"'));
    ac.abort();

    const event = parseDataFrames(text)[0];
    const c = event.containers[0];
    expect(c.id).toBe('abc123');
    expect(c.name).toBe('my-app');
    expect(c.image).toBe('myapp:v1');
    expect(c.state).toBe('running');
    expect(c.labels).toEqual({});
    expect(c.startedAt).toBeNull();
    expect(c.finishedAt).toBeNull();
    expect(c.exitCode).toBeNull();
  });

  test('strips leading slash from container name in inventory', async () => {
    const containers = [makeContainer('c1', 'test-app')];
    const docker = makeDocker(containers);

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('"op":"init"'));
    ac.abort();

    const event = parseDataFrames(text)[0];
    expect(event.containers[0].name).toBe('test-app');
  });

  test('state mapping: unknown Docker state maps to "unknown"', async () => {
    const containers = [makeContainer('c1', 'app', 'weird-state')];
    const docker = makeDocker(containers);

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('"op":"init"'));
    ac.abort();

    const event = parseDataFrames(text)[0];
    expect(event.containers[0].state).toBe('unknown');
  });

  test('empty init when no containers exist', async () => {
    const docker = makeDocker([]);

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('"op":"init"'));
    ac.abort();

    const event = parseDataFrames(text)[0];
    expect(event.containers).toHaveLength(0);
  });
});

describe('handleContainerEvents: start event produces upsert', () => {
  test('docker start event emits op:upsert with state:running', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1', 'running')];
    const docker = makeDocker(containers, eventsEmitter);

    const dataListenerAttached = new Promise<void>((resolve) => {
      eventsEmitter.once('newListener', (eventName) => {
        if (eventName === 'data') resolve();
      });
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    await dataListenerAttached;

    // Emit a start event
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    const text = await readUntil(response, (s) => {
      return countDataFrames(s) >= 2;
    });
    ac.abort();

    const events = parseDataFrames(text);
    const upsert = events.find((e) => e.op === 'upsert');
    expect(upsert).toBeDefined();
    expect(upsert.container.id).toBe('c1');
    expect(upsert.container.state).toBe('running');
  });
});

describe('handleContainerEvents: die event produces upsert with exited state', () => {
  test('docker die event emits op:upsert with state:dead or exited', async () => {
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

    const dataListenerAttached = new Promise<void>((resolve) => {
      eventsEmitter.once('newListener', (eventName) => {
        if (eventName === 'data') resolve();
      });
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    await dataListenerAttached;

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'die',
      Actor: { ID: 'c1' },
    }) + '\n'));

    const text = await readUntil(response, (s) => {
      return countDataFrames(s) >= 2;
    });
    ac.abort();

    const events = parseDataFrames(text);
    const upsert = events.find((e) => e.op === 'upsert');
    expect(upsert).toBeDefined();
    expect(upsert.container.id).toBe('c1');
    expect(['dead', 'exited', 'unknown']).toContain(upsert.container.state);
  });
});

describe('handleContainerEvents: destroy event', () => {
  test('docker destroy event emits op:destroy', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const dataListenerAttached = new Promise<void>((resolve) => {
      eventsEmitter.once('newListener', (eventName) => {
        if (eventName === 'data') resolve();
      });
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    await dataListenerAttached;

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'destroy',
      Actor: { ID: 'c1' },
    }) + '\n'));

    const text = await readUntil(response, (s) => {
      return countDataFrames(s) >= 2;
    });
    ac.abort();

    const events = parseDataFrames(text);
    const destroy = events.find((e) => e.op === 'destroy');
    expect(destroy).toBeDefined();
    expect(destroy.containerId).toBe('c1');
  });
});

describe('handleContainerEvents: multiple subscribers', () => {
  test('each subscriber gets independent SSE streams', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const req1 = new Request('http://localhost/containers/events', { signal: ac1.signal });
    const req2 = new Request('http://localhost/containers/events', { signal: ac2.signal });

    const [resp1, resp2] = await Promise.all([
      handleContainerEvents(docker as any, req1),
      handleContainerEvents(docker as any, req2),
    ]);

    const [text1, text2] = await Promise.all([
      readUntil(resp1, (s) => s.includes('"op":"init"')),
      readUntil(resp2, (s) => s.includes('"op":"init"')),
    ]);

    ac1.abort();
    ac2.abort();

    expect(text1).toContain('"op":"init"');
    expect(text2).toContain('"op":"init"');
  });

  test('getEvents called only once for multiple subscribers (shared broadcaster)', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const dataListenerAttached = new Promise<void>((resolve) => {
      eventsEmitter.once('newListener', (eventName) => {
        if (eventName === 'data') resolve();
      });
    });

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const req1 = new Request('http://localhost/containers/events', { signal: ac1.signal });
    const req2 = new Request('http://localhost/containers/events', { signal: ac2.signal });

    await handleContainerEvents(docker as any, req1);
    await dataListenerAttached;
    await handleContainerEvents(docker as any, req2);

    ac1.abort();
    ac2.abort();

    expect(docker.getEvents.mock.calls.length).toBe(1);
  });

  test('one subscriber unsubscribing does not cancel others', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const dataListenerAttached = new Promise<void>((resolve) => {
      eventsEmitter.once('newListener', (eventName) => {
        if (eventName === 'data') resolve();
      });
    });

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const req1 = new Request('http://localhost/containers/events', { signal: ac1.signal });
    const req2 = new Request('http://localhost/containers/events', { signal: ac2.signal });

    const resp1 = await handleContainerEvents(docker as any, req1);
    const resp2 = await handleContainerEvents(docker as any, req2);

    await dataListenerAttached;

    ac1.abort();
    const reader1 = resp1.body!.getReader();
    while (!(await reader1.read()).done);

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'destroy',
      Actor: { ID: 'c1' },
    }) + '\n'));

    const text2 = await readUntil(resp2, (s) => s.includes('"op":"destroy"'));
    ac2.abort();

    expect(text2).toContain('"op":"destroy"');
  });
});

describe('handleContainerEvents: request abort cleanup', () => {
  test('stream closes when request is aborted', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);
    const dataListenerAttached = new Promise<void>((resolve) => {
      eventsEmitter.once('newListener', (eventName) => {
        if (eventName === 'data') resolve();
      });
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    await dataListenerAttached;
    ac.abort();

    const reader = response.body!.getReader();
    let done = false;
    const deadline = Date.now() + 2000;
    while (!done && Date.now() < deadline) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
  });

  test('already-aborted request unsubscribes the broadcaster once subscribe resolves', async () => {
    const { stream, destroyed } = makeDestroyableEventsStream();
    const docker = makeDocker([], stream);
    const ac = new AbortController();
    ac.abort();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const reader = response.body!.getReader();
    let done = false;
    while (!done) {
      done = (await reader.read()).done;
    }

    await destroyed;
  });

  test('abort during broadcasterSubscribe tears down the late-arriving subscriber', async () => {
    // Slow listContainers so subscribe()'s await is in-flight when we abort.
    const listHolder: { resolve: ((v: unknown[]) => void) | null } = { resolve: null };
    const { stream, destroyed } = makeDestroyableEventsStream();
    const docker = {
      listContainers: mock(() => new Promise<unknown[]>((resolve) => {
        listHolder.resolve = resolve;
      })),
      getEvents: mock(() => Promise.resolve(stream)),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.reject(Object.assign(new Error('n/a'), { statusCode: 404 }))),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);
    const reader = response.body!.getReader();

    await waitFor(() => listHolder.resolve !== null);
    ac.abort();
    listHolder.resolve?.([]);

    let done = false;
    while (!done) {
      done = (await reader.read()).done;
    }
    await destroyed;
  });
});

describe('handleContainerEvents: error resilience', () => {
  test('continues serving after stream error on events stream', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const dataListenerAttached = new Promise<void>((resolve) => {
      eventsEmitter.once('newListener', (eventName) => {
        if (eventName === 'data') resolve();
      });
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);
    expect(response.status).toBe(200);

    await dataListenerAttached;
    eventsEmitter.emit('error', new Error('stream dropped'));

    ac.abort();
  });

  test('handles listContainers failure gracefully', async () => {
    const docker = {
      listContainers: mock(() => Promise.reject(new Error('Docker unavailable'))),
      getEvents: mock(() => Promise.resolve(new EventEmitter())),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    expect(response.status).toBe(200);
    await readUntil(response, (s) => s.includes('"op":"init"'));
    ac.abort();
  });
});

describe('handleContainerEvents: ports and mounts pass-through', () => {
  test('init event carries ports and mounts from inspect', async () => {
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, new EventEmitter(), (id) => Promise.resolve({
      Id: id,
      Name: '/app1',
      State: { Status: 'running' },
      Config: { Image: 'nginx:latest', Labels: {} },
      NetworkSettings: { Ports: { '80/tcp': [{ HostIp: '0.0.0.0', HostPort: '8080' }] } },
      Mounts: [{ Type: 'bind', Source: '/host', Destination: '/data', RW: true }],
    }));

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('"op":"init"'));
    ac.abort();

    const event = parseDataFrames(text)[0];
    const c = event.containers[0];
    expect(c.ports).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }]);
    expect(c.mounts).toEqual([{ type: 'bind', source: '/host', destination: '/data', rw: true }]);
  });

  test('init event has empty ports and mounts when the container exposes none', async () => {
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers);

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('"op":"init"'));
    ac.abort();

    const event = parseDataFrames(text)[0];
    const c = event.containers[0];
    expect(c.ports).toEqual([]);
    expect(c.mounts).toEqual([]);
  });

  test('upsert event carries ports and mounts from inspect', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter, (id) => Promise.resolve({
      Id: id,
      Name: '/app1',
      State: { Status: 'running' },
      Config: { Image: 'nginx:latest', Labels: {} },
      NetworkSettings: { Ports: { '53/udp': [{ HostIp: '::', HostPort: '5353' }] } },
      Mounts: [{ Type: 'volume', Source: 'vol1', Destination: '/var/data', RW: true }],
    }));

    // 'newListener' fires synchronously right before the broadcaster's own
    // listener is attached, so this resolves exactly when the events stream
    // is ready to receive, instead of guessing with a fixed-delay sleep.
    const dataListenerAttached = new Promise<void>((resolve) => {
      eventsEmitter.once('newListener', (eventName) => {
        if (eventName === 'data') resolve();
      });
    });

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    await dataListenerAttached;

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    const text = await readUntil(response, (s) => {
      return countDataFrames(s) >= 2;
    });
    ac.abort();

    const events = parseDataFrames(text);
    const upsert = events.find((e) => e.op === 'upsert');
    expect(upsert.container.ports).toEqual([{ containerPort: 53, protocol: 'udp', hostIp: '::', hostPort: 5353 }]);
    expect(upsert.container.mounts).toEqual([{ type: 'volume', source: 'vol1', destination: '/var/data', rw: true }]);
  });
});

describe('zInventorySnapshotContainer: ports/mounts schema round-trip', () => {
  const base = {
    id: 'c1',
    name: 'app1',
    image: 'nginx:latest',
    state: 'running' as const,
    labels: {},
    startedAt: null,
    finishedAt: null,
    exitCode: null,
  };

  test('defaults ports and mounts to [] when absent (version-skew with an older agent)', () => {
    const parsed = zInventorySnapshotContainer.parse(base);
    expect(parsed.ports).toEqual([]);
    expect(parsed.mounts).toEqual([]);
  });

  test('passes through ports and mounts when present', () => {
    const parsed = zInventorySnapshotContainer.parse({
      ...base,
      ports: [{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }],
      mounts: [{ type: 'bind', source: '/host', destination: '/data', rw: true }],
    });
    expect(parsed.ports).toEqual([{ containerPort: 80, protocol: 'tcp', hostIp: '0.0.0.0', hostPort: 8080 }]);
    expect(parsed.mounts).toEqual([{ type: 'bind', source: '/host', destination: '/data', rw: true }]);
  });
});

describe('handleContainerEvents: idle heartbeat', () => {
  const realSetInterval = globalThis.setInterval;

  afterEach(() => {
    globalThis.setInterval = realSetInterval;
  });

  test('a quiet host still gets a comment heartbeat on the 5s cadence', async () => {
    // Bun's HTTP idleTimeout defaults to 10s, so a host with no container
    // activity would otherwise go silent long enough to drop the socket.
    const ticks: Array<{ cb: () => void; ms: number }> = [];
    globalThis.setInterval = mock((cb: () => void, ms: number) => {
      ticks.push({ cb, ms });
      return ticks.length as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    const docker = makeDocker([]);
    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    expect(ticks).toHaveLength(1);
    expect(ticks[0].ms).toBe(5000);

    ticks[0].cb();
    const text = await readUntil(response, (s) => s.split('\n\n').includes(':'));
    ac.abort();

    expect(text.split('\n\n')).toContain(':');
  });
});
