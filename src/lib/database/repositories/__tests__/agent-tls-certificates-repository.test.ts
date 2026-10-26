import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { Pool } from 'pg';
import { AgentTlsCertificatesRepository } from '../agent-tls-certificates-repository';
import type { MasterKeyring } from '@/lib/crypto/master-key';

async function makeKeyring(): Promise<MasterKeyring> {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.alloc(32, 7),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { activeKid: 'v1', keys: new Map([['v1', key]]) };
}

interface MockPool {
  query: ReturnType<typeof mock>;
  results: Array<{ rows: unknown[] }>;
}

function mockPool(): MockPool {
  const results: Array<{ rows: unknown[] }> = [];
  const query = mock(() => Promise.resolve(results.shift() ?? { rows: [] }));
  return { query, results } as unknown as MockPool;
}

describe('AgentTlsCertificatesRepository', () => {
  let pool: MockPool;
  let keyring: MasterKeyring;
  let repo: AgentTlsCertificatesRepository;

  beforeEach(async () => {
    pool = mockPool();
    keyring = await makeKeyring();
    repo = new AgentTlsCertificatesRepository(pool as unknown as Pool, keyring);
  });

  it('createForHost stores the cert plaintext and the key as JWE', async () => {
    pool.results.push({ rows: [] });
    await repo.createForHost('myhost', 'CERT-PEM', 'KEY-PEM');
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO agent_tls_certificates');
    expect(sql).toContain('ON CONFLICT (host_name) DO UPDATE');
    expect(params[0]).toBe('myhost');
    expect(params[1]).toBe('CERT-PEM');
    expect(params[2]).not.toBe('KEY-PEM');
    expect(String(params[2]).split('.')).toHaveLength(5);
  });

  it('getMaterialForHost decrypts the stored key back to plaintext', async () => {
    pool.results.push({ rows: [] });
    await repo.createForHost('h', 'CERT-PEM', 'KEY-PEM');
    const stored = pool.query.mock.calls[0][1] as unknown[];
    pool.results.push({ rows: [{ cert_pem: 'CERT-PEM', private_key_jwe: stored[2] }] });
    const material = await repo.getMaterialForHost('h');
    expect(material).toEqual({ hostName: 'h', certPem: 'CERT-PEM', keyPem: 'KEY-PEM' });
  });

  it('getMaterialForHost throws a controlled error when decryption fails', async () => {
    pool.results.push({ rows: [{ cert_pem: 'CERT-PEM', private_key_jwe: 'not.a.valid.jwe.token' }] });
    await expect(repo.getMaterialForHost('h')).rejects.toThrow('Agent TLS key decryption failed');
  });

  it('getMaterialForHost returns null when row missing', async () => {
    pool.results.push({ rows: [] });
    expect(await repo.getMaterialForHost('absent')).toBeNull();
  });

  it('getCertForHost returns the stored cert', async () => {
    pool.results.push({ rows: [{ cert_pem: 'CERT-PEM' }] });
    expect(await repo.getCertForHost('h')).toBe('CERT-PEM');
  });

  it('getCertForHost returns null when row missing', async () => {
    pool.results.push({ rows: [] });
    expect(await repo.getCertForHost('absent')).toBeNull();
  });

  it('deleteForHost issues DELETE', async () => {
    pool.results.push({ rows: [] });
    await repo.deleteForHost('h');
    const [sql, params] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM agent_tls_certificates');
    expect(params).toEqual(['h']);
  });
});
