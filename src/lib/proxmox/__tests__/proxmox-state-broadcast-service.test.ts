import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import type { PoolClient } from 'pg';
import { ProxmoxStateBroadcastService, type ProxmoxStateSnapshot } from '../proxmox-state-broadcast-service';
import { waitForCondition } from '@/lib/test/wait-for-condition';

type State = 'collecting' | 'unreachable' | 'token_rejected';

function snapshot(state: State): ProxmoxStateSnapshot {
  return {
    connections: [{
      connectionId: 'pve.lan',
      host: 'pve.lan',
      port: 8006,
      state,
      lastSuccessAt: 1_000,
      updatedAt: 2_000,
    }],
  };
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

const states = (received: ProxmoxStateSnapshot[]) => received.map((s) => s.connections[0]?.state);

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

describe('ProxmoxStateBroadcastService', () => {
  it('sends the recorded state once listening, and again on each NOTIFY', async () => {
    const { client, handlers } = controllablePoolClient();
    const queue: State[] = ['unreachable', 'collecting'];
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => Promise.resolve(snapshot(queue.shift() ?? 'collecting')),
    });

    const received: ProxmoxStateSnapshot[] = [];
    service.subscribe((s) => received.push(s));
    await waitForCondition(() => received.length === 1);

    handlers.notify!({ channel: 'proxmox_state_change' });
    await waitForCondition(() => received.length === 2);

    expect(states(received)).toEqual(['unreachable', 'collecting']);
    await service.stop();
  });

  it('ignores notifications on other channels', async () => {
    const { client, handlers } = controllablePoolClient();
    let loads = 0;
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => {
        loads++;
        return Promise.resolve(snapshot('collecting'));
      },
    });

    const received: ProxmoxStateSnapshot[] = [];
    service.subscribe((s) => received.push(s));
    await waitForCondition(() => received.length === 1);
    handlers.notify!({ channel: 'settings_change' });
    handlers.notify!({ channel: 'proxmox_state_change' });
    await waitForCondition(() => received.length === 2);

    expect(loads).toBe(2);
    await service.stop();
  });

  it('reloads and fans out after it listens again, so a state written while the listener was down still arrives', async () => {
    const first = controllablePoolClient();
    const second = controllablePoolClient();
    const clients = [first.client, second.client];
    let stored: State = 'collecting';
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => Promise.resolve(clients.shift()!),
      loadSnapshot: () => Promise.resolve(snapshot(stored)),
    });

    const a: ProxmoxStateSnapshot[] = [];
    const b: ProxmoxStateSnapshot[] = [];
    service.subscribe((s) => a.push(s));
    await waitForCondition(() => a.length === 1);
    service.subscribe((s) => b.push(s));
    await waitForCondition(() => b.length === 1);

    stored = 'unreachable';
    first.handlers.error!(new Error('connection terminated'));
    await waitForCondition(() => a.length === 2 && b.length === 2);

    expect(states(a)).toEqual(['collecting', 'unreachable']);
    expect(states(b)).toEqual(['collecting', 'unreachable']);
    expect(second.query).toHaveBeenCalledWith('LISTEN proxmox_state_change');
    await service.stop();
  });

  it('gives a subscriber that arrived while the database was down a snapshot once it listens', async () => {
    const { client } = controllablePoolClient();
    let databaseUp = false;
    let attempts = 0;
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => {
        attempts++;
        if (attempts === 2) databaseUp = true;
        return databaseUp ? Promise.resolve(client) : Promise.reject(new Error('db down'));
      },
      loadSnapshot: () => (databaseUp ? Promise.resolve(snapshot('unreachable')) : Promise.reject(new Error('db down'))),
    });

    const a: ProxmoxStateSnapshot[] = [];
    const b: ProxmoxStateSnapshot[] = [];
    service.subscribe((s) => a.push(s));
    service.subscribe((s) => b.push(s));
    await waitForCondition(() => a.length >= 1 && b.length >= 1);

    expect(states(b).at(-1)).toBe('unreachable');
    expect(attempts).toBe(2);
    await service.stop();
  });

  it('never delivers an older snapshot after a newer one', async () => {
    const { client, handlers } = controllablePoolClient();
    const pending: ((s: ProxmoxStateSnapshot) => void)[] = [];
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => new Promise((resolve) => pending.push(resolve)),
    });

    const received: ProxmoxStateSnapshot[] = [];
    service.subscribe((s) => received.push(s));
    await waitForCondition(() => pending.length === 1 && handlers.notify !== undefined);
    handlers.notify!({ channel: 'proxmox_state_change' });

    expect(pending).toHaveLength(1);
    pending[0](snapshot('collecting'));
    await waitForCondition(() => pending.length === 2);
    pending[1](snapshot('unreachable'));
    await waitForCondition(() => received.length === 2);

    expect(states(received)).toEqual(['collecting', 'unreachable']);
    await service.stop();
  });

  it('keeps listening until the last subscriber leaves', async () => {
    const { client, release } = controllablePoolClient();
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => Promise.resolve(snapshot('collecting')),
    });
    const first: ProxmoxStateSnapshot[] = [];
    const second: ProxmoxStateSnapshot[] = [];
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
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => new Promise((resolve) => { hand = resolve; }),
      loadSnapshot: () => Promise.resolve(snapshot('collecting')),
    });
    service.subscribe(() => undefined)();
    hand!(client);
    await waitForCondition(() => release.mock.calls.length === 1);
    await service.stop();
  });

  it('logs a failed load and a subscriber that throws, and still reaches the others', async () => {
    const { client, handlers } = controllablePoolClient();
    let fail = true;
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve(snapshot('collecting'))),
    });
    const received: ProxmoxStateSnapshot[] = [];
    service.subscribe(() => {
      throw new Error('boom');
    });
    service.subscribe((s) => received.push(s));
    await waitForCondition(() => handlers.notify !== undefined && errorSpy.mock.calls.length > 0);
    fail = false;
    handlers.notify!({ channel: 'proxmox_state_change' });
    await waitForCondition(() => received.length >= 1);

    const logged = errorSpy.mock.calls.map((c) => String(c[0]));
    expect(logged.some((line) => line.includes('Failed to load snapshot'))).toBe(true);
    expect(logged.some((line) => line.includes('Subscriber callback failed'))).toBe(true);
    await service.stop();
  });
});

