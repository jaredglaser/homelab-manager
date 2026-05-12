#!/usr/bin/env bun
/**
 * Master key migration CLI.
 *
 * Re-encrypts all JWE-encrypted values in stack_secrets and agent_keypairs
 * from one key version (--from <kid>) to another (--to <kid>).
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
import { Pool } from 'pg';
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

async function migrateStackSecrets(
  pool: Pool,
  fromKid: string,
  toKid: string,
  fromKey: CryptoKey,
  toKey: CryptoKey,
): Promise<number> {
  const result = await pool.query<{ stack_name: string; variable_name: string; ciphertext_jwe: string }>(
    'SELECT stack_name, variable_name, ciphertext_jwe FROM stack_secrets',
  );

  let count = 0;

  for (const row of result.rows) {
    if (extractKid(row.ciphertext_jwe) !== fromKid) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const plaintext = await decryptJwe(row.ciphertext_jwe, fromKey);
      const newJwe = await encryptJwe(plaintext, toKid, toKey);

      await client.query(
        `UPDATE stack_secrets
            SET ciphertext_jwe = $1, updated_at = now()
          WHERE stack_name = $2 AND variable_name = $3`,
        [newJwe, row.stack_name, row.variable_name],
      );

      await client.query('COMMIT');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(
        `Failed to migrate stack_secrets(${row.stack_name}, ${row.variable_name}): ${String(err)}`,
      );
    } finally {
      client.release();
    }
  }

  return count;
}

async function migrateAgentKeypairs(
  pool: Pool,
  fromKid: string,
  toKid: string,
  fromKey: CryptoKey,
  toKey: CryptoKey,
): Promise<number> {
  const result = await pool.query<{ host_name: string; private_jwk_jwe: string }>(
    'SELECT host_name, private_jwk_jwe FROM agent_keypairs',
  );

  let count = 0;

  for (const row of result.rows) {
    if (extractKid(row.private_jwk_jwe) !== fromKid) continue;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const plaintext = await decryptJwe(row.private_jwk_jwe, fromKey);
      const newJwe = await encryptJwe(plaintext, toKid, toKey);

      await client.query(
        `UPDATE agent_keypairs
            SET private_jwk_jwe = $1, rotated_at = now()
          WHERE host_name = $2`,
        [newJwe, row.host_name],
      );

      await client.query('COMMIT');
      count++;
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(
        `Failed to migrate agent_keypairs(${row.host_name}): ${String(err)}`,
      );
    } finally {
      client.release();
    }
  }

  return count;
}

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

    const secretsMigrated = await migrateStackSecrets(pool, fromKid, toKid, fromKey, toKey);
    const keypairsMigrated = await migrateAgentKeypairs(pool, fromKid, toKid, fromKey, toKey);

    console.info(`Migration complete: ${secretsMigrated} secret(s), ${keypairsMigrated} keypair(s) migrated.`);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

await main();
