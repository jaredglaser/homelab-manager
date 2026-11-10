import type { Pool } from 'pg';
import { generateKeyPair, exportJWK, importJWK, type JWK } from 'jose';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { encryptValue, decryptValue } from '@/lib/crypto/encrypted-value';

export interface CreatedAgentKeypair {
  hostName: string;
  publicJwk: JWK;
  privateKey: CryptoKey;
}

export class AgentKeypairsRepository {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: MasterKeyring,
  ) {}

  async createForHost(hostName: string): Promise<CreatedAgentKeypair> {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    const privateJwe = await encryptValue(JSON.stringify(privateJwk), this.keyring);
    await this.pool.query(
      `INSERT INTO agent_keypairs (host_name, private_jwk_jwe, public_jwk)
       VALUES ($1, $2, $3)
       ON CONFLICT (host_name) DO UPDATE
         SET private_jwk_jwe = EXCLUDED.private_jwk_jwe,
             public_jwk = EXCLUDED.public_jwk,
             rotated_at = now()`,
      [hostName, privateJwe, JSON.stringify(publicJwk)],
    );
    return { hostName, publicJwk, privateKey };
  }

  async getPrivateKeyForHost(hostName: string): Promise<CryptoKey | null> {
    const result = await this.pool.query(
      'SELECT private_jwk_jwe FROM agent_keypairs WHERE host_name = $1',
      [hostName],
    );
    if (result.rows.length === 0) return null;
    const jwe = (result.rows[0] as { private_jwk_jwe: string }).private_jwk_jwe;
    let json: string;
    try {
      json = await decryptValue(jwe, this.keyring);
    } catch {
      throw new Error('Agent keypair decryption failed');
    }
    const jwk = JSON.parse(json) as JWK;
    return (await importJWK(jwk, 'EdDSA')) as CryptoKey;
  }

  /** Get-or-create for enrollment: concurrent callers converge on one keypair because the insert never rotates. */
  async getOrCreateForHost(hostName: string): Promise<JWK> {
    const enrolled = await this.getPublicJwkForHost(hostName);
    if (enrolled) return enrolled;
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const publicJwk = await exportJWK(publicKey);
    const privateJwk = await exportJWK(privateKey);
    const privateJwe = await encryptValue(JSON.stringify(privateJwk), this.keyring);
    await this.pool.query(
      `INSERT INTO agent_keypairs (host_name, private_jwk_jwe, public_jwk)
       VALUES ($1, $2, $3)
       ON CONFLICT (host_name) DO NOTHING`,
      [hostName, privateJwe, JSON.stringify(publicJwk)],
    );
    const stored = await this.getPublicJwkForHost(hostName);
    if (!stored) throw new Error(`Agent keypair row missing for ${hostName} after insert`);
    return stored;
  }

  async getPublicJwkForHost(hostName: string): Promise<JWK | null> {
    const result = await this.pool.query(
      'SELECT public_jwk FROM agent_keypairs WHERE host_name = $1',
      [hostName],
    );
    if (result.rows.length === 0) return null;
    return (result.rows[0] as { public_jwk: JWK }).public_jwk;
  }

  async deleteForHost(hostName: string): Promise<void> {
    await this.pool.query('DELETE FROM agent_keypairs WHERE host_name = $1', [hostName]);
  }
}
