import { describe, it, expect } from 'bun:test';
import { encryptValue, decryptValue } from './encrypted-value';
import type { MasterKeyring } from './master-key';

async function makeKeyring(byte: number = 9): Promise<MasterKeyring> {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.alloc(32, byte),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { activeKid: 'v1', keys: new Map([['v1', key]]) };
}

describe('encryptValue / decryptValue', () => {
  it('round-trips a plaintext', async () => {
    const keyring = await makeKeyring();
    const jwe = await encryptValue('hello world', keyring);
    expect(await decryptValue(jwe, keyring)).toBe('hello world');
  });

  it('produces five-segment compact JWE', async () => {
    const keyring = await makeKeyring();
    const jwe = await encryptValue('x', keyring);
    expect(jwe.split('.')).toHaveLength(5);
  });

  it('embeds active kid + alg + enc in protected header', async () => {
    const keyring = await makeKeyring();
    const jwe = await encryptValue('x', keyring);
    const headerB64 = jwe.split('.')[0];
    const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString()) as Record<string, string>;
    expect(header.kid).toBe('v1');
    expect(header.alg).toBe('dir');
    expect(header.enc).toBe('A256GCM');
  });

  it('decryption fails when kid is not in keyring', async () => {
    const keyring = await makeKeyring();
    const jwe = await encryptValue('x', keyring);
    const empty: MasterKeyring = { activeKid: 'v1', keys: new Map() };
    await expect(decryptValue(jwe, empty)).rejects.toThrow();
  });

  it('decryption fails when ciphertext is corrupted', async () => {
    const keyring = await makeKeyring();
    const jwe = await encryptValue('x', keyring);
    const segments = jwe.split('.');
    segments[3] = 'AAAA' + segments[3].slice(4);
    await expect(decryptValue(segments.join('.'), keyring)).rejects.toThrow();
  });

  it('decryption fails when JWE header has empty kid', async () => {
    const keyring = await makeKeyring();
    const header = Buffer.from(JSON.stringify({ alg: 'dir', enc: 'A256GCM', kid: '' })).toString('base64url');
    const jweEmptyKid = `${header}..AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA`;
    await expect(decryptValue(jweEmptyKid, keyring)).rejects.toThrow('JWE header missing "kid"');
  });
});
