import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { Pool } from 'pg';
import { AgentTlsCertificatesRepository } from '../agent-tls-certificates-repository';

interface MockPool {
  query: ReturnType<typeof mock>;
  results: Array<{ rows: unknown[] } | { error: Error }>;
}

function mockPool(): MockPool {
  const results: Array<{ rows: unknown[] } | { error: Error }> = [];
  const query = mock(() => {
    const next = results.shift();
    if (next && 'error' in next) return Promise.reject(next.error);
    return Promise.resolve(next ?? { rows: [] });
  });
  return { query, results } as unknown as MockPool;
}

describe('AgentTlsCertificatesRepository', () => {
  let pool: MockPool;
  let repo: AgentTlsCertificatesRepository;

  beforeEach(() => {
    pool = mockPool();
    repo = new AgentTlsCertificatesRepository(pool as unknown as Pool);
  });

  it('createForHost upserts the cert plaintext with no key material', async () => {
    pool.results.push({ rows: [] });
    await repo.createForHost('myhost', 'CERT-PEM');
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO agent_tls_certificates');
    expect(sql).toContain('ON CONFLICT (host_name) DO UPDATE');
    expect(sql).not.toContain('private_key');
    expect(params).toEqual(['myhost', 'CERT-PEM']);
  });

  it('getCertForHost returns the stored cert', async () => {
    pool.results.push({ rows: [{ cert_pem: 'CERT-PEM' }] });
    expect(await repo.getCertForHost('h')).toBe('CERT-PEM');
    const [sql] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe('SELECT cert_pem FROM agent_tls_certificates WHERE host_name = $1');
  });

  it('getCertForHost returns null when the host has no cert row', async () => {
    pool.results.push({ rows: [] });
    expect(await repo.getCertForHost('absent')).toBeNull();
  });

  it('propagates query failures instead of masking them', async () => {
    pool.results.push({ error: new Error('db down') });
    await expect(repo.getCertForHost('h')).rejects.toThrow('db down');
  });

  it('deleteForHost issues DELETE for the host', async () => {
    pool.results.push({ rows: [] });
    await repo.deleteForHost('h');
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toBe('DELETE FROM agent_tls_certificates WHERE host_name = $1');
    expect(params).toEqual(['h']);
  });
});
