import type { Pool } from 'pg';
import type { MasterKeyring } from '@/lib/crypto/master-key';
import { encryptValue, decryptValue } from '@/lib/crypto/encrypted-value';

export interface HostTlsMaterial {
  hostName: string;
  certPem: string;
  keyPem: string;
}

export class AgentTlsCertificatesRepository {
  constructor(
    private readonly pool: Pool,
    private readonly keyring: MasterKeyring,
  ) {}

  /** Re-provision replaces the previous cert and key wholesale; versions never coexist. */
  async createForHost(hostName: string, certPem: string, keyPem: string): Promise<void> {
    const privateJwe = await encryptValue(keyPem, this.keyring);
    await this.pool.query(
      `INSERT INTO agent_tls_certificates (host_name, cert_pem, private_key_jwe)
       VALUES ($1, $2, $3)
       ON CONFLICT (host_name) DO UPDATE
         SET cert_pem = EXCLUDED.cert_pem,
             private_key_jwe = EXCLUDED.private_key_jwe,
             created_at = now()`,
      [hostName, certPem, privateJwe],
    );
  }

  async getCertForHost(hostName: string): Promise<string | null> {
    const result = await this.pool.query(
      'SELECT cert_pem FROM agent_tls_certificates WHERE host_name = $1',
      [hostName],
    );
    if (result.rows.length === 0) return null;
    return (result.rows[0] as { cert_pem: string }).cert_pem;
  }

  async getMaterialForHost(hostName: string): Promise<HostTlsMaterial | null> {
    const result = await this.pool.query(
      'SELECT cert_pem, private_key_jwe FROM agent_tls_certificates WHERE host_name = $1',
      [hostName],
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as { cert_pem: string; private_key_jwe: string };
    let keyPem: string;
    try {
      keyPem = await decryptValue(row.private_key_jwe, this.keyring);
    } catch {
      throw new Error('Agent TLS key decryption failed');
    }
    return { hostName, certPem: row.cert_pem, keyPem };
  }

  async deleteForHost(hostName: string): Promise<void> {
    await this.pool.query('DELETE FROM agent_tls_certificates WHERE host_name = $1', [hostName]);
  }
}
