import { describe, expect, test } from 'bun:test';
import type { NewZfsNode, ZfsNodeConnection } from '@/lib/database/repositories/zfs-node-repository';
import { ZfsNodeNameTakenError } from '@/lib/database/repositories/zfs-node-repository';
import type { ZfsNodeFailure, ZfsNodeSummary } from '@/lib/zfs/node-state';
import { ZFS_DISPATCH_PATH } from '@/lib/zfs/node-setup-script';
import { ZfsSshError } from '@/lib/zfs/ssh-transport';
import { EMPTY_STATUS, FakeZfsTransport, immediateTimer } from '@/lib/test/fake-zfs-ssh';
import {
  handleConfirmZfsNodeHostKey,
  handleCreateZfsNode,
  handleGetZfsNodeSetupScript,
  handleListZfsNodes,
  handleRemoveZfsNode,
  handleScanZfsNodeHostKey,
  handleVerifyZfsNode,
  type ZfsNodeRepo,
} from '../handlers';

const PUBLIC_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIexamplekey';
const TWO_POOLS = JSON.stringify({
  pools: {
    tank: { name: 'tank', state: 'ONLINE', vdevs: { tank: { name: 'tank', vdevs: {} } } },
    rpool: { name: 'rpool', state: 'ONLINE', vdevs: { rpool: { name: 'rpool', vdevs: {} } } },
  },
});
const TANK_LINE = 'zpool_stats,name=tank,state=ONLINE,vdev=root alloc=1u,free=1u,size=2u,read_bytes=0u,read_errors=0u,read_ops=0u,write_bytes=0u,write_errors=0u,write_ops=0u,checksum_errors=0u,fragmentation=0u 1\n';

class MemoryRepo implements ZfsNodeRepo {
  rows = new Map<number, ZfsNodeConnection & { publicKey: string }>();
  failures: [number, ZfsNodeFailure, string | null | undefined][] = [];
  verified: number[] = [];
  private nextId = 1;

  private summary(row: ZfsNodeConnection): ZfsNodeSummary {
    const { username: _username, privateKey: _privateKey, ...summary } = row;
    delete (summary as { publicKey?: string }).publicKey;
    return summary;
  }

  async list() {
    return [...this.rows.values()].map((row) => this.summary(row));
  }
  async findById(id: number) {
    const row = this.rows.get(id);
    return row ? this.summary(row) : null;
  }
  async create(input: NewZfsNode) {
    if ([...this.rows.values()].some((row) => row.name === input.name)) throw new ZfsNodeNameTakenError(input.name);
    const row = {
      id: this.nextId++, name: input.name, address: input.address, port: input.port, allowedFrom: input.allowedFrom,
      state: 'pending' as const, hostKeyFingerprint: null, seenHostKeyFingerprint: null, lastSuccessAt: null,
      username: 'hlm', privateKey: input.privateKey, publicKey: input.publicKey,
    };
    this.rows.set(row.id, row);
    return this.summary(row);
  }
  async remove(id: number) {
    const row = this.rows.get(id);
    this.rows.delete(id);
    return row ? this.summary(row) : null;
  }
  async getPublicKey(id: number) {
    const row = this.rows.get(id);
    return row ? { name: row.name, publicKey: row.publicKey, allowedFrom: row.allowedFrom } : null;
  }
  async getConnection(id: number) {
    return this.rows.get(id) ?? null;
  }
  async recordSeenHostKey(id: number, fingerprint: string) {
    this.rows.get(id)!.seenHostKeyFingerprint = fingerprint;
  }
  async confirmHostKey(id: number, fingerprint: string) {
    const row = this.rows.get(id);
    if (!row || row.seenHostKeyFingerprint !== fingerprint) return false;
    row.hostKeyFingerprint = fingerprint;
    row.seenHostKeyFingerprint = null;
    return true;
  }
  async recordFailure(id: number, state: ZfsNodeFailure, fingerprint?: string | null) {
    this.failures.push([id, state, fingerprint]);
  }
  async recordVerified(id: number) {
    this.verified.push(id);
  }
}

