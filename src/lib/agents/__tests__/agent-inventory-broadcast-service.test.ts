import { describe, it, expect, mock } from 'bun:test';
import { AgentInventoryBroadcastService } from '../agent-inventory-broadcast-service';
import type { AgentInventorySnapshot } from '@/lib/hosts/agent-inventory';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import type { PoolClient } from 'pg';

function snapshot(id: number): AgentInventorySnapshot {
  return {
    entries: [
      {
        id,
        name: `host-${id}`,
        agentUrl: `http://host-${id}:9090`,
        capabilities: {},
        status: 'online',
        version: '0.1.0',
        agentImage: null,
        agentImageTag: null,
        agentImageDigest: null,
        agentOutOfDate: false,
        failure: null,
        update: null,
        checkedAt: new Date().toISOString(),
      },
    ],
    sweptAt: new Date().toISOString(),
  };
}

function fakePoolClient() {
  return {
    on: mock(() => {}),
    query: mock(() => Promise.resolve({ rows: [] })),
    release: mock(() => {}),
    removeAllListeners: mock(() => {}),
  } as unknown as import('pg').PoolClient;
}

describe('AgentInventoryBroadcastService', () => {
  it('sends an immediate snapshot to each subscriber without probing agents', async () => {
    let loads = 0;
    const service = new AgentInventoryBroadcastService({
      getPoolClient: () => {
        loads += 1;
        return Promise.resolve(fakePoolClient());
      },
      loadSnapshot: () => Promise.resolve(snapshot(1)),
    });

    const received: AgentInventorySnapshot[] = [];
    const unsub1 = service.subscribe((s) => received.push(s));
    const unsub2 = service.subscribe((s) => received.push(s));
    await waitForCondition(() => received.length === 2);

    expect(received).toHaveLength(2);
    expect(received[0]!.entries[0]!.id).toBe(1);

    unsub1();
    unsub2();
    await service.stop();
  });

  it('fans one NOTIFY out to every subscriber as a reloaded snapshot', async () => {
    const listeners: Record<string, (msg: { channel: string }) => void> = {};

    let version = 1;
    const service = new AgentInventoryBroadcastService({
      getPoolClient: async () =>
        ({
          on: (event: string, cb: (msg: { channel: string }) => void) => {
            if (event === 'notification') listeners.notify = cb;
          },
          query: () => Promise.resolve({ rows: [] }),
          release: () => {},
          removeAllListeners: () => {},
        }) as unknown as import('pg').PoolClient,
      loadSnapshot: () => {
        const s = snapshot(version);
        version += 1;
        return Promise.resolve(s);
      },
    });

    const received: AgentInventorySnapshot[] = [];
    const unsub = service.subscribe((s) => received.push(s));
    await waitForCondition(() => received.length >= 1);

    listeners.notify!({ channel: 'agent_inventory_change' });
    await waitForCondition(() => received.length >= 2);

    expect(received).toHaveLength(2);
    expect(received[1]!.entries[0]!.id).toBe(2);

    unsub();
    await service.stop();
  });

  it('unsubscribed clients receive nothing after their unsubscribe', async () => {
    const service = new AgentInventoryBroadcastService({
      getPoolClient: () => Promise.resolve(fakePoolClient()),
      loadSnapshot: () => Promise.resolve(snapshot(1)),
    });

    const received: AgentInventorySnapshot[] = [];
    const receivedStill: AgentInventorySnapshot[] = [];
    const unsub = service.subscribe((s) => received.push(s));
    await waitForCondition(() => received.length >= 1);
    unsub();

    const receivedAfter = received.length;
    const still = service.subscribe((s) => receivedStill.push(s));
    await waitForCondition(() => receivedStill.length >= 1);

    expect(received.length).toBe(receivedAfter);
    still();
    await service.stop();
  });

  it('reconnects with backoff when the listener client errors and reloads after recovery', async () => {
    const notifyHandlers: Array<(msg?: unknown) => void> = [];
    const errorHandlers: Array<(msg?: unknown) => void> = [];
    let clientGeneration = 0;
    const service = new AgentInventoryBroadcastService({
      getPoolClient: async () => ({
        on: (event: string, cb: (msg?: unknown) => void) => {
          if (event === 'notification') notifyHandlers.push(cb);
          if (event === 'error') errorHandlers.push(cb);
        },
        query: () => Promise.resolve({ rows: [] }),
        release: () => {},
        removeAllListeners: () => {},
      }) as unknown as import('pg').PoolClient,
      loadSnapshot: () => Promise.resolve(snapshot(clientGeneration + 10)),
    });

    const received: AgentInventorySnapshot[] = [];
    const unsub = service.subscribe((s) => received.push(s));
    await waitForCondition(() => received.length >= 1);

    errorHandlers[0]!(new Error('connection terminated'));
    await waitForCondition(() => notifyHandlers.length >= 2);
    clientGeneration = 1;
    notifyHandlers[1]!({ channel: 'agent_inventory_change' });
    await waitForCondition(() => received.length >= 2);

    expect(received[1]!.entries[0]!.id).toBe(11);
    unsub();
    await service.stop();
  });

  it('retries listening when the initial connection fails', async () => {
    let attempts = 0;
    const service = new AgentInventoryBroadcastService({
      getPoolClient: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('db down');
        return fakePoolClient();
      },
      loadSnapshot: () => Promise.resolve(snapshot(1)),
    });

    const received: AgentInventorySnapshot[] = [];
    const unsub = service.subscribe((s) => received.push(s));
    await waitForCondition(() => attempts >= 2, { timeoutMs: 5000 });
    await waitForCondition(() => received.length >= 1);

    expect(received.length).toBe(1);

    unsub();
    await service.stop();
  });
});

