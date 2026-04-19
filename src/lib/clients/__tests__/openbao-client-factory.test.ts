import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test';
import { resetOpenBaoInitState } from '@/lib/services/openbao-init';
import {
  getOpenBaoClient,
  resetOpenBaoClientCache,
} from '@/lib/clients/openbao-client-factory';

describe('openbao-client-factory', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    resetOpenBaoInitState();
    resetOpenBaoClientCache();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    resetOpenBaoInitState();
    resetOpenBaoClientCache();
  });

  test('throws listing both missing vars when neither is set', async () => {
    delete process.env.OPENBAO_URL;
    delete process.env.OPENBAO_TOKEN;

    await expect(getOpenBaoClient()).rejects.toThrow(
      'OpenBao is not configured (missing: OPENBAO_URL, OPENBAO_TOKEN)',
    );
  });

  test('throws identifying missing OPENBAO_TOKEN when only URL is set', async () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    delete process.env.OPENBAO_TOKEN;

    await expect(getOpenBaoClient()).rejects.toThrow(
      'OpenBao is not configured (missing: OPENBAO_TOKEN)',
    );
  });

  test('throws identifying missing OPENBAO_URL when only token is set', async () => {
    delete process.env.OPENBAO_URL;
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    await expect(getOpenBaoClient()).rejects.toThrow(
      'OpenBao is not configured (missing: OPENBAO_URL)',
    );
  });

  test('returns the same cached client across repeated calls', async () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            'secret/': { type: 'kv', options: { version: '2' } },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const first = await getOpenBaoClient();
    const second = await getOpenBaoClient();

    expect(first).toBe(second);
  });

  test('rebuilds the client after resetOpenBaoClientCache()', async () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            'secret/': { type: 'kv', options: { version: '2' } },
          }),
          { status: 200 },
        ),
      ),
    ) as unknown as typeof fetch;

    const first = await getOpenBaoClient();
    resetOpenBaoClientCache();
    resetOpenBaoInitState();
    const second = await getOpenBaoClient();

    expect(first).not.toBe(second);
  });
});