function deps(transport = new FakeZfsTransport()) {
  const repo = new MemoryRepo();
  return { repo, transport, probeTimer: immediateTimer, generateKeyPair: () => ({ privateKey: 'PRIVATE KEY TEXT', publicKey: PUBLIC_KEY }) };
}

async function addNode(d: ReturnType<typeof deps>) {
  const created = await handleCreateZfsNode(d, { name: 'pve1', address: 'pve1.lan', port: 22, allowedFrom: null });
  if (!created.ok) throw new Error('create failed');
  return created.node.id;
}

describe('ZFS node handlers', () => {
  test('creates a node with its own key and returns a setup script for it, never the private key', async () => {
    const d = deps();
    const created = await handleCreateZfsNode(d, { name: 'pve1', address: 'pve1.lan', port: 2222, allowedFrom: '10.0.0.5' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.setupScript).toContain(`restrict,command="${ZFS_DISPATCH_PATH}",from="10.0.0.5" ${PUBLIC_KEY} homelab-manager:pve1`);
    expect(JSON.stringify(created)).not.toContain('PRIVATE KEY TEXT');
    expect(JSON.stringify(await handleListZfsNodes(d))).not.toContain('PRIVATE KEY TEXT');
    expect((await handleGetZfsNodeSetupScript(d, { id: created.node.id }))?.setupScript).toBe(created.setupScript);
    expect(await handleGetZfsNodeSetupScript(d, { id: 99 })).toBeNull();
  });

  test('refuses a second node with the same name', async () => {
    const d = deps();
    await addNode(d);
    expect(await handleCreateZfsNode(d, { name: 'pve1', address: 'other.lan', port: 22, allowedFrom: null })).toEqual({ ok: false, code: 'name_taken' });
  });

  test('reads the host key without logging in, then pins it on confirm and reports the pools', async () => {
    const transport = new FakeZfsTransport({
      fingerprint: 'SHA256:pve1-key',
      status: { code: 0, stdout: TWO_POOLS, stderr: '' },
      influx: () => TANK_LINE,
    });
    const d = deps(transport);
    const id = await addNode(d);

    expect(await handleScanZfsNodeHostKey(d, { id })).toEqual({ ok: true, fingerprint: 'SHA256:pve1-key', confirmed: false });
    expect(transport.sessions).toHaveLength(0);

    expect(await handleConfirmZfsNodeHostKey(d, { id, fingerprint: 'SHA256:pve1-key' })).toEqual({ ok: true, pools: ['rpool', 'tank'] });
    expect(d.repo.rows.get(id)?.hostKeyFingerprint).toBe('SHA256:pve1-key');
    expect(d.repo.verified).toEqual([id]);
    expect(transport.sessions[0].closed).toBe(true);
    expect(await handleScanZfsNodeHostKey(d, { id })).toEqual({ ok: true, fingerprint: 'SHA256:pve1-key', confirmed: true });
  });

  test('will not pin a fingerprint the node did not present', async () => {
    const transport = new FakeZfsTransport({ fingerprint: 'SHA256:real' });
    const d = deps(transport);
    const id = await addNode(d);
    await handleScanZfsNodeHostKey(d, { id });

    const result = await handleConfirmZfsNodeHostKey(d, { id, fingerprint: 'SHA256:forged' });
    expect(result).toEqual({ ok: false, failure: 'host_key_changed', fingerprint: 'SHA256:real' });
    expect(d.repo.rows.get(id)?.hostKeyFingerprint).toBeNull();
    expect(transport.sessions).toHaveLength(0);
  });

  test('reports a key that changed between the scan and the confirm, reading nothing', async () => {
    const transport = new FakeZfsTransport({ fingerprint: 'SHA256:first' });
    const d = deps(transport);
    const id = await addNode(d);
    await handleScanZfsNodeHostKey(d, { id });
    transport.behaviour.fingerprint = 'SHA256:swapped';

    const result = await handleConfirmZfsNodeHostKey(d, { id, fingerprint: 'SHA256:first' });
    expect(result).toEqual({ ok: false, failure: 'host_key_changed', fingerprint: 'SHA256:swapped' });
    expect(d.repo.failures).toEqual([[id, 'host_key_changed', 'SHA256:swapped']]);
    expect(transport.sessions).toHaveLength(0);
  });

  test.each([
    ['a refused key', { connectError: new ZfsSshError('key_refused', 'auth failed') }, 'key_refused'],
    ['an unreachable node', { connectError: new ZfsSshError('unreachable', 'ECONNREFUSED') }, 'unreachable'],
    ['a missing zpool_influxdb', { status: { code: 0, stdout: EMPTY_STATUS, stderr: '' }, influxExit: 127 }, 'influxdb_missing'],
    ['a dispatcher that refuses the status read', { status: { code: 126, stdout: '', stderr: 'refused' } }, 'error'],
  ] as const)('reports %s on verify and records it', async (_label, behaviour, failure) => {
    const transport = new FakeZfsTransport({ fingerprint: 'SHA256:k', ...behaviour });
    const d = deps(transport);
    const id = await addNode(d);
    await handleScanZfsNodeHostKey(d, { id });
    const result = await handleConfirmZfsNodeHostKey(d, { id, fingerprint: 'SHA256:k' });
    expect(result).toEqual({ ok: false, failure, fingerprint: null });
    expect(d.repo.failures.at(-1)?.[1]).toBe(failure);
  });

  test('verifies a node with no pools', async () => {
    const transport = new FakeZfsTransport({ fingerprint: 'SHA256:k', status: { code: 0, stdout: EMPTY_STATUS, stderr: '' } });
    const d = deps(transport);
    const id = await addNode(d);
    await handleScanZfsNodeHostKey(d, { id });
    expect(await handleConfirmZfsNodeHostKey(d, { id, fingerprint: 'SHA256:k' })).toEqual({ ok: true, pools: [] });
  });

  test('says a new node has no ed25519 key, but treats it as a changed key once a key is pinned', async () => {
    const transport = new FakeZfsTransport({ fingerprint: 'SHA256:k' });
    const d = deps(transport);
    const id = await addNode(d);
    transport.behaviour.keyType = 'ssh-rsa';
    transport.behaviour.fingerprint = 'SHA256:rsa';
    expect(await handleScanZfsNodeHostKey(d, { id })).toEqual({ ok: false, failure: 'no_ed25519_key' });

    transport.behaviour.keyType = 'ssh-ed25519';
    transport.behaviour.fingerprint = 'SHA256:k';
    await handleScanZfsNodeHostKey(d, { id });
    await handleConfirmZfsNodeHostKey(d, { id, fingerprint: 'SHA256:k' });
    transport.behaviour.keyType = 'ssh-rsa';
    transport.behaviour.fingerprint = 'SHA256:rsa';
    expect(await handleScanZfsNodeHostKey(d, { id })).toEqual({ ok: false, failure: 'host_key_changed' });
    expect(await handleVerifyZfsNode(d, { id })).toEqual({ ok: false, failure: 'host_key_changed', fingerprint: 'SHA256:rsa' });
    expect(d.repo.rows.get(id)?.hostKeyFingerprint).toBe('SHA256:k');
  });

  test('will not verify a node whose key was never confirmed', async () => {
    const d = deps();
    const id = await addNode(d);
    expect(await handleVerifyZfsNode(d, { id })).toEqual({ ok: false, failure: 'not_confirmed', fingerprint: null });
    expect(await handleVerifyZfsNode(d, { id: 42 })).toEqual({ ok: false, failure: 'not_found', fingerprint: null });
  });

  test('removes a node', async () => {
    const d = deps();
    const id = await addNode(d);
    expect(await handleRemoveZfsNode(d, { id })).toEqual({ removed: true });
    expect(await handleRemoveZfsNode(d, { id })).toEqual({ removed: false });
  });
});
