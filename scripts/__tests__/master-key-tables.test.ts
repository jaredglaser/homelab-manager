import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { decryptValue, encryptValue } from '@/lib/crypto/encrypted-value';
import { ZfsNodeRepository } from '@/lib/database/repositories/zfs-node-repository';
import { TABLE_MIGRATIONS, ZFS_NODES, migrateTable } from '../master-key-tables';

async function aesKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

describe('migrate-master-key', () => {
  test('re-encrypts each ZFS node key to the new kid, and the node repository still reads it', async () => {
    const v1 = await aesKey();
    const v2 = await aesKey();
    const oldRing: MasterKeyring = { activeKid: 'v1', keys: new Map([['v1', v1]]) };
    const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nnode key\n-----END OPENSSH PRIVATE KEY-----\n';
    const rows = [{ id: 4, private_key_jwe: await encryptValue(privateKey, oldRing) }];
    const updates: unknown[][] = [];
    const pool = {
      query: async () => ({ rows }),
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          if (sql.startsWith('UPDATE')) updates.push(params ?? []);
          return { rows: [] };
        },
        release: () => {},
      }),
    } as unknown as Pool;

    const migrated = await migrateTable(pool, { fromKid: 'v1', toKid: 'v2', fromKey: v1, toKey: v2 }, ZFS_NODES);

    expect(migrated).toBe(1);
    const [newJwe, id] = updates[0] as [string, number];
    expect(id).toBe(4);
    const newRing: MasterKeyring = { activeKid: 'v2', keys: new Map([['v2', v2]]) };
    expect(await decryptValue(newJwe, newRing)).toBe(privateKey);

    const repoPool = {
      query: async () => ({
        rows: [{
          id: 4, name: 'pve1', address: 'pve1.lan', port: 22, allowed_from: null, state: 'ok',
          host_key_fingerprint: 'SHA256:k', seen_host_key_fingerprint: null, last_success_at: null,
          username: 'hlm', private_key_jwe: newJwe,
        }],
      }),
    } as unknown as Pool;
    const [connection] = await new ZfsNodeRepository(repoPool, newRing).listConfirmedConnections();
    expect(connection.privateKey).toBe(privateKey);
  });

  test('re-encrypts rows of every table under the old kid, skips other kids, and rolls back a row it cannot decrypt', async () => {
    const v1 = await aesKey();
    const v2 = await aesKey();
    const oldRing: MasterKeyring = { activeKid: 'v1', keys: new Map([['v1', v1]]) };
    const otherRing: MasterKeyring = { activeKid: 'v9', keys: new Map([['v9', await aesKey()]]) };
    const keys = { fromKid: 'v1', toKid: 'v2', fromKey: v1, toKey: v2 };
    const fixtures = {
      stack_secrets: (jwe: string) => ({ stack_name: 's', variable_name: 'v', ciphertext_jwe: jwe }),
      agent_keypairs: (jwe: string) => ({ host_name: 'h', private_jwk_jwe: jwe }),
      git_tokens: (jwe: string) => ({ id: 1, encrypted_token: jwe }),
      zfs_nodes: (jwe: string) => ({ id: 1, private_key_jwe: jwe }),
    } as const;

    for (const spec of TABLE_MIGRATIONS) {
      const make = fixtures[spec.table as keyof typeof fixtures];
      const rows = [make(await encryptValue('secret', oldRing)), make(await encryptValue('secret', otherRing))];
      const statements: string[] = [];
      const pool = {
        query: async () => ({ rows }),
        connect: async () => ({
          query: async (sql: string) => {
            statements.push(sql.trim().split(/\s+/)[0]);
            return { rows: [] };
          },
          release: () => {},
        }),
      } as unknown as Pool;
      expect(await migrateTable(pool, keys, spec as never)).toBe(1);
      expect(statements).toEqual(['BEGIN', 'UPDATE', 'COMMIT']);
    }

    const broken = [{ id: 7, private_key_jwe: (await encryptValue('secret', oldRing)).replace(/\.[^.]+\.[^.]+$/, '.AAAA.AAAA') }];
    const statements: string[] = [];
    const pool = {
      query: async () => ({ rows: broken }),
      connect: async () => ({
        query: async (sql: string) => {
          statements.push(sql);
          return { rows: [] };
        },
        release: () => {},
      }),
    } as unknown as Pool;
    await expect(migrateTable(pool, keys, ZFS_NODES)).rejects.toThrow('Failed to migrate zfs_nodes(7)');
    expect(statements).toEqual(['BEGIN', 'ROLLBACK']);
  });

  test('covers every encrypted column the app stores', () => {
    expect(TABLE_MIGRATIONS.map((migration) => migration.table)).toEqual(['stack_secrets', 'agent_keypairs', 'git_tokens', 'zfs_nodes']);
  });
});