describe('ProxmoxStateBroadcastService with its default database wiring', () => {
  // The default wiring loads modules, which a timer spy that never yields to the event loop would starve.
  beforeEach(() => timeoutSpy.mockRestore());

  it('listens on a pooled connection and sends the state table without the reason', async () => {
    const { client, query } = controllablePoolClient();
    const pool = { connect: mock(() => Promise.resolve(client)) };
    const repoPools: unknown[] = [];
    void mock.module('@/lib/clients/database-client', () => ({
      databaseConnectionManager: { getClient: () => Promise.resolve({ getPool: () => pool }) },
    }));
    void mock.module('@/lib/database/repositories/proxmox-state-repository', () => ({
      PROXMOX_STATE_NOTIFY_CHANNEL: 'proxmox_state_change',
      ProxmoxStateRepository: class {
        constructor(p: unknown) {
          repoPools.push(p);
        }
        list = () => Promise.resolve([{ ...snapshot('unreachable').connections[0], reason: 'HTTP 500 detail' }]);
      },
    }));
    const service = new ProxmoxStateBroadcastService();
    const received: ProxmoxStateSnapshot[] = [];
    try {
      service.subscribe((s) => received.push(s));
      await waitForCondition(() => received.length > 0);

      expect(received).toEqual([snapshot('unreachable')]);
      expect(repoPools).toEqual([pool]);
      expect(query.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['LISTEN proxmox_state_change']);
    } finally {
      await service.stop();
    }
  });
});
