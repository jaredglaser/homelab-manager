import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadMasterKeyring } from './master-key';

describe('loadMasterKeyring', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'hlm-master-key-'));
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads from MASTER_KEY_FILE when set', async () => {
    const file = join(tmpDir, 'master.key');
    writeFileSync(file, Buffer.alloc(32, 1).toString('base64'));
    process.env.MASTER_KEY_FILE = file;
    delete process.env.MASTER_KEY;
    const keyring = await loadMasterKeyring();
    expect(keyring.activeKid).toBe('v1');
    expect(keyring.keys.has('v1')).toBe(true);
  });

  it('falls back to MASTER_KEY env var when MASTER_KEY_FILE not set', async () => {
    delete process.env.MASTER_KEY_FILE;
    process.env.MASTER_KEY = Buffer.alloc(32, 2).toString('base64');
    const keyring = await loadMasterKeyring();
    expect(keyring.activeKid).toBe('v1');
  });

  it('prefers MASTER_KEY_FILE over MASTER_KEY when both are set', async () => {
    const fileBytes = Buffer.alloc(32, 0xAA);
    const file = join(tmpDir, 'master.key');
    writeFileSync(file, fileBytes.toString('base64'));
    process.env.MASTER_KEY_FILE = file;
    process.env.MASTER_KEY = Buffer.alloc(32, 0xBB).toString('base64');
    const keyring = await loadMasterKeyring();
    const exported = await crypto.subtle.exportKey('raw', keyring.keys.get('v1')!);
    expect(Buffer.from(exported).equals(fileBytes)).toBe(true);
  });

  it('throws when neither env var is set', async () => {
    delete process.env.MASTER_KEY_FILE;
    delete process.env.MASTER_KEY;
    await expect(loadMasterKeyring()).rejects.toThrow(/MASTER_KEY/);
  });

  it('throws when key does not decode to 32 bytes', async () => {
    delete process.env.MASTER_KEY_FILE;
    process.env.MASTER_KEY = Buffer.alloc(16).toString('base64');
    await expect(loadMasterKeyring()).rejects.toThrow(/32 bytes/);
  });
});
