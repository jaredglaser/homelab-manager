import { describe, expect, test, mock, beforeAll, beforeEach, afterAll } from 'bun:test';
import { EventEmitter } from 'node:events';
import { handleStackEvents, _resetStateForTesting } from '../routes/stack-events';

const originalConsoleError = console.error;

beforeAll(() => {
  console.error = mock(() => {});
});

afterAll(() => {
  console.error = originalConsoleError;
});

beforeEach(() => {
  _resetStateForTesting();
});

/** Read chunks from the stream until predicate is satisfied or timeout. */
async function readUntil(
  response: Response,
  predicate: (accumulated: string) => boolean,
  timeoutMs = 3000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      if (Date.now() > deadline) break;
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) break;
    }
  } finally {
    reader.cancel();
  }
  return text;
}

/** Build a minimal ContainerInfo mock with compose label. */
function makeContainer(
  id: string,
  name: string,
  stack: string,
  state = 'running',
  image = 'nginx:latest',
) {
  return {
    Id: id,
    Names: [`/${name}`],
    State: state,
    Image: image,
    Labels: { 'com.docker.compose.project': stack },
  };
}

/** Build a minimal ContainerInfo mock WITHOUT compose label. */
function makeNonComposeContainer(id: string, name: string) {
  return {
    Id: id,
    Names: [`/${name}`],
    State: 'running',
    Image: 'alpine:latest',
    Labels: {},
  };
}

describe('handleStackEvents — response headers', () => {
  test('returns SSE response with correct headers and 200 status', () => {
    const eventsEmitter = new EventEmitter();
    const mockDocker = {
      listContainers: mock(() => Promise.resolve([])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    ac.abort();

    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-cache');
    expect(response.headers.get('Connection')).toBe('keep-alive');
  });
});

describe('handleStackEvents — initial snapshots', () => {
  test('emits current status of all stacks on initial connection', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [
      makeContainer('c1', 'plex-server', 'plex'),
      makeContainer('c2', 'plex-db', 'plex'),
      makeContainer('c3', 'sonarr', 'sonarr'),
    ];

    const mockDocker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    const text = await readUntil(response, (s) => {
      return s.includes('"stack":"plex"') && s.includes('"stack":"sonarr"');
    });
    ac.abort();

    // Parse the SSE events
    const events = text.split('\n\n').filter(Boolean).map(line => JSON.parse(line.replace(/^data: /, '')));

    const plexEvent = events.find((e) => e.stack === 'plex');
    expect(plexEvent).toBeDefined();
    expect(plexEvent.containers).toHaveLength(2);
    expect(plexEvent.containers.map((c: { id: string }) => c.id).sort()).toEqual(['c1', 'c2'].sort());

    const sonarrEvent = events.find((e) => e.stack === 'sonarr');
    expect(sonarrEvent).toBeDefined();
    expect(sonarrEvent.containers).toHaveLength(1);
    expect(sonarrEvent.containers[0].id).toBe('c3');
  });

  test('emits empty stack list when no compose containers are running', async () => {
    const eventsEmitter = new EventEmitter();
    const mockDocker = {
      listContainers: mock(() => Promise.resolve([])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    // Give time to start up
    await new Promise((r) => setTimeout(r, 30));
    ac.abort();

    // We only get events that are emitted — no stacks → no events
    const text = await readUntil(response, () => false, 200);
    expect(text).toBe('');
  });

  test('container snapshot shape includes id, name, status, image', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('abc123', 'my-app', 'mystack', 'running', 'myapp:v1')];

    const mockDocker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    const text = await readUntil(response, (s) => s.includes('"stack":"mystack"'));
    ac.abort();

    const event = JSON.parse(text.split('\n\n').filter(Boolean)[0].replace(/^data: /, ''));
    expect(event.stack).toBe('mystack');
    expect(event.containers[0]).toEqual({
      id: 'abc123',
      name: 'my-app',
      status: 'running',
      image: 'myapp:v1',
    });
  });

  test('strips leading slash from container name', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('id1', 'test-app', 'teststack')];

    const mockDocker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    const text = await readUntil(response, (s) => s.includes('"stack":"teststack"'));
    ac.abort();

    const event = JSON.parse(text.split('\n\n').filter(Boolean)[0].replace(/^data: /, ''));
    expect(event.containers[0].name).toBe('test-app');
  });
});

