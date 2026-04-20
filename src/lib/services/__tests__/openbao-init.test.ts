import { describe, expect, test, mock, beforeEach } from 'bun:test';
import { OpenBaoClient } from '@/lib/clients/openbao-client';
import { initializeOpenBao, resetOpenBaoInitState } from '@/lib/services/openbao-init';

describe('OpenBao initialization', () => {
  beforeEach(() => {
    resetOpenBaoInitState();
  });

  test('ensureSecretsEngine is idempotent', async () => {
    const mockFetch = mock();

    // First call: check mounts (engine already exists)
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          'secret/': { type: 'kv', options: { version: '2' } },
        }),
        { status: 200 },
      ),
    );

    const client = new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'dev-root-token' },
      mockFetch as unknown as typeof fetch,
    );

    await client.ensureSecretsEngine();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('ensureSecretsEngine enables engine when missing', async () => {
    const mockFetch = mock();

    // First call: check mounts (no secret/ engine)
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ 'sys/': { type: 'system' } }), {
        status: 200,
      }),
    );
    // Second call: enable engine
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 204 }),
    );

    const client = new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'dev-root-token' },
      mockFetch as unknown as typeof fetch,
    );

    await client.ensureSecretsEngine();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('initializeOpenBao calls ensureSecretsEngine once (singleton)', async () => {
    const mockFetch = mock();

    // Only one mount check needed (engine exists)
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          'secret/': { type: 'kv', options: { version: '2' } },
        }),
        { status: 200 },
      ),
    );

    const client = new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'dev-root-token' },
      mockFetch as unknown as typeof fetch,
    );

    // Call multiple times concurrently
    await Promise.all([
      initializeOpenBao(client),
      initializeOpenBao(client),
      initializeOpenBao(client),
    ]);

    // ensureSecretsEngine should only be called once
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('initializeOpenBao resets on failure and retries', async () => {
    const mockFetch = mock();

    // First attempt: fails
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 500 }),
    );

    const client = new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'dev-root-token' },
      mockFetch as unknown as typeof fetch,
    );

    // First call should fail
    await expect(initializeOpenBao(client)).rejects.toThrow('OpenBao GET_MOUNTS failed for sys/mounts (HTTP 500)');

    // Second attempt: succeeds (engine exists)
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          'secret/': { type: 'kv', options: { version: '2' } },
        }),
        { status: 200 },
      ),
    );

    // Should retry since the promise was reset
    await initializeOpenBao(client);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});
