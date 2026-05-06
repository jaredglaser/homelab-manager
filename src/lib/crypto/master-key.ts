import { readFileSync } from 'node:fs';

export type Kid = string;

export interface MasterKeyring {
  activeKid: Kid;
  keys: Map<Kid, CryptoKey>;
}

const ACTIVE_KID: Kid = 'v1';

export async function loadMasterKeyring(): Promise<MasterKeyring> {
  const raw = readMasterKeyBase64();
  const bytes = Uint8Array.from(Buffer.from(raw, 'base64'));
  if (bytes.byteLength !== 32) {
    throw new Error(
      `Master key must decode to 32 bytes; got ${bytes.byteLength}. ` +
        `Generate with: openssl rand -base64 32`,
    );
  }
  const key = await crypto.subtle.importKey(
    'raw',
    bytes,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  return { activeKid: ACTIVE_KID, keys: new Map<Kid, CryptoKey>([[ACTIVE_KID, key]]) };
}

function readMasterKeyBase64(): string {
  const filePath = process.env.MASTER_KEY_FILE;
  if (filePath && filePath.length > 0) {
    return readFileSync(filePath, 'utf-8').trim();
  }
  const fromEnv = process.env.MASTER_KEY;
  if (fromEnv && fromEnv.trim().length > 0) {
    return fromEnv.trim();
  }
  throw new Error(
    'MASTER_KEY_FILE or MASTER_KEY environment variable must be set. ' +
      'Generate a key with: openssl rand -base64 32',
  );
}