describe('handleStackEvents — Docker lifecycle events', () => {
  test('emits stack snapshot when a compose container starts', async () => {
    const eventsEmitter = new EventEmitter();
    const initialContainer = makeContainer('c1', 'app', 'mystack', 'running');

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([initialContainer])),
      getContainer: mock((id: string) => ({
        inspect: mock(() => Promise.resolve({
          Id: id,
          Name: '/app',
          State: { Status: 'running' },
          Config: { Image: 'nginx:latest', Labels: { 'com.docker.compose.project': 'mystack' } },
        })),
      })),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    // Wait for the full startup (initial snapshot + events subscription) before emitting
    await new Promise((r) => setTimeout(r, 50));

    // Emit a 'start' event — the events listener is now set up
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'c1', Attributes: { 'com.docker.compose.project': 'mystack' } },
    }) + '\n'));

    const text = await readUntil(response, (s) => {
      const events = s.split('\n\n').filter(Boolean);
      return events.length >= 2;
    });
    ac.abort();

    const events = text.split('\n\n').filter(Boolean).map(line => JSON.parse(line.replace(/^data: /, '')));
    expect(events.length).toBeGreaterThanOrEqual(2);
    // All emitted events should be for 'mystack'
    expect(events.every(e => e.stack === 'mystack')).toBe(true);
  });

  test('emits stack snapshot on container destroy and removes it from state', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [
      makeContainer('c1', 'app1', 'mystack'),
      makeContainer('c2', 'app2', 'mystack'),
    ];

    const mockDocker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    // Wait for full startup before emitting
    await new Promise((r) => setTimeout(r, 50));

    // Emit destroy event for c1 — destroy is handled synchronously (no listContainers call)
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

    const events = text.split('\n\n').filter(Boolean).map(line => JSON.parse(line.replace(/^data: /, '')));
    const lastEvent = events[events.length - 1];
    expect(lastEvent.stack).toBe('mystack');
    // c1 should have been removed, only c2 remains
    expect(lastEvent.containers.map((c: { id: string }) => c.id)).toEqual(['c2']);
  });

  test('ignores container events without com.docker.compose.project label', async () => {
    const eventsEmitter = new EventEmitter();
    const nonComposeContainer = makeNonComposeContainer('nc1', 'standalone');

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([nonComposeContainer])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 30));

    // Emit start event for non-compose container
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'start',
      Actor: { ID: 'nc1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();

    // No stacks in state means no events should have been emitted
    const text = await readUntil(response, () => false, 200);
    expect(text).toBe('');
  });

  test('ignores non-container event types (e.g. network events)', async () => {
    const eventsEmitter = new EventEmitter();

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 30));

    // Emit a network event - should be ignored
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'network',
      Action: 'connect',
      Actor: { ID: 'net1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();

    const text = await readUntil(response, () => false, 200);
    expect(text).toBe('');
  });

  test('ignores irrelevant container actions (e.g. exec_create)', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app', 'mystack')];
    const getContainerMock = mock(() => ({
      inspect: mock(() => Promise.resolve({
        Id: 'c1', Name: '/app', State: { Status: 'running' },
        Config: { Image: 'nginx:latest', Labels: { 'com.docker.compose.project': 'mystack' } },
      })),
    }));

    const mockDocker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getContainer: getContainerMock,
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    // Wait for initial snapshot
    await readUntil(response, (s) => s.includes('"stack":"mystack"'));
    const initialGetContainerCalls = getContainerMock.mock.calls.length;

    // Emit exec_create — should be ignored
    eventsEmitter.emit('data', Buffer.from(JSON.stringify({
      Type: 'container',
      Action: 'exec_create',
      Actor: { ID: 'c1' },
    }) + '\n'));

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();

    // getContainer should not have been called after initial setup
    expect(getContainerMock.mock.calls.length).toBe(initialGetContainerCalls);
  });
});

