import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadMasterKeyring } from './master-key';

// Stable 32-byte key fixtures (different bytes so cross-key decryption fails predictably).
const KEY_A = Buffer.alloc(32, 0xaa).toString('base64');
const KEY_B = Buffer.alloc(32, 0xbb).toString('base64');
const KEY_C = Buffer.alloc(32, 0xcc).toString('base64');

describe('loadMasterKeyring', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hlm-master-key-'));
    // Wipe all MASTER_KEY* vars so tests start from a blank slate.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('MASTER_KEY')) delete process.env[k];
    }
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads from MASTER_KEY_FILE when set', async () => {
    const file = join(tmpDir, 'master.key');
    writeFileSync(file, Buffer.alloc(32, 1).toString('base64'));
    process.env.MASTER_KEY_FILE = file;
    const keyring = await loadMasterKeyring();
    expect(keyring.activeKid).toBe('v1');
    expect(keyring.keys.has('v1')).toBe(true);
    expect(keyring.keys.size).toBe(1);
  });

  it('falls back to MASTER_KEY env var when MASTER_KEY_FILE not set', async () => {
    process.env.MASTER_KEY = KEY_A;
    const keyring = await loadMasterKeyring();
    expect(keyring.activeKid).toBe('v1');
    expect(keyring.keys.size).toBe(1);
  });

  it('prefers MASTER_KEY_FILE over MASTER_KEY when both are set', async () => {
    const file = join(tmpDir, 'master.key');
    writeFileSync(file, KEY_A);
    process.env.MASTER_KEY_FILE = file;
    process.env.MASTER_KEY = KEY_B;

    const fileKeyring = await loadMasterKeyring();

    // Load a separate keyring from the env var (different bytes) to confirm priority.
    delete process.env.MASTER_KEY_FILE;
    const envKeyring = await loadMasterKeyring();

    const { encryptValue, decryptValue } = await import('@/lib/crypto/encrypted-value');

    const ciphertext = await encryptValue('hello', fileKeyring);
    expect(await decryptValue(ciphertext, fileKeyring)).toBe('hello');
    // Env keyring has different key bytes and cannot decrypt.
    await expect(decryptValue(ciphertext, envKeyring)).rejects.toThrow();
  });

  it('throws when neither env var is set', async () => {
    await expect(loadMasterKeyring()).rejects.toThrow(/MASTER_KEY/);
  });

  it('throws when key does not decode to 32 bytes', async () => {
    process.env.MASTER_KEY = Buffer.alloc(16).toString('base64');
    await expect(loadMasterKeyring()).rejects.toThrow(/32 bytes/);
  });



  it('loads multiple keys and selects the lexicographically last KID as active', async () => {
    process.env.MASTER_KEY = KEY_A;       // KID "v1"
    process.env.MASTER_KEY_v2 = KEY_B;    // KID "v2"
    const keyring = await loadMasterKeyring();
    expect(keyring.activeKid).toBe('v2');
    expect(keyring.keys.size).toBe(2);
    expect(keyring.keys.has('v1')).toBe(true);
    expect(keyring.keys.has('v2')).toBe(true);
  });

  it('can decrypt old ciphertext (v1) while new encryptions use v2', async () => {
    const { encryptValue, decryptValue } = await import('@/lib/crypto/encrypted-value');

    // Simulate existing setup: only v1 key present.
    process.env.MASTER_KEY = KEY_A;
    const oldKeyring = await loadMasterKeyring();
    const oldCiphertext = await encryptValue('secret', oldKeyring);

    // Add v2 key — both keys present during rotation window.
    process.env.MASTER_KEY_v2 = KEY_B;
    const twoKeyKeyring = await loadMasterKeyring();

    // Active key switches to v2.
    expect(twoKeyKeyring.activeKid).toBe('v2');

    // Old ciphertext (encrypted under v1) still decrypts.
    expect(await decryptValue(oldCiphertext, twoKeyKeyring)).toBe('secret');

    // New ciphertext is encrypted under v2.
    const newCiphertext = await encryptValue('secret', twoKeyKeyring);
    const header = JSON.parse(
      Buffer.from(newCiphertext.split('.')[0], 'base64url').toString(),
    ) as Record<string, string>;
    expect(header.kid).toBe('v2');
  });

  it('uses MASTER_KEY_FILE_<KID> over MASTER_KEY_<KID> for the same KID', async () => {
    const file = join(tmpDir, 'v2.key');
    writeFileSync(file, KEY_C);
    process.env.MASTER_KEY = KEY_A;
    process.env.MASTER_KEY_v2 = KEY_B;      // should be overridden by the file
    process.env.MASTER_KEY_FILE_v2 = file;  // KEY_C wins

    const keyring = await loadMasterKeyring();
    expect(keyring.activeKid).toBe('v2');
    expect(keyring.keys.size).toBe(2);

    const { encryptValue, decryptValue } = await import('@/lib/crypto/encrypted-value');

    // Encrypt with the keyring (uses v2 = KEY_C).
    const ct = await encryptValue('x', keyring);

    // A keyring with KEY_B for v2 cannot decrypt — confirms KEY_C won.
    const keyBforV2 = await crypto.subtle.importKey(
      'raw',
      Buffer.from(KEY_B, 'base64'),
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    const wrongKeyring = {
      activeKid: 'v2',
      keys: new Map([['v2', keyBforV2]]),
    };
    await expect(decryptValue(ct, wrongKeyring)).rejects.toThrow();
  });

  it('throws a controlled error when KID is unknown at decryption time', async () => {
    const { encryptValue, decryptValue } = await import('@/lib/crypto/encrypted-value');

    process.env.MASTER_KEY = KEY_A;
    const keyring = await loadMasterKeyring();
    const ct = await encryptValue('x', keyring);

    // Keyring with no keys at all — should throw "Unknown JWE kid".
    const emptyKeyring = { activeKid: 'v1', keys: new Map<string, CryptoKey>() };
    await expect(decryptValue(ct, emptyKeyring)).rejects.toThrow(/Unknown JWE kid/);
  });

  it('throws when a multi-key entry does not decode to 32 bytes', async () => {
    process.env.MASTER_KEY = KEY_A;
    process.env.MASTER_KEY_v2 = Buffer.alloc(10).toString('base64');
    await expect(loadMasterKeyring()).rejects.toThrow(/32 bytes/);
  });

  // KIDs are sorted lexicographically: 'v9' > 'v10' because '9' > '1'.
  // Operators needing more than 9 versions should use zero-padded names
  // (v01, v02, ..., v10) to preserve natural ordering.
  it('lexicographic ordering picks v9 over v10 (natural vs lex sort awareness)', async () => {
    // Lex sort: "v10" < "v9" because "1" < "9" char comparison.
    // The active key should be "v9" (lexicographically last).
    process.env.MASTER_KEY_v10 = KEY_A;
    process.env.MASTER_KEY_v9 = KEY_B;
    const keyring = await loadMasterKeyring();
    expect(keyring.activeKid).toBe('v9');
  });
});
