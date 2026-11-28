import { describe, expect, test } from 'bun:test';
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

function setup(transport: FakeZfsTransport) {
  let desired: ZfsNodeConnection[] = [];
  const created: ZfsNodeCollector[] = [];
  const global = new AbortController();
  const ticker = new ManualTicker();
  const manager = new ZfsNodeManager(
    global.signal,
    async () => desired,
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

  test('keeps the session when only the stored ciphertext changed, as after a master key rotation', async () => {
    const transport = new FakeZfsTransport({ status: { code: 0, stdout: TANK_STATUS, stderr: '' }, influx: () => null });
    const s = setup(transport);
    s.setNodes([node({ state: 'ok' })]);
    await s.manager.reconcile();
    await waitForCondition(() => transport.sessions.length === 1);

    s.setNodes([node({ state: 'timeout', lastSuccessAt: 5 })]);
    await s.manager.reconcile();

    expect(s.created).toHaveLength(1);
    expect(transport.sessions[0].closed).toBe(false);
    await s.manager[Symbol.asyncDispose]();
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
