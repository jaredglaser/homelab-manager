import { describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { decryptValue, encryptValue } from '@/lib/crypto/encrypted-value';
import { ProxmoxConnectionRepository } from '@/lib/database/repositories/proxmox-connection-repository';
import { TABLE_MIGRATIONS, migrateAllTables, migrateTable } from '../master-key-tables';

async function aesKey(): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', crypto.getRandomValues(new Uint8Array(32)), { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

const fixtures = {
  stack_secrets: (jwe: string) => ({ stack_name: 's', variable_name: 'v', ciphertext_jwe: jwe }),
  agent_keypairs: (jwe: string) => ({ host_name: 'h', private_jwk_jwe: jwe }),
  git_tokens: (jwe: string) => ({ id: 1, encrypted_token: jwe }),
  proxmox_connections: (jwe: string) => ({ id: 1, token_secret_jwe: jwe }),
} as const;

describe('migrate-master-key', () => {
  test('re-encrypts the Proxmox token secret with the rest, and the worker still reads the same secret', async () => {
    const v1 = await aesKey();
    const v2 = await aesKey();
    const oldRing: MasterKeyring = { activeKid: 'v1', keys: new Map([['v1', v1]]) };
    const secret = '12345678-aaaa-bbbb-cccc-1234567890ab';
    const proxmoxRow = { id: 3, token_secret_jwe: await encryptValue(secret, oldRing) };
    const updates: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: (sql: string) => Promise.resolve({ rows: sql.includes('FROM proxmox_connections') ? [proxmoxRow] : [] }),
      connect: async () => ({
        query: async (sql: string, params?: unknown[]) => {
          if (sql.trim().startsWith('UPDATE')) updates.push({ sql, params: params ?? [] });
          return { rows: [] };
        },
        release: () => undefined,
      }),
    } as unknown as Pool;

    const counts = await migrateAllTables(pool, { fromKid: 'v1', toKid: 'v2', fromKey: v1, toKey: v2 });

    expect(counts.proxmox_connections).toBe(1);
    const update = updates.find((u) => u.sql.includes('UPDATE proxmox_connections'));
    const [newJwe, id] = update!.params as [string, number];
    expect(id).toBe(3);
    const newRing: MasterKeyring = { activeKid: 'v2', keys: new Map([['v1', v1], ['v2', v2]]) };
    expect((JSON.parse(Buffer.from(newJwe.split('.')[0], 'base64url').toString()) as { kid: string }).kid).toBe('v2');

    const repoPool = {
      query: () => Promise.resolve({
        rows: [{ id: 3, name: 'homelab', address: 'pve.lan', port: 8006, token_id: 'root@pam!hlm', allow_self_signed: true, token_secret_jwe: newJwe }],
      }),
    } as unknown as Pool;
    const [forWorker] = await new ProxmoxConnectionRepository(repoPool, newRing).listForWorker();
    expect(forWorker.connection?.tokenSecret).toBe(secret);
    expect(await decryptValue(newJwe, newRing)).toBe(secret);
  });

  test('re-encrypts rows of every table under the old kid and skips other kids', async () => {
    const v1 = await aesKey();
    const v2 = await aesKey();
    const oldRing: MasterKeyring = { activeKid: 'v1', keys: new Map([['v1', v1]]) };
    const otherRing: MasterKeyring = { activeKid: 'v9', keys: new Map([['v9', await aesKey()]]) };
    const keys = { fromKid: 'v1', toKid: 'v2', fromKey: v1, toKey: v2 };

    for (const spec of TABLE_MIGRATIONS) {
      const make = fixtures[spec.table as keyof typeof fixtures];
      const rows = [make(await encryptValue('secret', oldRing)), make(await encryptValue('secret', otherRing))];
      const statements: string[] = [];
      const pool = {
        query: () => Promise.resolve({ rows }),
        connect: async () => ({
          query: async (sql: string) => {
            statements.push(sql.trim().split(/\s+/)[0]);
            return { rows: [] };
          },
          release: () => undefined,
        }),
      } as unknown as Pool;
      expect(await migrateTable(pool, keys, spec as never)).toBe(1);
      expect(statements).toEqual(['BEGIN', 'UPDATE', 'COMMIT']);
    }
  });

  test('covers every encrypted column the app stores', () => {
    expect(TABLE_MIGRATIONS.map((migration) => migration.table)).toEqual(Object.keys(fixtures));
  });
});
