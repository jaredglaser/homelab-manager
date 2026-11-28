import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { compactDecrypt, CompactEncrypt } from 'jose';

const KEY_ALG = 'dir';
const ENC_ALG = 'A256GCM';

async function decryptJwe(jwe: string, key: CryptoKey): Promise<string> {
  const { plaintext } = await compactDecrypt(jwe, key);
  return new TextDecoder().decode(plaintext);
}

async function encryptJwe(plaintext: string, kid: string, key: CryptoKey): Promise<string> {
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({ alg: KEY_ALG, enc: ENC_ALG, kid })
    .encrypt(key);
}

/** Extract the KID from a JWE compact serialization without full decryption. */
function extractKid(jwe: string): string | null {
  const header = jwe.split('.')[0];
  if (!header) return null;
  try {
    const decoded = JSON.parse(Buffer.from(header, 'base64url').toString('utf-8')) as Record<string, unknown>;
    return typeof decoded.kid === 'string' ? decoded.kid : null;
  } catch {
    return null;
  }
}

export interface KeyContext {
  fromKid: string;
  toKid: string;
  fromKey: CryptoKey;
  toKey: CryptoKey;
}

export interface TableMigration<Row extends QueryResultRow> {
  table: string;
  select: string;
  ciphertextOf: (row: Row) => string | null;
  describe: (row: Row) => string;
  update: (client: PoolClient, row: Row, newJwe: string) => Promise<unknown>;
}

export async function migrateTable<Row extends QueryResultRow>(
  pool: Pool,
  keys: KeyContext,
  spec: TableMigration<Row>,
): Promise<number> {
  const result = await pool.query<Row>(spec.select);

  let count = 0;

  for (const row of result.rows) {
    const ciphertext = spec.ciphertextOf(row);
    if (ciphertext === null) continue;
    if (extractKid(ciphertext) !== keys.fromKid) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const plaintext = await decryptJwe(ciphertext, keys.fromKey);
      const newJwe = await encryptJwe(plaintext, keys.toKid, keys.toKey);

      await spec.update(client, row, newJwe);

      await client.query('COMMIT');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to migrate ${spec.table}(${spec.describe(row)}): ${String(err)}`);
    } finally {
      client.release();
    }
  }

  return count;
}

export const STACK_SECRETS: TableMigration<{
  stack_name: string;
  variable_name: string;
  ciphertext_jwe: string;
}> = {
  table: 'stack_secrets',
  select: 'SELECT stack_name, variable_name, ciphertext_jwe FROM stack_secrets',
  ciphertextOf: row => row.ciphertext_jwe,
  describe: row => `${row.stack_name}, ${row.variable_name}`,
  update: (client, row, newJwe) =>
    client.query(
      `UPDATE stack_secrets
          SET ciphertext_jwe = $1, updated_at = now()
        WHERE stack_name = $2 AND variable_name = $3`,
      [newJwe, row.stack_name, row.variable_name],
    ),
};

export const AGENT_KEYPAIRS: TableMigration<{ host_name: string; private_jwk_jwe: string }> = {
  table: 'agent_keypairs',
  select: 'SELECT host_name, private_jwk_jwe FROM agent_keypairs',
  ciphertextOf: row => row.private_jwk_jwe,
  describe: row => row.host_name,
  update: (client, row, newJwe) =>
    client.query(
      `UPDATE agent_keypairs
          SET private_jwk_jwe = $1, rotated_at = now()
        WHERE host_name = $2`,
      [newJwe, row.host_name],
    ),
};

export const GIT_TOKENS: TableMigration<{ id: number; encrypted_token: string }> = {
  table: 'git_tokens',
  select: 'SELECT id, encrypted_token FROM git_tokens',
  ciphertextOf: row => row.encrypted_token,
  describe: row => String(row.id),
  update: (client, row, newJwe) =>
    client.query(
      `UPDATE git_tokens
          SET encrypted_token = $1
        WHERE id = $2`,
      [newJwe, row.id],
    ),
};

export const ZFS_NODES: TableMigration<{ id: number; private_key_jwe: string }> = {
  table: 'zfs_nodes',
  select: 'SELECT id, private_key_jwe FROM zfs_nodes',
  ciphertextOf: row => row.private_key_jwe,
  describe: row => String(row.id),
  update: (client, row, newJwe) =>
    client.query(
      `UPDATE zfs_nodes
          SET private_key_jwe = $1
        WHERE id = $2`,
      [newJwe, row.id],
    ),
};

export const TABLE_MIGRATIONS = [STACK_SECRETS, AGENT_KEYPAIRS, GIT_TOKENS, ZFS_NODES] as const;

export async function migrateAllTables(pool: Pool, keys: KeyContext): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const spec of TABLE_MIGRATIONS) {
    counts[spec.table] = await migrateTable(pool, keys, spec as TableMigration<QueryResultRow>);
  }
  return counts;
}