describe('AgentInventoryBroadcastService with its default database wiring', () => {
  it('listens for sweeps and host changes on a pooled connection and builds the snapshot from the stored hosts', async () => {
    const client = fakePoolClient();
    const pool = { connect: mock(() => Promise.resolve(client)) };
    const repoPools: unknown[] = [];
    void mock.module('@/lib/clients/database-client', () => ({
      databaseConnectionManager: { getClient: () => Promise.resolve({ getPool: () => pool }) },
    }));
    void mock.module('@/lib/database/repositories/host-repository', () => ({
      HOSTS_NOTIFY_CHANNEL: 'managed_hosts_change',
      HostRepository: class {
        constructor(p: unknown) {
          repoPools.push(p);
        }
        findAll = () => Promise.resolve([]);
      },
    }));
    const service = new AgentInventoryBroadcastService();
    const received: AgentInventorySnapshot[] = [];
    try {
      service.subscribe((s) => received.push(s));
      await waitForCondition(() => received.length > 0 && (client.query as ReturnType<typeof mock>).mock.calls.length === 2);

      expect(received).toEqual([{ entries: [], sweptAt: null }]);
      expect(repoPools).toEqual([pool]);
      expect((client.query as ReturnType<typeof mock>).mock.calls.map((c) => c[0])).toEqual([
        'LISTEN agent_inventory_change',
        'LISTEN managed_hosts_change',
      ]);
    } finally {
      await service.stop();
    }
  });
});

describe('AgentInventoryBroadcastService re-subscribe while connecting', () => {
  function listeningPoolClient() {
    const state = { listened: false, released: false, notify: null as null | ((msg: { channel: string }) => void) };
    const client = {
      on: (event: string, cb: (msg: { channel: string }) => void) => {
        if (event === 'notification') state.notify = cb;
      },
      query: (sql: string) => {
        if (sql.startsWith('LISTEN')) state.listened = true;
        return Promise.resolve({ rows: [] });
      },
      release: () => { state.released = true; },
      removeAllListeners: () => undefined,
    } as unknown as PoolClient;
    return { client, state };
  }

  it('ends with one LISTEN client when a re-subscribe lands while the first client is still being acquired', async () => {
    const clients = [listeningPoolClient(), listeningPoolClient()];
    const acquisitions: ((client: PoolClient) => void)[] = [];
    let version = 1;
    const service = new AgentInventoryBroadcastService({
      getPoolClient: () => new Promise((resolve) => acquisitions.push(resolve)),
      loadSnapshot: () => Promise.resolve(snapshot(version++)),
    });

    service.subscribe(() => undefined)();
    const received: AgentInventorySnapshot[] = [];
    service.subscribe((s) => received.push(s));
    acquisitions.forEach((resolve, i) => resolve(clients[i].client));
    const handed = clients.slice(0, acquisitions.length).map((c) => c.state);
    await waitForCondition(() => received.length >= 1 && handed.every((s) => s.released || s.listened));

    const live = handed.filter((s) => s.listened && !s.released);
    expect(live).toHaveLength(1);

    live[0].notify!({ channel: 'agent_inventory_change' });
    await waitForCondition(() => received.length >= 2);
    expect(received.at(-1)?.entries[0].id).toBe(version - 1);
    await service.stop();
  });
});
