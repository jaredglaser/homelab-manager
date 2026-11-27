import { describe, it, expect, mock } from 'bun:test';
import type { PoolClient } from 'pg';
import { ProxmoxStateBroadcastService, type ProxmoxStateSnapshot } from '../proxmox-state-broadcast-service';
import { waitForCondition } from '@/lib/test/wait-for-condition';

function snapshot(state: 'collecting' | 'unreachable'): ProxmoxStateSnapshot {
  return {
    connections: [{
      connectionId: 'pve.lan',
      host: 'pve.lan',
      port: 8006,
      state,
      reason: null,
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
  return { client: client as unknown as PoolClient, handlers, query: client.query };
}

describe('ProxmoxStateBroadcastService', () => {
  it('sends the recorded state on subscribe and again on each NOTIFY', async () => {
    const { client, handlers } = controllablePoolClient();
    const states = [snapshot('unreachable'), snapshot('collecting')];
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => Promise.resolve(client),
      loadSnapshot: () => Promise.resolve(states.shift() ?? snapshot('collecting')),
    });

    const received: ProxmoxStateSnapshot[] = [];
    const unsub = service.subscribe((s) => received.push(s));
    await waitForCondition(() => received.length === 1 && handlers.notify !== undefined);
    expect(received[0].connections[0].state).toBe('unreachable');

    handlers.notify!({ channel: 'proxmox_state_change' });
    await waitForCondition(() => received.length === 2);
    expect(received[1].connections[0].state).toBe('collecting');

    unsub();
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
    await waitForCondition(() => received.length === 1 && handlers.notify !== undefined);
    handlers.notify!({ channel: 'settings_change' });
    handlers.notify!({ channel: 'proxmox_state_change' });
    await waitForCondition(() => received.length === 2);

    expect(loads).toBe(2);
    await service.stop();
  });

  it('listens again on a new connection after the listener errors', async () => {
    const first = controllablePoolClient();
    const second = controllablePoolClient();
    const clients = [first.client, second.client];
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => Promise.resolve(clients.shift()!),
      loadSnapshot: () => Promise.resolve(snapshot('collecting')),
    });
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;
    try {
      const received: ProxmoxStateSnapshot[] = [];
      service.subscribe((s) => received.push(s));
      await waitForCondition(() => received.length === 1 && first.handlers.error !== undefined);

      first.handlers.error!(new Error('connection terminated'));
      await waitForCondition(() => second.handlers.notify !== undefined, { timeoutMs: 1500 });
      second.handlers.notify!({ channel: 'proxmox_state_change' });
      await waitForCondition(() => received.length === 2);

      expect(second.query).toHaveBeenCalledWith('LISTEN proxmox_state_change');
    } finally {
      console.error = originalError;
      await service.stop();
    }
  });

  it('keeps a subscriber when loading the state fails, and logs it', async () => {
    const { client } = controllablePoolClient();
    const errorSpy = mock(() => {});
    const originalError = console.error;
    console.error = errorSpy;
    try {
      const service = new ProxmoxStateBroadcastService({
        getPoolClient: () => Promise.resolve(client),
        loadSnapshot: () => Promise.reject(new Error('db down')),
      });
      service.subscribe(() => undefined);
      await waitForCondition(() => errorSpy.mock.calls.length > 0);

      expect(String((errorSpy.mock.calls[0] as unknown[])[0])).toContain('[ProxmoxStateBroadcastService]');
      await service.stop();
    } finally {
      console.error = originalError;
    }
  });
});

describe('ProxmoxStateBroadcastService edge paths', () => {
  it('sends a second subscriber its own snapshot and keeps listening until the last one leaves', async () => {
    const { client } = controllablePoolClient();
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
    expect(client.release).not.toHaveBeenCalled();
    unsubSecond();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('retries the listener when the first connection fails, and stops retrying once stopped', async () => {
    const { client } = controllablePoolClient();
    let attempts = 0;
    const originalError = console.error;
    console.error = mock(() => {});
    try {
      const service = new ProxmoxStateBroadcastService({
        getPoolClient: () => {
          attempts++;
          return attempts === 1 ? Promise.reject(new Error('db down')) : Promise.resolve(client);
        },
        loadSnapshot: () => Promise.resolve(snapshot('collecting')),
      });
      const received: ProxmoxStateSnapshot[] = [];
      service.subscribe((s) => received.push(s));
      await waitForCondition(() => received.length === 1, { timeoutMs: 1500 });

      expect(attempts).toBe(2);
      await service.stop();
    } finally {
      console.error = originalError;
    }
  });

  it('releases a connection that arrives after the last subscriber left', async () => {
    const { client } = controllablePoolClient();
    let hand: ((c: PoolClient) => void) | undefined;
    const service = new ProxmoxStateBroadcastService({
      getPoolClient: () => new Promise((resolve) => { hand = resolve; }),
      loadSnapshot: () => Promise.resolve(snapshot('collecting')),
    });
    service.subscribe(() => undefined)();
    hand!(client);
    await waitForCondition(() => (client.release as ReturnType<typeof mock>).mock.calls.length === 1);
    await service.stop();
  });

  it('logs a subscriber that throws and still reaches the others', async () => {
    const { client, handlers } = controllablePoolClient();
    const originalError = console.error;
    const errorSpy = mock(() => {});
    console.error = errorSpy;
    try {
      const service = new ProxmoxStateBroadcastService({
        getPoolClient: () => Promise.resolve(client),
        loadSnapshot: () => Promise.resolve(snapshot('collecting')),
      });
      let calls = 0;
      const received: ProxmoxStateSnapshot[] = [];
      service.subscribe(() => {
        calls++;
        if (calls > 1) throw new Error('boom');
      });
      service.subscribe((s) => received.push(s));
      await waitForCondition(() => received.length === 1 && handlers.notify !== undefined);
      handlers.notify!({ channel: 'proxmox_state_change' });
      await waitForCondition(() => received.length === 2);

      expect(errorSpy.mock.calls.some((c) => String((c as unknown[])[0]).includes('Subscriber callback failed'))).toBe(true);
      await service.stop();
    } finally {
      console.error = originalError;
    }
  });
});

describe('ProxmoxStateBroadcastService with its default database wiring', () => {
  it('listens on a pooled connection and reads the state table', async () => {
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
        list = () => Promise.resolve([]);
      },
    }));
    const service = new ProxmoxStateBroadcastService();
    const received: ProxmoxStateSnapshot[] = [];
    try {
      service.subscribe((s) => received.push(s));
      await waitForCondition(() => received.length > 0 && query.mock.calls.length === 1);

      expect(received).toEqual([{ connections: [] }]);
      expect(repoPools).toEqual([pool]);
      expect(query.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['LISTEN proxmox_state_change']);
    } finally {
      await service.stop();
    }
  });
});
