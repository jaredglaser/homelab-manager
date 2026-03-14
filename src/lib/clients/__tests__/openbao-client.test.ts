import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { OpenBaoClient } from '@/lib/clients/openbao-client';

describe('OpenBaoClient', () => {
  let client: OpenBaoClient;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock();
    client = new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'dev-root-token' },
      mockFetch as unknown as typeof fetch,
    );
  });

  describe('listSecrets', () => {
    test('calls LIST on metadata path and returns keys', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { keys: ['DB_PASSWORD', 'API_KEY'] },
          }),
          { status: 200 },
        ),
      );

      const keys = await client.listSecrets('plex');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/metadata/stacks/plex',
      );
      expect(opts.method).toBe('LIST');
      expect(opts.headers).toEqual({
        'X-Vault-Token': 'dev-root-token',
      });
      expect(keys).toEqual(['DB_PASSWORD', 'API_KEY']);
    });

    test('returns empty array when no secrets exist (404)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const keys = await client.listSecrets('empty-stack');
      expect(keys).toEqual([]);
    });

    test('throws on non-404 error responses', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      await expect(client.listSecrets('plex')).rejects.toThrow(
        'OpenBao API error: 500',
      );
    });
  });

  describe('getSecret', () => {
    test('reads secret value from data path', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: {
              data: { value: 'super-secret-password' },
              metadata: { version: 1 },
            },
          }),
          { status: 200 },
        ),
      );

      const value = await client.getSecret('plex', 'DB_PASSWORD');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/data/stacks/plex/DB_PASSWORD',
      );
      expect(opts.method).toBe('GET');
      expect(value).toBe('super-secret-password');
    });

    test('returns null when secret does not exist (404)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const value = await client.getSecret('plex', 'MISSING');
      expect(value).toBeNull();
    });

    test('throws on non-404 error responses', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 }),
      );

      await expect(
        client.getSecret('plex', 'DB_PASSWORD'),
      ).rejects.toThrow('OpenBao API error: 403');
    });
  });

  describe('setSecret', () => {
    test('writes secret value to data path', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { version: 1 },
          }),
          { status: 200 },
        ),
      );

      await client.setSecret('plex', 'DB_PASSWORD', 'new-password');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/data/stacks/plex/DB_PASSWORD',
      );
      expect(opts.method).toBe('POST');
      expect(opts.headers).toEqual({
        'X-Vault-Token': 'dev-root-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(opts.body as string)).toEqual({
        data: { value: 'new-password' },
      });
    });

    test('throws on error response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Bad Request', { status: 400 }),
      );

      await expect(
        client.setSecret('plex', 'DB_PASSWORD', 'val'),
      ).rejects.toThrow('OpenBao API error: 400');
    });
  });

  describe('deleteSecret', () => {
    test('deletes secret metadata and all versions', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      await client.deleteSecret('plex', 'DB_PASSWORD');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        'http://openbao:8200/v1/secret/metadata/stacks/plex/DB_PASSWORD',
      );
      expect(opts.method).toBe('DELETE');
    });

    test('does not throw on 404 (already deleted)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      await expect(
        client.deleteSecret('plex', 'DB_PASSWORD'),
      ).resolves.toBeUndefined();
    });

    test('throws on non-404 error response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Forbidden', { status: 403 }),
      );

      await expect(
        client.deleteSecret('plex', 'DB_PASSWORD'),
      ).rejects.toThrow('OpenBao API error: 403');
    });
  });

  describe('getAllSecrets', () => {
    test('lists and fetches all secrets for a stack', async () => {
      // First call: list secrets
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { keys: ['DB_PASSWORD', 'API_KEY'] },
          }),
          { status: 200 },
        ),
      );
      // Second call: get DB_PASSWORD
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value: 'pass123' }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );
      // Third call: get API_KEY
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value: 'key456' }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );

      const secrets = await client.getAllSecrets('plex');
      expect(secrets).toEqual({
        DB_PASSWORD: 'pass123',
        API_KEY: 'key456',
      });
    });

    test('returns empty record when no secrets exist', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const secrets = await client.getAllSecrets('empty-stack');
      expect(secrets).toEqual({});
    });

    test('skips secrets that return null on read', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { keys: ['DELETED_KEY'] } }),
          { status: 200 },
        ),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const secrets = await client.getAllSecrets('plex');
      expect(secrets).toEqual({});
    });

    test('handles partial failures gracefully with Promise.allSettled', async () => {
      // List returns two keys
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { keys: ['GOOD_KEY', 'BAD_KEY'] },
          }),
          { status: 200 },
        ),
      );
      // First key succeeds
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value: 'good-value' }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );
      // Second key fails with server error
      mockFetch.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      const secrets = await client.getAllSecrets('plex');
      // Should return the successful secret and skip the failed one
      expect(secrets).toEqual({ GOOD_KEY: 'good-value' });
    });
  });

  describe('ensureSecretsEngine', () => {
    test('does not re-enable if already mounted', async () => {
      // GET /v1/sys/mounts returns existing mounts including secret/
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            'secret/': { type: 'kv', options: { version: '2' } },
          }),
          { status: 200 },
        ),
      );

      await client.ensureSecretsEngine();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test('enables KV v2 engine when not mounted', async () => {
      // GET /v1/sys/mounts — no secret/ mount
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );
      // POST /v1/sys/mounts/secret — enable engine
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 204 }),
      );

      await client.ensureSecretsEngine();
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const [url, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
      expect(url).toBe('http://openbao:8200/v1/sys/mounts/secret');
      expect(opts.method).toBe('POST');
      expect(JSON.parse(opts.body as string)).toEqual({
        type: 'kv',
        options: { version: '2' },
      });
    });
  });

  describe('input sanitization', () => {
    test('rejects stack names with path traversal', async () => {
      await expect(client.listSecrets('../etc')).rejects.toThrow(
        'Invalid stack',
      );
    });

    test('rejects key names with slashes', async () => {
      await expect(client.getSecret('plex', 'foo/bar')).rejects.toThrow(
        'Invalid key',
      );
    });

    test('rejects stack names with dots', async () => {
      await expect(client.setSecret('my.stack', 'KEY', 'val')).rejects.toThrow(
        'Invalid stack',
      );
    });

    test('rejects empty stack name', async () => {
      await expect(client.deleteSecret('', 'KEY')).rejects.toThrow(
        'Invalid stack',
      );
    });

    test('allows valid stack and key names', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value: 'ok' }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );

      const value = await client.getSecret('my-stack_1', 'API_KEY-2');
      expect(value).toBe('ok');
    });
  });
});
