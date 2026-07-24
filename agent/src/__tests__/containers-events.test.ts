import { describe, expect, test, mock, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import { handleContainerEvents } from '../routes/containers-events';
import { _resetBroadcasterForTesting } from '../lib/docker-events-broadcaster';
import { zInventorySnapshotContainer } from '../types/protocol';

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

/** Read chunks from the stream until predicate is satisfied or timeout. */
async function readUntil(
  response: Response,
  predicate: (accumulated: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  let text = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error(`readUntil timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      try {
        const { done, value } = await Promise.race([reader.read(), timeoutPromise]);
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (predicate(text)) break;
      } finally {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      }
    }
  } finally {
    reader.cancel();
  }
  return text;
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

    const event = JSON.parse(text.split('\n\n').find(Boolean)!.replace(/^data: /, ''));
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

    const event = JSON.parse(text.split('\n\n').find(Boolean)!.replace(/^data: /, ''));
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

    const event = JSON.parse(text.split('\n\n').find(Boolean)!.replace(/^data: /, ''));
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

    const event = JSON.parse(text.split('\n\n').find(Boolean)!.replace(/^data: /, ''));
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

    const event = JSON.parse(text.split('\n\n').find(Boolean)!.replace(/^data: /, ''));
    expect(event.containers[0].state).toBe('unknown');
  });

  test('empty init when no containers exist', async () => {
    const docker = makeDocker([]);

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const text = await readUntil(response, (s) => s.includes('"op":"init"'));
    ac.abort();

    const event = JSON.parse(text.split('\n\n').find(Boolean)!.replace(/^data: /, ''));
    expect(event.containers).toHaveLength(0);
  });
});

describe('handleContainerEvents: start event produces upsert', () => {
  test('docker start event emits op:upsert with state:running', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1', 'running')];
    const docker = makeDocker(containers, eventsEmitter);

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    // Wait for the broadcaster to start and the events stream to be established
    await new Promise((r) => setTimeout(r, 50));

    // Emit a start event
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1' },
    }) + '\n'));

    const text = await readUntil(response, (s) => {
      const events = s.split('\n\n').filter(Boolean);
      return events.length >= 2;
    });
    ac.abort();

    const events = text.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, '')));
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

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    await new Promise((r) => setTimeout(r, 50));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'die',
      Actor: { ID: 'c1' },
    }) + '\n'));

    const text = await readUntil(response, (s) => {
      const events = s.split('\n\n').filter(Boolean);
      return events.length >= 2;
    });
    ac.abort();

    const events = text.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, '')));
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

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    await new Promise((r) => setTimeout(r, 50));

    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'destroy',
      Actor: { ID: 'c1' },
    }) + '\n'));

    const text = await readUntil(response, (s) => {
      const events = s.split('\n\n').filter(Boolean);
      return events.length >= 2;
    });
    ac.abort();

    const events = text.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, '')));
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
    const docker = makeDocker([]);

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const req1 = new Request('http://localhost/containers/events', { signal: ac1.signal });
    const req2 = new Request('http://localhost/containers/events', { signal: ac2.signal });

    await handleContainerEvents(docker as any, req1);
    await new Promise((r) => setTimeout(r, 20));
    await handleContainerEvents(docker as any, req2);
    await new Promise((r) => setTimeout(r, 20));

    ac1.abort();
    ac2.abort();

    expect(docker.getEvents.mock.calls.length).toBe(1);
  });

  test('one subscriber unsubscribing does not cancel others', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app1')];
    const docker = makeDocker(containers, eventsEmitter);

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const req1 = new Request('http://localhost/containers/events', { signal: ac1.signal });
    const req2 = new Request('http://localhost/containers/events', { signal: ac2.signal });

    await handleContainerEvents(docker as any, req1);
    const resp2 = await handleContainerEvents(docker as any, req2);

    await new Promise((r) => setTimeout(r, 30));

    // Abort first subscriber
    ac1.abort();
    await new Promise((r) => setTimeout(r, 20));

    // Emit destroy; subscriber2 should still receive it
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
    const docker = makeDocker([]);
    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await new Promise((r) => setTimeout(r, 20));

    const reader = response.body!.getReader();
    let done = false;
    const deadline = Date.now() + 2000;
    while (!done && Date.now() < deadline) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
  });

  test('already-aborted request does not register a broadcaster subscriber', async () => {
    const docker = makeDocker([]);
    const ac = new AbortController();
    ac.abort();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    const reader = response.body!.getReader();
    const result = await reader.read();
    expect(result.done).toBe(true);
    expect(docker.getEvents).not.toHaveBeenCalled();
  });

  test('abort during broadcasterSubscribe tears down the late-arriving subscriber', async () => {
    // Slow listContainers so subscribe()'s await is in-flight when we abort.
    const listHolder: { resolve: ((v: unknown[]) => void) | null } = { resolve: null };
    const docker = {
      listContainers: mock(() => new Promise<unknown[]>((resolve) => {
        listHolder.resolve = resolve;
      })),
      getEvents: mock(() => Promise.resolve(new EventEmitter())),
      getContainer: mock(() => ({
        inspect: mock(() => Promise.reject(Object.assign(new Error('n/a'), { statusCode: 404 }))),
      })),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);
    const reader = response.body!.getReader();

    await new Promise((r) => setTimeout(r, 10));
    ac.abort();
    listHolder.resolve?.([]);

    const result = await reader.read();
    expect(result.done).toBe(true);
  });
});

describe('handleContainerEvents: error resilience', () => {
  test('continues serving after stream error on events stream', async () => {
    const eventsEmitter = new EventEmitter();
    const docker = makeDocker([], eventsEmitter);

    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);
    expect(response.status).toBe(200);

    await new Promise((r) => setTimeout(r, 20));
    eventsEmitter.emit('error', new Error('stream dropped'));
    await new Promise((r) => setTimeout(r, 20));

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
    await new Promise((r) => setTimeout(r, 20));
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

    const event = JSON.parse(text.split('\n\n').find(Boolean)!.replace(/^data: /, ''));
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

    const event = JSON.parse(text.split('\n\n').find(Boolean)!.replace(/^data: /, ''));
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
      const events = s.split('\n\n').filter(Boolean);
      return events.length >= 2;
    });
    ac.abort();

    const events = text.split('\n\n').filter(Boolean).map((line) => JSON.parse(line.replace(/^data: /, '')));
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
  const realClearInterval = globalThis.clearInterval;

  afterEach(() => {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
  });

  test('enqueues a comment heartbeat to keep the idle socket alive', async () => {
    // A quiet host emits no container events, so without this the socket sits
    // silent past Bun's 10s HTTP idleTimeout and the worker reconnects in a loop.
    let captured: (() => void) | null = null;
    globalThis.setInterval = mock((cb: () => void) => {
      captured = cb;
      return 1 as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval;

    const docker = makeDocker([]);
    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    // Let start() finish broadcaster setup and register the interval.
    await new Promise((r) => setTimeout(r, 50));
    expect(captured).not.toBeNull();

    captured!();
    const text = await readUntil(response, (s) => s.includes(':\n\n'));
    ac.abort();

    // Init frame plus a bare ':' comment heartbeat.
    expect(text.split('\n\n')).toContain(':');
  });

  test('clears the heartbeat interval when the request aborts', async () => {
    const fakeId = Symbol('hb') as unknown as ReturnType<typeof setInterval>;
    globalThis.setInterval = mock(() => fakeId) as unknown as typeof setInterval;
    const clearSpy = mock(() => {});
    globalThis.clearInterval = clearSpy as unknown as typeof clearInterval;

    const docker = makeDocker([]);
    const ac = new AbortController();
    const request = new Request('http://localhost/containers/events', { signal: ac.signal });
    const response = await handleContainerEvents(docker as any, request);

    await new Promise((r) => setTimeout(r, 50)); // let the interval register
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));

    expect(clearSpy).toHaveBeenCalledWith(fakeId);
    void response;
  });
});
