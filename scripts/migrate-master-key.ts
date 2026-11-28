#!/usr/bin/env bun
/**
 * Master key migration CLI.
 *
 * Re-encrypts all JWE-encrypted values in stack_secrets, agent_keypairs,
 * git_tokens and zfs_nodes from one key version (--from <kid>) to another (--to <kid>).
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
import { Pool } from 'pg';
import { migrateAllTables, type KeyContext } from './master-key-tables';

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

    const counts = await migrateAllTables(pool, keys);
    console.info(`Migration complete: ${Object.entries(counts).map(([table, count]) => `${count} row(s) in ${table}`).join(', ')}.`);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

await main();
