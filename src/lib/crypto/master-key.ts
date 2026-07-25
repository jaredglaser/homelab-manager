import '@tanstack/react-start/server-only';
import { readFileSync } from 'node:fs';

export type Kid = string;

export interface MasterKeyring {
  activeKid: Kid;
  keys: Map<Kid, CryptoKey>;
}

const LEGACY_KID: Kid = 'v1';

/**
 * Load the master keyring from environment variables.
 *
 * Single-key (legacy) pattern, backward compatible:
 *   MASTER_KEY / MASTER_KEY_FILE maps to KID "v1", active key
 *
 * Multi-key pattern (for key rotation):
 *   MASTER_KEY_<KID> / MASTER_KEY_FILE_<KID>  →  additional keys by explicit KID
 *   e.g. MASTER_KEY_v2=<base64>
 *
 * The active key is the highest-ranked KID across all loaded keys (vN KIDs
 * rank numerically, so v10 outranks v9; see kidRank below).
 * During rotation both keys are present, so old ciphertext decrypts with the old
 * key while new encryptions use the new key. After running the migration CLI and
 * removing the old env var, only the new key remains.
 */
export async function loadMasterKeyring(): Promise<MasterKeyring> {
  const entries = collectKeyEntries();

  if (entries.length === 0) {
    throw new Error(
      'MASTER_KEY(_<KID>) or MASTER_KEY_FILE(_<KID>) environment variable must be set. ' +
        'Generate a key with: openssl rand -base64 32',
    );
  }

  const loaded = await Promise.all(
    entries.map(async ({ kid, raw }) => ({ kid, key: await importRawKey(raw, kid) })),
  );

  const keys = new Map<Kid, CryptoKey>(loaded.map(({ kid, key }) => [kid, key]));

  // Highest-ranked KID is the active key for new encryptions. `vN` KIDs (the
  // documented rotation scheme) order numerically so v10 outranks v9; a plain
  // string sort would leave v9 active and silently keep encrypting under the
  // old key past the 9th rotation.
  const sortedKids = [...keys.keys()].sort(compareKids);
  const activeKid = sortedKids[sortedKids.length - 1];

  return { activeKid, keys };
}

/** Rank tuple for a KID: `vN` kids compare numerically and outrank non-`vN` kids. */
function kidRank(kid: Kid): { isVersion: number; version: number; raw: string } {
  const match = /^v(\d+)$/.exec(kid);
  return match
    ? { isVersion: 1, version: Number(match[1]), raw: '' }
    : { isVersion: 0, version: 0, raw: kid };
}

/** Total order over KIDs: numeric for `vN`, byte order for anything else. */
function compareKids(a: Kid, b: Kid): number {
  const ra = kidRank(a);
  const rb = kidRank(b);
  if (ra.isVersion !== rb.isVersion) return ra.isVersion - rb.isVersion;
  if (ra.version !== rb.version) return ra.version - rb.version;
  if (ra.raw < rb.raw) return -1;
  if (ra.raw > rb.raw) return 1;
  return 0;
}

/** Parse all key env vars and return { kid, raw } pairs. */
function collectKeyEntries(): Array<{ kid: Kid; raw: string }> {
  const entries: Array<{ kid: Kid; raw: string }> = [];

  // Legacy single-key pattern: MASTER_KEY / MASTER_KEY_FILE → KID "v1"
  const legacyRaw = readLegacyKey();
  if (legacyRaw !== null) {
    entries.push({ kid: LEGACY_KID, raw: legacyRaw });
  }

  // Multi-key pattern: MASTER_KEY_<KID> / MASTER_KEY_FILE_<KID>
  for (const [name, value] of Object.entries(process.env)) {
    if (!value) continue;
    // Skip the legacy bare names handled above.
    if (name === 'MASTER_KEY' || name === 'MASTER_KEY_FILE') continue;

    // MASTER_KEY_FILE_<KID> takes priority over MASTER_KEY_<KID> for the same KID.
    const fileMatch = /^MASTER_KEY_FILE_(.+)$/.exec(name);
    if (fileMatch) {
      const kid = fileMatch[1];
      // Avoid re-registering "v1" if MASTER_KEY_FILE was already picked up above.
      if (kid !== LEGACY_KID || legacyRaw === null) {
        entries.push({ kid, raw: readFileSync(value.trim(), 'utf-8').trim() });
      }
      continue;
    }

    const keyMatch = /^MASTER_KEY_(.+)$/.exec(name);
    if (keyMatch) {
      const kid = keyMatch[1];
      // Skip if MASTER_KEY_FILE_<KID> was already collected for this KID.
      const alreadyHaveKid = entries.some((e) => e.kid === kid);
      if (!alreadyHaveKid) {
        entries.push({ kid, raw: value.trim() });
      }
    }
  }

  return entries;
}

/** Read the legacy MASTER_KEY / MASTER_KEY_FILE env vars. Returns null if neither is set. */
function readLegacyKey(): string | null {
  const filePath = process.env.MASTER_KEY_FILE;
  if (filePath && filePath.length > 0) {
    return readFileSync(filePath, 'utf-8').trim();
  }
  const fromEnv = process.env.MASTER_KEY;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  return null;
}

async function importRawKey(base64: string, kid: Kid): Promise<CryptoKey> {
  const bytes = Uint8Array.from(Buffer.from(base64, 'base64'));
  if (bytes.byteLength !== 32) {
    throw new Error(
      `Master key "${kid}" must decode to 32 bytes; got ${bytes.byteLength}. ` +
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
