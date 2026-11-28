import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { PoolClient } from 'pg';
import { ZfsHealthBroadcastService, type ZfsHealthSnapshot } from '../zfs-health-broadcast-service';
import { waitForCondition } from '@/lib/test/wait-for-condition';

type State = 'connected' | 'offline' | 'unreadable';

function snapshot(state: State): ZfsHealthSnapshot {
  return {
    hosts: [{ host: 'pve1', readable: state !== 'unreadable', connected: state !== 'offline', lastSeenAt: 1_000, pools: [] }],
  };
}

function hostState(snap: ZfsHealthSnapshot): State | undefined {
  const [host] = snap.hosts;
  if (!host) return undefined;
  if (!host.connected) return 'offline';
  return host.readable ? 'connected' : 'unreadable';
}

function controllablePoolClient() {
  const handlers: { notify?: (msg: { channel: string }) => void; error?: (err: Error) => void } = {};
  const client = {
    on: (event: string, cb: never) => {
      if (event === 'notification') handlers.notify = cb;
      if (event === 'error') handlers.error = cb;
    },
    query: mock(() => Promise.resolve({ rows: [] })),
    release: mock(() => {}),
    removeAllListeners: mock(() => {}),
  };
  return { client: client as unknown as PoolClient, handlers, query: client.query, release: client.release };
}

const states = (received: ZfsHealthSnapshot[]) => received.map(hostState);

let timeoutSpy: { mockRestore: () => void };
let errorSpy: ReturnType<typeof spyOn<Console, 'error'>>;

