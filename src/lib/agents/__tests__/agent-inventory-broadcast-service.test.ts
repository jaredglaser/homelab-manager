import { describe, it, expect, mock } from 'bun:test';
import { AgentInventoryBroadcastService } from '../agent-inventory-broadcast-service';
import type { AgentInventorySnapshot } from '@/lib/hosts/agent-inventory';
import { waitForCondition } from '@/lib/test/wait-for-condition';

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
        versionSource: 'stored',
        agentImage: null,
        agentImageTag: null,
        lastError: null,
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
