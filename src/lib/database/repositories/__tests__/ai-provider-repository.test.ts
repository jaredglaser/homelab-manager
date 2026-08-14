import { describe, it, expect, beforeEach, mock, spyOn } from 'bun:test';
import type { Pool } from 'pg';
import { AI_PROVIDER_ID, AiProviderRepository } from '../ai-provider-repository';
import type { MasterKeyring } from '@/lib/crypto/master-key';

async function makeKeyring(): Promise<MasterKeyring> {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.alloc(32, 3),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { activeKid: 'v1', keys: new Map([['v1', key]]) };
}

interface MockPool {
  query: ReturnType<typeof mock>;
  results: { rows: unknown[] }[];
}

function mockPool(): MockPool {
  const results: { rows: unknown[] }[] = [];
  const query = mock(() => Promise.resolve(results.shift() ?? { rows: [] }));
  return { query, results } as unknown as MockPool;
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    base_url: 'http://gpu-box:8080/v1',
    model: 'analyst-8b',
    profiler_model: null,
    api_key_jwe: null,
    max_context_tokens: '32768',
    ...overrides,
  };
}

describe('AiProviderRepository', () => {
  let pool: MockPool;
  let keyring: MasterKeyring;
  let repo: AiProviderRepository;

  beforeEach(async () => {
    pool = mockPool();
    keyring = await makeKeyring();
    repo = new AiProviderRepository(pool as unknown as Pool, keyring);
  });

  it('getConfig returns null when nothing is stored', async () => {
    expect(await repo.getConfig()).toBeNull();
  });

  it('getConfig never exposes the ciphertext and coerces the BIGINT-style count', async () => {
    pool.results.push({ rows: [row({ api_key_jwe: 'jwe', profiler_model: 'profiler-70b' })] });
    const config = await repo.getConfig();
    expect(config).toEqual({
      baseUrl: 'http://gpu-box:8080/v1',
      model: 'analyst-8b',
      profilerModel: 'profiler-70b',
      hasApiKey: true,
      maxContextTokens: 32768,
    });
    expect(JSON.stringify(config)).not.toContain('jwe');
  });

  it('getWithKey decrypts the stored key', async () => {
    const { encryptValue } = await import('@/lib/crypto/encrypted-value');
    pool.results.push({ rows: [row({ api_key_jwe: await encryptValue('sk-secret', keyring) })] });
    const loaded = await repo.getWithKey();
    expect(loaded?.apiKey).toBe('sk-secret');
    expect(loaded?.hasApiKey).toBe(true);
  });

  it('getWithKey returns null for a missing row', async () => {
    expect(await repo.getWithKey()).toBeNull();
  });

  it('getWithKey degrades to no key rather than failing when decryption breaks', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    pool.results.push({ rows: [row({ api_key_jwe: 'not-a-jwe' })] });
    const loaded = await repo.getWithKey();
    expect(loaded?.apiKey).toBeNull();
    expect(loaded?.hasApiKey).toBe(true);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('save encrypts a new key and does not ask the DB to keep the old one', async () => {
    await repo.save({
      baseUrl: 'http://gpu-box:8080',
      model: 'analyst-8b',
      profilerModel: null,
      maxContextTokens: 32768,
      apiKey: 'sk-new',
    });
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[0]).toBe(AI_PROVIDER_ID);
    expect(typeof params[5]).toBe('string');
    expect(params[5]).not.toBe('sk-new');
    expect(params[6]).toBe(false);
  });

  it('save keeps the stored key when apiKey is omitted', async () => {
    await repo.save({
      baseUrl: 'http://gpu-box:8080',
      model: 'analyst-8b',
      profilerModel: null,
      maxContextTokens: 32768,
    });
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[5]).toBeNull();
    expect(params[6]).toBe(true);
  });

  it('save clears the stored key when apiKey is explicitly null', async () => {
    await repo.save({
      baseUrl: 'http://gpu-box:8080',
      model: 'analyst-8b',
      profilerModel: null,
      maxContextTokens: 32768,
      apiKey: null,
    });
    const params = pool.query.mock.calls[0][1] as unknown[];
    expect(params[5]).toBeNull();
    expect(params[6]).toBe(false);
  });

  it('clear deletes the single row', async () => {
    await repo.clear();
    expect(pool.query.mock.calls[0][0]).toContain('DELETE FROM ai_providers');
  });
});