describe('handleStackEvents — request abort cleanup', () => {
  test('cleans up subscriber on request abort', async () => {
    const eventsEmitter = new EventEmitter();
    const mockDocker = {
      listContainers: mock(() => Promise.resolve([])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();

    // Give the abort handler time to run
    await new Promise((r) => setTimeout(r, 20));

    // Stream should be closed (reading returns done)
    const reader = response.body!.getReader();
    let done = false;
    const deadline = Date.now() + 2000;
    while (!done && Date.now() < deadline) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
  });

  test('destroys events stream when last subscriber disconnects', async () => {
    const eventsEmitter = new EventEmitter();
    const destroySpy = mock(() => {});
    (eventsEmitter as any).destroy = destroySpy;

    const mockDocker = {
      listContainers: mock(() => Promise.resolve([])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    handleStackEvents(mockDocker as any, request);

    await new Promise((r) => setTimeout(r, 30));
    ac.abort();
    await new Promise((r) => setTimeout(r, 20));

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });
});

describe('handleStackEvents — fan-out to multiple clients', () => {
  test('broadcasts stack snapshots to all connected clients', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app', 'mystack', 'running')];

    const mockDocker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const req1 = new Request('http://localhost/stacks/events', { signal: ac1.signal });
    const req2 = new Request('http://localhost/stacks/events', { signal: ac2.signal });

    const response1 = handleStackEvents(mockDocker as any, req1);
    const response2 = handleStackEvents(mockDocker as any, req2);

    // Both should receive initial snapshots
    const [text1, text2] = await Promise.all([
      readUntil(response1, (s) => s.includes('"stack":"mystack"')),
      readUntil(response2, (s) => s.includes('"stack":"mystack"')),
    ]);

    ac1.abort();
    ac2.abort();

    expect(text1).toContain('"stack":"mystack"');
    expect(text2).toContain('"stack":"mystack"');
  });

  test('getEvents is called only once for multiple clients (shared subscription)', async () => {
    const eventsEmitter = new EventEmitter();
    const mockDocker = {
      listContainers: mock(() => Promise.resolve([])),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac1 = new AbortController();
    const ac2 = new AbortController();
    const req1 = new Request('http://localhost/stacks/events', { signal: ac1.signal });
    const req2 = new Request('http://localhost/stacks/events', { signal: ac2.signal });

    handleStackEvents(mockDocker as any, req1);
    await new Promise((r) => setTimeout(r, 30));
    handleStackEvents(mockDocker as any, req2);
    await new Promise((r) => setTimeout(r, 30));

    ac1.abort();
    ac2.abort();

    // getEvents should only be called once
    expect((mockDocker.getEvents as ReturnType<typeof mock>).mock.calls.length).toBe(1);
  });
});

describe('handleStackEvents — error resilience', () => {
  test('handles malformed JSON in Docker event stream gracefully', async () => {
    const eventsEmitter = new EventEmitter();
    const containers = [makeContainer('c1', 'app', 'mystack')];

    const mockDocker = {
      listContainers: mock(() => Promise.resolve(containers)),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    // Wait for full startup
    await new Promise((r) => setTimeout(r, 50));

    // Emit malformed JSON — should not crash the stream
    eventsEmitter.emit('data', Buffer.from('not valid json\n'));

    // Give time for the malformed event to be processed
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();

    // Stream should close cleanly (no exceptions thrown)
    const reader = response.body!.getReader();
    let done = false;
    const deadline = Date.now() + 2000;
    while (!done && Date.now() < deadline) {
      const result = await reader.read();
      done = result.done;
    }
    expect(done).toBe(true);
  });

  test('continues serving clients even if listContainers fails on initial connection', async () => {
    const eventsEmitter = new EventEmitter();
    let callCount = 0;
    const mockDocker = {
      listContainers: mock(() => {
        callCount++;
        if (callCount === 1) return Promise.reject(new Error('Docker unavailable'));
        return Promise.resolve([]);
      }),
      getEvents: mock(() => Promise.resolve(eventsEmitter)),
    };

    const ac = new AbortController();
    const request = new Request('http://localhost/stacks/events', { signal: ac.signal });
    const response = handleStackEvents(mockDocker as any, request);

    // Should not throw; stream should be returned normally
    expect(response.status).toBe(200);

    await new Promise((r) => setTimeout(r, 30));
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
});
