import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { Pool } from 'pg';
import { AgentKeypairsRepository } from '../agent-keypairs-repository';
import type { MasterKeyring } from '@/lib/crypto/master-key';

async function makeKeyring(): Promise<MasterKeyring> {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.alloc(32, 5),
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

describe('AgentKeypairsRepository', () => {
  let pool: MockPool;
  let keyring: MasterKeyring;
  let repo: AgentKeypairsRepository;

  beforeEach(async () => {
    pool = mockPool();
    keyring = await makeKeyring();
    repo = new AgentKeypairsRepository(pool as unknown as Pool, keyring);
  });

  it('createForHost generates Ed25519 keypair and stores encrypted private + plain public', async () => {
    pool.results.push({ rows: [] });
    const result = await repo.createForHost('myhost');
    expect(result.hostName).toBe('myhost');
    expect(result.publicJwk.kty).toBe('OKP');
    expect(result.publicJwk.crv).toBe('Ed25519');
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('myhost');
    expect((params[1] as string).split('.')).toHaveLength(5);
    expect(JSON.parse(params[2] as string).kty).toBe('OKP');
  });

  it('getPrivateKeyForHost decrypts and imports', async () => {
    pool.results.push({ rows: [] });
    await repo.createForHost('h');
    const stored = pool.query.mock.calls[0][1] as unknown[];
    pool.results.push({ rows: [{ private_jwk_jwe: stored[1] }] });
    const key = await repo.getPrivateKeyForHost('h');
    expect(key).not.toBeNull();
  });

  it('getPrivateKeyForHost throws controlled error when decryption fails', async () => {
    pool.results.push({ rows: [{ private_jwk_jwe: 'not.a.valid.jwe.token' }] });
    await expect(repo.getPrivateKeyForHost('h')).rejects.toThrow('Agent keypair decryption failed');
  });

  it('getPrivateKeyForHost returns null when row missing', async () => {
    pool.results.push({ rows: [] });
    expect(await repo.getPrivateKeyForHost('absent')).toBeNull();
  });

  it('getPublicJwkForHost returns parsed JWK', async () => {
    pool.results.push({ rows: [{ public_jwk: { kty: 'OKP', crv: 'Ed25519', x: 'abc' } }] });
    const jwk = await repo.getPublicJwkForHost('h');
    expect(jwk?.kty).toBe('OKP');
  });

  it('getPublicJwkForHost returns null when row missing', async () => {
    pool.results.push({ rows: [] });
    expect(await repo.getPublicJwkForHost('absent')).toBeNull();
  });

  it('getOrCreateForHost inserts when the host has no keypair', async () => {
    pool.results.push({ rows: [] });
    pool.results.push({ rows: [] });
    pool.results.push({ rows: [{ public_jwk: { kty: 'OKP', crv: 'Ed25519', x: 'stored' } }] });
    const jwk = await repo.getOrCreateForHost('h');
    expect(jwk).toEqual({ kty: 'OKP', crv: 'Ed25519', x: 'stored' });
    const [selectSql, insertSql] = pool.query.mock.calls.map((c) => c[0] as string);
    expect(selectSql).toContain('SELECT public_jwk');
    expect(insertSql).toContain('INSERT INTO agent_keypairs');
    expect(insertSql).toContain('ON CONFLICT (host_name) DO NOTHING');
    expect(insertSql).not.toContain('DO UPDATE');
    expect((pool.query.mock.calls[1][1] as unknown[])[0]).toBe('h');
  });

  it('getOrCreateForHost returns the stored JWK without rotating when one exists', async () => {
    const stored = { kty: 'OKP', crv: 'Ed25519', x: 'enrolled' };
    pool.results.push({ rows: [{ public_jwk: stored }] });
    const jwk = await repo.getOrCreateForHost('h');
    expect(jwk).toBe(stored);
    expect(pool.query.mock.calls).toHaveLength(1);
    expect(pool.query.mock.calls[0][0]).toContain('SELECT public_jwk');
  });

  it('deleteForHost issues DELETE', async () => {
    pool.results.push({ rows: [] });
    await repo.deleteForHost('h');
    expect(pool.query.mock.calls[0][0]).toContain('DELETE FROM agent_keypairs');
    expect(pool.query.mock.calls[0][1]).toEqual(['h']);
  });
});
