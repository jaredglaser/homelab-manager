import { describe, it, expect, beforeEach, mock } from 'bun:test';
import type { Pool } from 'pg';
import { StackSecretsRepository } from '../stack-secrets-repository';
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

describe('StackSecretsRepository', () => {
  let pool: MockPool;
  let keyring: MasterKeyring;
  let repo: StackSecretsRepository;

  beforeEach(async () => {
    pool = mockPool();
    keyring = await makeKeyring();
    repo = new StackSecretsRepository(pool as unknown as Pool, keyring);
  });

  it('list returns variable names sorted', async () => {
    pool.results.push({ rows: [{ variable_name: 'A' }, { variable_name: 'B' }] });
    expect(await repo.list('mystack')).toEqual(['A', 'B']);
    const call = pool.query.mock.calls[0];
    expect(call[0]).toContain('FROM stack_secrets');
    expect(call[1]).toEqual(['mystack']);
  });

  it('get returns null when row missing', async () => {
    pool.results.push({ rows: [] });
    expect(await repo.get('s', 'V')).toBeNull();
  });

  it('get decrypts ciphertext when row present', async () => {
    const { encryptValue } = await import('@/lib/crypto/encrypted-value');
    const jwe = await encryptValue('secret-value', keyring);
    pool.results.push({ rows: [{ ciphertext_jwe: jwe }] });
    expect(await repo.get('s', 'V')).toBe('secret-value');
  });

  it('set encrypts and upserts', async () => {
    pool.results.push({ rows: [] });
    await repo.set('s', 'V', 'plaintext');
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain('INSERT INTO stack_secrets');
    expect(sql).toContain('ON CONFLICT (stack_name, variable_name)');
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe('s');
    expect(params[1]).toBe('V');
    expect(typeof params[2]).toBe('string');
    expect((params[2] as string).split('.')).toHaveLength(5);
  });

  it('delete removes row', async () => {
    pool.results.push({ rows: [] });
    await repo.delete('s', 'V');
    expect(pool.query.mock.calls[0][0]).toContain('DELETE FROM stack_secrets');
    expect(pool.query.mock.calls[0][1]).toEqual(['s', 'V']);
  });

  it('ensureExists is no-op on conflict', async () => {
    pool.results.push({ rows: [] });
    await repo.ensureExists('s', 'V');
    expect(pool.query.mock.calls[0][0]).toContain('ON CONFLICT (stack_name, variable_name) DO NOTHING');
  });
});
