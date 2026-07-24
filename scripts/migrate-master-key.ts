#!/usr/bin/env bun
/**
 * Master key migration CLI.
 *
 * Re-encrypts all JWE-encrypted values in stack_secrets, agent_keypairs, and
 * git_tokens from one key version (--from <kid>) to another (--to <kid>).
 * Session rows (sessions.encrypted_oidc) are deliberately excluded: they
 * expire on their own TTL and an undecryptable session only forces a re-login.
 *
 * Both keys must be present in the environment at runtime so that the old key
 * can still decrypt existing ciphertext while the new key encrypts the result.
 * Rows encrypted under a different KID are left untouched.
 *
 * Usage:
 *   bun run scripts/migrate-master-key.ts --from v1 --to v2
 *
 * On failure the process exits non-zero. Partially migrated rows are safe:
 * the old key is still in the keyring and can decrypt them on the next run.
 */
import { readFileSync } from 'node:fs';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { compactDecrypt, CompactEncrypt } from 'jose';

// ---- CLI arg parsing -------------------------------------------------------

function parseArgs(): { from: string; to: string } {
  const args = process.argv.slice(2);
  let from: string | undefined;
  let to: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from' && i + 1 < args.length) {
      from = args[++i];
    } else if (args[i] === '--to' && i + 1 < args.length) {
      to = args[++i];
    }
  }

  if (!from || !to) {
    console.error('Usage: bun run scripts/migrate-master-key.ts --from <kid> --to <kid>');
    process.exit(1);
  }
  if (from === to) {
    console.error('--from and --to must be different KIDs');
    process.exit(1);
  }

  return { from, to };
}

// ---- Key loading (inline, no imports from src/ so this runs standalone) ---

const KEY_ALG = 'dir';
const ENC_ALG = 'A256GCM';

async function loadKey(kid: string): Promise<CryptoKey> {
  const raw = readKeyBase64(kid);
  const bytes = Uint8Array.from(Buffer.from(raw, 'base64'));
  if (bytes.byteLength !== 32) {
    throw new Error(
      `Key "${kid}" must decode to 32 bytes; got ${bytes.byteLength}. ` +
        `Generate with: openssl rand -base64 32`,
    );
  }
  return crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function readKeyBase64(kid: string): string {
  // MASTER_KEY_FILE_<KID> takes priority over MASTER_KEY_<KID>
  const fileSuffix = `MASTER_KEY_FILE_${kid}`;
  const keySuffix = `MASTER_KEY_${kid}`;

  // Legacy KID "v1" also maps to MASTER_KEY_FILE / MASTER_KEY
  if (kid === 'v1') {
    const legacyFile = process.env.MASTER_KEY_FILE;
    if (legacyFile && legacyFile.length > 0) {
      return readFileSync(legacyFile, 'utf-8').trim();
    }
    const legacyKey = process.env.MASTER_KEY;
    if (legacyKey && legacyKey.trim().length > 0) {
      return legacyKey.trim();
    }
  }

  const fileEnv = process.env[fileSuffix];
  if (fileEnv && fileEnv.length > 0) {
    return readFileSync(fileEnv, 'utf-8').trim();
  }

  const keyEnv = process.env[keySuffix];
  if (keyEnv && keyEnv.trim().length > 0) {
    return keyEnv.trim();
  }

  throw new Error(
    `No key found for KID "${kid}". ` +
      `Set MASTER_KEY_${kid} or MASTER_KEY_FILE_${kid} (or MASTER_KEY/MASTER_KEY_FILE for "v1").`,
  );
}

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

// ---- Database helpers -------------------------------------------------------

function buildPool(): Pool {
  return new Pool({
    host: process.env.POSTGRES_HOST ?? 'localhost',
    port: parseInt(process.env.POSTGRES_PORT ?? '5432', 10),
    database: process.env.POSTGRES_DB ?? 'homelab',
    user: process.env.POSTGRES_USER ?? 'homelab',
    password: process.env.POSTGRES_PASSWORD ?? '',
    max: 3,
  });
}

// ---- Migration logic --------------------------------------------------------

interface KeyContext {
  fromKid: string;
  toKid: string;
  fromKey: CryptoKey;
  toKey: CryptoKey;
}

interface TableMigration<Row extends QueryResultRow> {
  table: string;
  select: string;
  ciphertextOf: (row: Row) => string | null;
  describe: (row: Row) => string;
  update: (client: PoolClient, row: Row, newJwe: string) => Promise<unknown>;
}

async function migrateTable<Row extends QueryResultRow>(
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

const STACK_SECRETS: TableMigration<{
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

const AGENT_KEYPAIRS: TableMigration<{ host_name: string; private_jwk_jwe: string }> = {
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

const GIT_TOKENS: TableMigration<{ id: number; encrypted_token: string }> = {
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

// ---- Entry point ------------------------------------------------------------

async function main(): Promise<void> {
  const { from: fromKid, to: toKid } = parseArgs();

  console.info(`Loading keys: from="${fromKid}", to="${toKid}"`);
  const [fromKey, toKey] = await Promise.all([loadKey(fromKid), loadKey(toKid)]);
  console.info('Keys loaded successfully.');

  const pool = buildPool();

  try {
    await pool.query('SELECT 1');
    console.info('Database connected.');

    const keys: KeyContext = { fromKid, toKid, fromKey, toKey };

    const secretsMigrated = await migrateTable(pool, keys, STACK_SECRETS);
    const keypairsMigrated = await migrateTable(pool, keys, AGENT_KEYPAIRS);
    const tokensMigrated = await migrateTable(pool, keys, GIT_TOKENS);

    console.info(`Migration complete: ${secretsMigrated} secret(s), ${keypairsMigrated} keypair(s), ${tokensMigrated} git token(s) migrated.`);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

await main();
