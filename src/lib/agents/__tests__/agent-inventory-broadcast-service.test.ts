import { describe, it, expect, mock } from 'bun:test';
import { AgentInventoryBroadcastService } from '../agent-inventory-broadcast-service';
import type { AgentInventorySnapshot } from '@/lib/hosts/agent-inventory';

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
    await new Promise((r) => setTimeout(r, 10));

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
    await new Promise((r) => setTimeout(r, 10));

    listeners.notify!({ channel: 'agent_inventory_change' });
    await new Promise((r) => setTimeout(r, 10));

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
    const unsub = service.subscribe((s) => received.push(s));
    await new Promise((r) => setTimeout(r, 10));
    unsub();

    const receivedAfter = received.length;
    const still = service.subscribe(() => {});
    await new Promise((r) => setTimeout(r, 10));

    expect(received.length).toBe(receivedAfter);
    still();
    await service.stop();
  });
});
