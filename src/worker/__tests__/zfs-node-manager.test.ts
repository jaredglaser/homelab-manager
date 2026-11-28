import { describe, expect, spyOn, test } from 'bun:test';
import type { Pool } from 'pg';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { encryptValue } from '@/lib/crypto/encrypted-value';
import { ZfsNodeRepository } from '@/lib/database/repositories/zfs-node-repository';
import type { ZfsNodeConnection } from '@/lib/database/repositories/zfs-node-repository';
import { FakeZfsTransport, ManualTicker } from '@/lib/test/fake-zfs-ssh';
import { waitForCondition } from '@/lib/test/wait-for-condition';
import { ZfsNodeCollector } from '../collectors/zfs-node-collector';
import { ZfsNodeManager } from '../zfs-node-manager';

const TANK_STATUS = JSON.stringify({ pools: { tank: { name: 'tank', state: 'ONLINE', vdevs: { tank: { name: 'tank', vdevs: {} } } } } });

function node(overrides: Partial<ZfsNodeConnection> = {}): ZfsNodeConnection {
  return {
    id: 1,
    name: 'pve1',
    address: 'pve1.lan',
    port: 22,
    allowedFrom: null,
    state: 'ok',
    hostKeyFingerprint: 'SHA256:node-key',
    seenHostKeyFingerprint: null,
    lastSuccessAt: null,
    username: 'hlm',
    privateKey: 'private-key-text',
    ...overrides,
  };
}

function setup(transport: FakeZfsTransport, list?: () => Promise<ZfsNodeConnection[]>) {
  let desired: ZfsNodeConnection[] = [];
  const created: ZfsNodeCollector[] = [];
  const global = new AbortController();
  const ticker = new ManualTicker();
  const manager = new ZfsNodeManager(
    global.signal,
    list ?? (async () => desired),
    (n, controller) => {
      const collector = new ZfsNodeCollector(
        n,
        {
          transport,
          states: { recordFailure: async () => {}, recordSuccess: async () => {} },
          insertRows: async () => {},
          now: ticker.now,
          tick: ticker.tick,
        },
        controller,
      );
      created.push(collector);
      return collector;
    },
  );
  return {
    manager,
    created,
    global,
    setNodes: (nodes: ZfsNodeConnection[]) => {
      desired = nodes;
    },
  };
}

