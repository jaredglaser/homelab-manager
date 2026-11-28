import { beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { decryptValue } from '@/lib/crypto/encrypted-value';
import { createMockPool } from '@/lib/test/mock-pool';
import { ZFS_NODES_NOTIFY_CHANNEL, ZfsNodeNameTakenError, ZfsNodeRepository } from '../zfs-node-repository';

let keyring: MasterKeyring;

beforeAll(async () => {
  const key = await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  keyring = { activeKid: 'v1', keys: new Map([['v1', key]]) };
});

const ROW = {
  id: 3,
  name: 'pve1',
  address: 'pve1.lan',
  port: 22,
  allowed_from: null,
  state: 'ok',
  host_key_fingerprint: 'SHA256:pinned',
  seen_host_key_fingerprint: null,
  last_success_at: new Date(5000),
};

describe('ZfsNodeRepository', () => {
  test('stores the private key encrypted, never in the clear, and tells the worker', async () => {
    const mock = createMockPool();
    mock.pushResult([{ ...ROW, state: 'pending', host_key_fingerprint: null, last_success_at: null }]);
    const repo = new ZfsNodeRepository(mock.pool, keyring);
    const node = await repo.create({ name: 'pve1', address: 'pve1.lan', port: 22, allowedFrom: null, privateKey: 'SECRET KEY', publicKey: 'ssh-ed25519 AAAA' });

    expect(node).toEqual({
      id: 3, name: 'pve1', address: 'pve1.lan', port: 22, allowedFrom: null, state: 'pending',
      hostKeyFingerprint: null, seenHostKeyFingerprint: null, lastSuccessAt: null,
    });
    const [insert, notify] = mock.queries;
    expect(JSON.stringify(insert.params)).not.toContain('SECRET KEY');
    expect(await decryptValue(insert.params[4] as string, keyring)).toBe('SECRET KEY');
    expect(notify.params).toEqual([ZFS_NODES_NOTIFY_CHANNEL, 'pve1']);
  });

  test('turns a duplicate name into a name-taken error', async () => {
    const mock = createMockPool();
    mock.setError(Object.assign(new Error('duplicate key'), { code: '23505' }));
    await expect(new ZfsNodeRepository(mock.pool, keyring).create({
      name: 'pve1', address: 'a', port: 22, allowedFrom: null, privateKey: 'k', publicKey: 'p',
    })).rejects.toBeInstanceOf(ZfsNodeNameTakenError);
  });

  test('never selects the private key for the summary reads', async () => {
    const mock = createMockPool([ROW]);
    const repo = new ZfsNodeRepository(mock.pool, keyring);
    expect(await repo.list()).toEqual([expect.objectContaining({ name: 'pve1', lastSuccessAt: 5000, hostKeyFingerprint: 'SHA256:pinned' })]);
    expect(await repo.findById(3)).toEqual(expect.objectContaining({ id: 3 }));
    for (const query of mock.queries) expect(query.sql).not.toContain('private_key_jwe');
  });

  test('decrypts the key for the worker and reports a key it cannot decrypt by node', async () => {
    const mock = createMockPool();
    const repo = new ZfsNodeRepository(mock.pool, keyring);
    mock.pushResult([]);
    expect(await repo.getConnection(9)).toBeNull();
    mock.pushResult([{ ...ROW, username: 'hlm', private_key_jwe: 'not-a-jwe' }]);
    await expect(repo.listConfirmedConnections()).rejects.toThrow('ZFS node key decryption failed for pve1');
    expect(mock.queries.at(-1)?.sql).toContain('WHERE host_key_fingerprint IS NOT NULL');
  });

  test('pins only the fingerprint the node presented, and notifies only when it pinned one', async () => {
    const mock = createMockPool();
    const repo = new ZfsNodeRepository(mock.pool, keyring);
    mock.pushResult([]);
    expect(await repo.confirmHostKey(3, 'SHA256:other')).toBe(false);
    expect(mock.queries).toHaveLength(1);
    expect(mock.queries[0].sql).toContain('AND seen_host_key_fingerprint = $2');

    mock.pushResult([{ name: 'pve1' }]);
    expect(await repo.confirmHostKey(3, 'SHA256:seen')).toBe(true);
    expect(mock.queries.at(-1)?.params).toEqual([ZFS_NODES_NOTIFY_CHANNEL, 'pve1']);
  });

  test('records states, the seen key and successes without a notify, so the worker does not reconcile on its own writes', async () => {
    const mock = createMockPool();
    const repo = new ZfsNodeRepository(mock.pool, keyring);
    await repo.recordSeenHostKey(3, 'SHA256:seen');
    await repo.recordFailure(3, 'host_key_changed', 'SHA256:new');
    await repo.recordFailure(3, 'unreachable');
    await repo.recordSuccess(3, new Date(7000));
    await repo.recordVerified(3);

    expect(mock.queries.map((query) => query.params)).toEqual([
      [3, 'SHA256:seen'],
      [3, 'host_key_changed', 'SHA256:new'],
      [3, 'unreachable', null],
      [3, new Date(7000)],
      [3],
    ]);
    expect(mock.queries.some((query) => query.sql.includes('pg_notify'))).toBe(false);
  });

  test('removes a node, leaves its stats alone and notifies the worker', async () => {
    const mock = createMockPool();
    const repo = new ZfsNodeRepository(mock.pool, keyring);
    mock.pushResult([ROW]);
    expect(await repo.remove(3)).toEqual(expect.objectContaining({ name: 'pve1' }));
    expect(mock.queries[0].sql).toContain('DELETE FROM zfs_nodes');
    expect(mock.queries.some((query) => query.sql.includes('zfs_stats'))).toBe(false);
    expect(mock.queries.at(-1)?.params).toEqual([ZFS_NODES_NOTIFY_CHANNEL, 'pve1']);
    mock.pushResult([]);
    expect(await repo.remove(3)).toBeNull();
  });

  test('reads the public key for the setup script', async () => {
    const mock = createMockPool();
    const repo = new ZfsNodeRepository(mock.pool, keyring);
    mock.pushResult([{ name: 'pve1', public_key: 'ssh-ed25519 AAAA', allowed_from: '10.0.0.5' }]);
    expect(await repo.getPublicKey(3)).toEqual({ name: 'pve1', publicKey: 'ssh-ed25519 AAAA', allowedFrom: '10.0.0.5' });
    mock.pushResult([]);
    expect(await repo.getPublicKey(4)).toBeNull();
  });

  test('logs a failed notify instead of failing the write', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    const pool = {
      query: async () => {
        calls++;
        if (calls === 2) throw new Error('notify down');
        return { rows: [ROW] };
      },
    } as never;
    expect(await new ZfsNodeRepository(pool, keyring).remove(3)).not.toBeNull();
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
