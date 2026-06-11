import { CompactEncrypt, compactDecrypt } from 'jose';
import type { MasterKeyring } from '@/lib/crypto/master-key';

const KEY_ALG = 'dir';
const ENC_ALG = 'A256GCM';

export async function encryptValue(plaintext: string, keyring: MasterKeyring): Promise<string> {
  const key = keyring.keys.get(keyring.activeKid);
  if (!key) throw new Error(`Active kid "${keyring.activeKid}" missing from keyring`);
  return new CompactEncrypt(new TextEncoder().encode(plaintext))
    .setProtectedHeader({ alg: KEY_ALG, enc: ENC_ALG, kid: keyring.activeKid })
    .encrypt(key);
}

export async function decryptValue(jwe: string, keyring: MasterKeyring): Promise<string> {
  // Pin the accepted algorithms so an attacker-supplied header cannot select
  // a weaker or different scheme than the one we encrypt with.
  const { plaintext } = await compactDecrypt(
    jwe,
    async (header) => {
      const kid = header.kid;
      if (typeof kid !== 'string' || kid.length === 0) {
        throw new Error('JWE header missing "kid"');
      }
      const key = keyring.keys.get(kid);
      if (!key) throw new Error(`Unknown JWE kid "${kid}"`);
      return key;
    },
    { keyManagementAlgorithms: [KEY_ALG], contentEncryptionAlgorithms: [ENC_ALG] },
  );
  return new TextDecoder().decode(plaintext);
}
