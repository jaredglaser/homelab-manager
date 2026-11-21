import type { Pool } from 'pg';

interface CertPemRow {
  cert_pem: string;
}

/** Public certs only: the agent keeps its private key. */
export class AgentTlsCertificatesRepository {
  constructor(private readonly pool: Pool) {}

  /** Rotation replaces the previous cert wholesale. Versions never coexist. */
  async createForHost(hostName: string, certPem: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_tls_certificates (host_name, cert_pem)
       VALUES ($1, $2)
       ON CONFLICT (host_name) DO UPDATE
         SET cert_pem = EXCLUDED.cert_pem,
             created_at = now()`,
      [hostName, certPem],
    );
  }

  async getCertForHost(hostName: string): Promise<string | null> {
    const result = await this.pool.query<CertPemRow>(
      'SELECT cert_pem FROM agent_tls_certificates WHERE host_name = $1',
      [hostName],
    );
    if (result.rows.length === 0) return null;
    return result.rows[0].cert_pem;
  }

  async deleteForHost(hostName: string): Promise<void> {
    await this.pool.query('DELETE FROM agent_tls_certificates WHERE host_name = $1', [hostName]);
  }
}