describe('ZfsNodeManager', () => {
  test('closes a removed node session at once and stops only that node', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK_STATUS, stderr: '' }, influx: () => null });
    const s = setup(transport);
    s.setNodes([node(), node({ id: 2, name: 'pve2' })]);
    await s.manager.reconcile();
    await waitForCondition(() => transport.sessions.length === 2);

    s.setNodes([node({ id: 2, name: 'pve2' })]);
    await s.manager.reconcile();

    expect(transport.sessions[0].closed).toBe(true);
    expect(transport.sessions[1].closed).toBe(false);
    expect(s.manager.nodeNames()).toEqual(['ZfsNodeCollector(pve2)']);
    await s.manager[Symbol.asyncDispose]();
    expect(transport.sessions[1].closed).toBe(true);
  });

  test('cancels a connect still in progress when the node is removed', async () => {
    const transport = new FakeZfsTransport({ connectHangs: true });
    const s = setup(transport);
    s.setNodes([node()]);
    await s.manager.reconcile();
    await waitForCondition(() => transport.attempts.length === 1);

    s.setNodes([]);
    await s.manager.reconcile();

    expect(transport.attempts[0].options.signal?.aborted).toBe(true);
    expect(s.manager.runners()).toHaveLength(0);
  });

  test('keeps the session through a master key rotation, which changes the stored ciphertext but not the key', async () => {
    const aes = async () => crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const v1 = await aes();
    const v2 = await aes();
    const keyring: MasterKeyring = { activeKid: 'v2', keys: new Map([['v1', v1], ['v2', v2]]) };
    let storedJwe = await encryptValue('node private key', { activeKid: 'v1', keys: new Map([['v1', v1]]) });
    const pool = {
      query: async () => ({
        rows: [{
          id: 1, name: 'pve1', address: 'pve1.lan', port: 22, allowed_from: null, state: 'ok', host_key_fingerprint: 'SHA256:node-key',
          seen_host_key_fingerprint: null, last_success_at: null, username: 'hlm', private_key_jwe: storedJwe,
        }],
      }),
    } as unknown as Pool;
    const repo = new ZfsNodeRepository(pool, keyring);
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK_STATUS, stderr: '' }, influx: () => null });
    const s = setup(transport, () => repo.listCollectable());
    await s.manager.reconcile();
    await waitForCondition(() => transport.sessions.length === 1);

    const rotated = await encryptValue('node private key', keyring);
    expect(rotated).not.toBe(storedJwe);
    storedJwe = rotated;
    await s.manager.reconcile();

    expect(s.created).toHaveLength(1);
    expect(transport.sessions[0].closed).toBe(false);
    expect(transport.attempts.map((attempt) => attempt.target.privateKey)).toEqual(['node private key']);
    await s.manager[Symbol.asyncDispose]();
  });

  test('moves on from a runner that does not stop, so other nodes are still added and removed', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const stuck = new Promise<void>(() => {});
      let desired: ZfsNodeConnection[] = [node(), node({ id: 2, name: 'pve2' })];
      const created: string[] = [];
      const manager = new ZfsNodeManager(
        new AbortController().signal,
        async () => desired,
        (n) => {
          created.push(n.name);
          return { name: n.name, run: () => (n.id === 1 ? stuck : new Promise<void>(() => {})), wake: () => {} } as unknown as ZfsNodeCollector;
        },
        5,
      );
      await manager.reconcile();
      desired = [node({ id: 3, name: 'pve3' })];
      await manager.reconcile();

      expect(created).toEqual(['pve1', 'pve2', 'pve3']);
      expect(manager.nodeNames()).toEqual(['pve3']);
      expect(errors).toHaveBeenCalledWith('[ZfsNodeManager] pve1 did not stop within 5ms, moving on');
    } finally {
      errors.mockRestore();
    }
  });

  test('wakes only the node a notify names', async () => {
    const woken: string[] = [];
    const desired = [node(), node({ id: 2, name: 'pve2' })];
    const manager = new ZfsNodeManager(
      new AbortController().signal,
      async () => desired,
      (n) => ({ name: n.name, run: () => new Promise<void>(() => {}), wake: () => woken.push(n.name) }) as unknown as ZfsNodeCollector,
      5,
    );
    await manager.reconcile();
    await manager.reconcile('pve2');
    await manager.reconcile();
    expect(woken).toEqual(['pve2']);
  });

  test('restarts collection when a new host key is confirmed', async () => {
    const transport = new FakeZfsTransport({ fingerprint: 'SHA256:reinstalled' });
    const s = setup(transport);
    s.setNodes([node()]);
    await s.manager.reconcile();
    await waitForCondition(() => transport.attempts.length === 1);
    expect(transport.sessions).toHaveLength(0);

    transport.behaviour.status = { code: 0, stdout: TANK_STATUS, stderr: '' };
    s.setNodes([node({ hostKeyFingerprint: 'SHA256:reinstalled' })]);
    await s.manager.reconcile();
    await waitForCondition(() => transport.sessions.length === 1);

    expect(s.created).toHaveLength(2);
    await s.manager[Symbol.asyncDispose]();
  });

  test('stops every node on shutdown', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK_STATUS, stderr: '' }, influx: () => null });
    const s = setup(transport);
    s.setNodes([node(), node({ id: 2, name: 'pve2' })]);
    await s.manager.reconcile();
    await waitForCondition(() => transport.sessions.length === 2);
    s.global.abort();
    await Promise.all(s.manager.runners());
    expect(transport.sessions.every((session) => session.closed)).toBe(true);
  });
});
