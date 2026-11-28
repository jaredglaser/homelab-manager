import { describe, expect, it, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import type { Pool } from 'pg';
import type { ProxmoxClient } from '@/lib/clients/proxmox-client';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { ProxmoxConnection } from '@/lib/config/proxmox-config';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type { ProxmoxConnectionForWorker } from '@/lib/database/repositories/proxmox-connection-repository';
import type { ProxmoxCollectorStateWrite } from '@/lib/database/repositories/proxmox-state-repository';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import { ProxmoxCollector } from '../collectors/proxmox-collector';
import { ProxmoxConnectionManager } from '../proxmox-connection-manager';

const workerConfig: WorkerConfig = {
  docker: { enabled: false },
  zfs: { enabled: false },
  collection: { interval: 1000 },
  agents: { allowInsecurePlaintext: false },
};

const db = { id: 'test', getPool: () => ({}) as Pool } as unknown as DatabaseClient;

function connection(overrides: Partial<ProxmoxConnection> = {}): ProxmoxConnection {
  return {
    id: 1,
    name: 'homelab',
    host: 'pve.lan',
    port: 8006,
    tokenId: 'root@pam!hlm',
    tokenSecret: 'secret-1',
    allowSelfSignedCerts: true,
    ...overrides,
  };
}

/** A client whose poll stays in flight until the collector's signal aborts it. */
function hangingClient(polls: { started: number; aborted: number }): ProxmoxClient {
  return {
    getClusterSnapshot: (signal?: AbortSignal) => new Promise((_, reject) => {
      polls.started++;
      signal?.addEventListener('abort', () => {
        polls.aborted++;
        reject(signal.reason);
      }, { once: true });
    }),
  } as unknown as ProxmoxClient;
}

function setup(initial: ProxmoxConnectionForWorker[]) {
  let saved = initial;
  const global = new AbortController();
  const created: { connection: ProxmoxConnection; collector: ProxmoxCollector; controller: AbortController }[] = [];
  const polls = { started: 0, aborted: 0 };
  const writes: ProxmoxCollectorStateWrite[] = [];
  const removeOrphanStates = mock(() => Promise.resolve());
  const manager = new ProxmoxConnectionManager(
    global.signal,
    () => Promise.resolve(saved),
    (c, controller) => {
      const collector = new ProxmoxCollector(db, workerConfig, c, 10_000, controller, { getClient: () => hangingClient(polls) }, {
        record: async (write) => { writes.push(write); },
      });
      created.push({ connection: c, collector, controller });
      return collector;
    },
    removeOrphanStates,
  );
  return {
    manager,
    global,
    created,
    polls,
    writes,
    removeOrphanStates,
    save: (next: ProxmoxConnectionForWorker[]) => { saved = next; },
  };
}

const row = (c: ProxmoxConnection): ProxmoxConnectionForWorker => ({ id: c.id, name: c.name, connection: c });

describe('ProxmoxConnectionManager', () => {
  let infoSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    logSpy = spyOn(console, 'log').mockImplementation(() => undefined);
    infoSpy = spyOn(console, 'info').mockImplementation(() => undefined);
    errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('runs one collector per saved connection', async () => {
    const t = setup([row(connection()), row(connection({ id: 2, host: 'pve2.lan' }))]);
    await t.manager.reconcile();

    expect(t.created.map((c) => c.connection.host)).toEqual(['pve.lan', 'pve2.lan']);
    expect(t.manager.collectors()).toHaveLength(2);
    await t.manager[Symbol.asyncDispose]();
  });

  it('stops a removed connection mid-poll at once, and clears the state it may have written', async () => {
    const t = setup([row(connection())]);
    await t.manager.reconcile();
    await waitForCondition(() => t.polls.started === 1);

    t.save([]);
    const started = performance.now();
    await t.manager.reconcile();

    expect(performance.now() - started).toBeLessThan(1000);
    expect(t.polls.aborted).toBe(1);
    expect(t.created[0].controller.signal.aborted).toBe(true);
    expect(t.manager.collectors()).toEqual([]);
    expect(t.removeOrphanStates).toHaveBeenCalledTimes(1);
    expect(t.writes).toEqual([]);
  });

  it('restarts the collector when the address, token or certificate setting changes', async () => {
    const t = setup([row(connection())]);
    await t.manager.reconcile();

    t.save([row(connection({ tokenSecret: 'secret-2' }))]);
    await t.manager.reconcile();

    expect(t.created).toHaveLength(2);
    expect(t.created[0].controller.signal.aborted).toBe(true);
    expect(t.created[1].connection.tokenSecret).toBe('secret-2');
    await t.manager[Symbol.asyncDispose]();
  });

  it('keeps the running collector through a rename and through a secret re-encrypted under a new master key', async () => {
    const t = setup([row(connection())]);
    await t.manager.reconcile();

    t.save([row(connection({ name: 'renamed' }))]);
    await t.manager.reconcile();
    t.save([row(connection({ name: 'renamed' }))]);
    await t.manager.reconcile();

    expect(t.created).toHaveLength(1);
    expect(t.created[0].controller.signal.aborted).toBe(false);
    await t.manager[Symbol.asyncDispose]();
  });

  it('keeps collecting when the stored secret cannot be decrypted with the keys this worker loaded', async () => {
    const t = setup([row(connection())]);
    await t.manager.reconcile();

    t.save([{ id: 1, name: 'homelab', connection: null }, { id: 2, name: 'other', connection: null }]);
    await t.manager.reconcile();

    expect(t.created).toHaveLength(1);
    expect(t.created[0].controller.signal.aborted).toBe(false);
    expect(t.removeOrphanStates).not.toHaveBeenCalled();
    await t.manager[Symbol.asyncDispose]();
  });

  it('keeps every collector when the connections cannot be listed', async () => {
    const global = new AbortController();
    let fail = false;
    const created: AbortController[] = [];
    const manager = new ProxmoxConnectionManager(
      global.signal,
      async () => {
        if (fail) throw new Error('relation "proxmox_connections" does not exist');
        return [row(connection())];
      },
      (c, controller) => {
        created.push(controller);
        return new ProxmoxCollector(db, workerConfig, c, 10_000, controller, { getClient: () => hangingClient({ started: 0, aborted: 0 }) }, { record: () => Promise.resolve() });
      },
    );
    await manager.reconcile();
    fail = true;
    await manager.reconcile();

    expect(created).toHaveLength(1);
    expect(created[0].signal.aborted).toBe(false);
    await manager[Symbol.asyncDispose]();
  });

  it('starts nothing once the worker is shutting down', async () => {
    const t = setup([row(connection())]);
    t.global.abort();
    await t.manager.reconcile();

    expect(t.created).toEqual([]);
  });
});