beforeEach(() => {
  timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void) => {
    queueMicrotask(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  timeoutSpy.mockRestore();
  errorSpy.mockRestore();
});

describe('ZfsHealthBroadcastService', () => {
  it('sends the recorded state once listening, and again on each NOTIFY', async () => {
    const { client, handlers } = controllablePoolClient();
    const queue: State[] = ['offline', 'connected'];
    const service = new ZfsHealthBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => Promise.resolve(snapshot(queue.shift() ?? 'connected')),
    });

    const received: ZfsHealthSnapshot[] = [];
    service.subscribe((s) => received.push(s));
    await waitForCondition(() => received.length === 1);

    handlers.notify!({ channel: 'zfs_health_change' });
    await waitForCondition(() => received.length === 2);

    expect(states(received)).toEqual(['offline', 'connected']);
    await service.stop();
  });

  it('ignores notifications on other channels', async () => {
    const { client, handlers } = controllablePoolClient();
    let loads = 0;
    const service = new ZfsHealthBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => {
        loads++;
        return Promise.resolve(snapshot('connected'));
      },
    });

    const received: ZfsHealthSnapshot[] = [];
    service.subscribe((s) => received.push(s));
    await waitForCondition(() => received.length === 1);
    handlers.notify!({ channel: 'settings_change' });
    handlers.notify!({ channel: 'zfs_health_change' });
    await waitForCondition(() => received.length === 2);

    expect(loads).toBe(2);
    await service.stop();
  });

  it('reloads and fans out after it listens again, so a state written while the listener was down still arrives', async () => {
    const first = controllablePoolClient();
    const second = controllablePoolClient();
    const clients = [first.client, second.client];
    let stored: State = 'connected';
    const service = new ZfsHealthBroadcastService({
      getPoolClient: () => Promise.resolve(clients.shift()!),
      loadSnapshot: () => Promise.resolve(snapshot(stored)),
    });

    const a: ZfsHealthSnapshot[] = [];
    const b: ZfsHealthSnapshot[] = [];
    service.subscribe((s) => a.push(s));
    await waitForCondition(() => a.length === 1);
    service.subscribe((s) => b.push(s));
    await waitForCondition(() => b.length === 1);

    stored = 'offline';
    first.handlers.error!(new Error('connection terminated'));
    await waitForCondition(() => a.length === 2 && b.length === 2);

    expect(states(a)).toEqual(['connected', 'offline']);
    expect(states(b)).toEqual(['connected', 'offline']);
    expect(second.query).toHaveBeenCalledWith('LISTEN zfs_health_change');
    await service.stop();
  });

  it('gives a subscriber that arrived while the database was down a snapshot once it listens', async () => {
    const { client } = controllablePoolClient();
    let databaseUp = false;
    let attempts = 0;
    const service = new ZfsHealthBroadcastService({
      getPoolClient: () => {
        attempts++;
        if (attempts === 2) databaseUp = true;
        return databaseUp ? Promise.resolve(client) : Promise.reject(new Error('db down'));
      },
      loadSnapshot: () => (databaseUp ? Promise.resolve(snapshot('offline')) : Promise.reject(new Error('db down'))),
    });

    const a: ZfsHealthSnapshot[] = [];
    const b: ZfsHealthSnapshot[] = [];
    service.subscribe((s) => a.push(s));
    service.subscribe((s) => b.push(s));
    await waitForCondition(() => a.length >= 1 && b.length >= 1);

    expect(states(b).at(-1)).toBe('offline');
    expect(attempts).toBe(2);
    await service.stop();
  });

  it('drops an older snapshot that settles after a newer one was delivered', async () => {
    const { client, handlers } = controllablePoolClient();
    const pending: ((s: ZfsHealthSnapshot) => void)[] = [];
    const service = new ZfsHealthBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => new Promise((resolve) => pending.push(resolve)),
    });

    const received: ZfsHealthSnapshot[] = [];
    service.subscribe((s) => received.push(s));
    await waitForCondition(() => pending.length === 1 && handlers.notify !== undefined);
    handlers.notify!({ channel: 'zfs_health_change' });
    await waitForCondition(() => pending.length === 2);

    pending[1](snapshot('offline'));
    await waitForCondition(() => received.length === 1);
    pending[0](snapshot('connected'));
    handlers.notify!({ channel: 'zfs_health_change' });
    await waitForCondition(() => pending.length === 3);
    pending[2](snapshot('unreadable'));
    await waitForCondition(() => received.length === 2);

    expect(states(received)).toEqual(['offline', 'unreadable']);
    await service.stop();
  });

  it('keeps delivering to new subscribers and on NOTIFY when one load never settles', async () => {
    const { client, handlers } = controllablePoolClient();
    let calls = 0;
    const service = new ZfsHealthBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => (++calls === 1 ? new Promise<ZfsHealthSnapshot>(() => undefined) : Promise.resolve(snapshot('offline'))),
    });

    const first: ZfsHealthSnapshot[] = [];
    const second: ZfsHealthSnapshot[] = [];
    service.subscribe((s) => first.push(s));
    await waitForCondition(() => calls === 1 && handlers.notify !== undefined);
    service.subscribe((s) => second.push(s));
    await waitForCondition(() => second.length === 1);
    handlers.notify!({ channel: 'zfs_health_change' });
    await waitForCondition(() => first.length === 1 && second.length === 2);

    expect(states(first)).toEqual(['offline']);
    await service.stop();
  });

  it('keeps listening until the last subscriber leaves', async () => {
    const { client, release } = controllablePoolClient();
    const service = new ZfsHealthBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => Promise.resolve(snapshot('connected')),
    });
    const first: ZfsHealthSnapshot[] = [];
    const second: ZfsHealthSnapshot[] = [];
    const unsubFirst = service.subscribe((s) => first.push(s));
    await waitForCondition(() => first.length === 1);
    const unsubSecond = service.subscribe((s) => second.push(s));
    await waitForCondition(() => second.length === 1);

    unsubFirst();
    expect(release).not.toHaveBeenCalled();
    unsubSecond();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('releases a connection that arrives after the last subscriber left', async () => {
    const { client, release } = controllablePoolClient();
    let hand: ((c: PoolClient) => void) | undefined;
    const service = new ZfsHealthBroadcastService({
      getPoolClient: () => new Promise((resolve) => { hand = resolve; }),
      loadSnapshot: () => Promise.resolve(snapshot('connected')),
    });
    service.subscribe(() => undefined)();
    hand!(client);
    await waitForCondition(() => release.mock.calls.length === 1);
    await service.stop();
  });

  it('logs a failed load and a subscriber that throws, and still reaches the others', async () => {
    const { client, handlers } = controllablePoolClient();
    let fail = true;
    const service = new ZfsHealthBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(snapshot('connected'))),
    });
    const received: ZfsHealthSnapshot[] = [];
    service.subscribe(() => {
      throw new Error('boom');
    });
    service.subscribe((s) => received.push(s));
    await waitForCondition(() => handlers.notify !== undefined && errorSpy.mock.calls.length > 0);
    fail = false;
    handlers.notify!({ channel: 'zfs_health_change' });
    await waitForCondition(() => received.length >= 1);

    const logged = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes('Failed to load snapshot'))).toBe(true);
    expect(logged.some((line) => line.includes('Subscriber callback failed'))).toBe(true);
    await service.stop();
  });
});

describe('ZfsHealthBroadcastService with its default database wiring', () => {
  // The default wiring loads modules, which a timer spy that never yields to the event loop would starve.
  beforeEach(() => timeoutSpy.mockRestore());

  it('listens on a pooled connection and sends the stored health', async () => {
    const { client, query } = controllablePoolClient();
    const pool = { connect: mock(() => Promise.resolve(client)) };
    const repoPools: unknown[] = [];
    void mock.module('@/lib/clients/database-client', () => ({
      databaseConnectionManager: { getClient: () => Promise.resolve({ getPool: () => pool }) },
    }));
    void mock.module('@/lib/database/repositories/zfs-health-repository', () => ({
      ZFS_HEALTH_NOTIFY_CHANNEL: 'zfs_health_change',
      ZfsHealthRepository: class {
        constructor(p: unknown) {
          repoPools.push(p);
        }
        list = () => Promise.resolve(snapshot('offline').hosts);
      },
    }));
    const service = new ZfsHealthBroadcastService();
    const received: ZfsHealthSnapshot[] = [];
    try {
      service.subscribe((s) => received.push(s));
      await waitForCondition(() => received.length > 0);

      expect(received).toEqual([snapshot('offline')]);
      expect(repoPools).toEqual([pool]);
      expect(query.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['LISTEN zfs_health_change']);
    } finally {
      await service.stop();
    }
  });
});
