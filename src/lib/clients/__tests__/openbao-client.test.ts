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

    test('throws with context on non-404 error responses', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: ['permission denied'] }), { status: 403 }),
      );

      await expect(client.listSecrets('plex')).rejects.toThrow(
        'OpenBao LIST failed for stack "plex" (HTTP 403): permission denied',
      );
    });

    test('throws on unexpected response shape', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: {} }), { status: 200 }),
      );

      await expect(client.listSecrets('plex')).rejects.toThrow(
        'unexpected response shape',
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

    test('throws with context on non-404 error responses', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: ['permission denied'] }), { status: 403 }),
      );

      await expect(
        client.getSecret('plex', 'DB_PASSWORD'),
      ).rejects.toThrow(
        'OpenBao GET failed for stack "plex" key "DB_PASSWORD" (HTTP 403): permission denied',
      );
    });

    test('throws on unexpected response shape', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: { data: { wrong: 123 } } }), { status: 200 }),
      );

      await expect(client.getSecret('plex', 'KEY')).rejects.toThrow(
        'unexpected response shape',
      );
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

    test('throws with context on error response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: ['invalid request'] }), { status: 400 }),
      );

      await expect(
        client.setSecret('plex', 'DB_PASSWORD', 'val'),
      ).rejects.toThrow(
        'OpenBao SET failed for stack "plex" key "DB_PASSWORD" (HTTP 400): invalid request',
      );
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

    test('throws with context on non-404 error response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: ['permission denied'] }), { status: 403 }),
      );

      await expect(
        client.deleteSecret('plex', 'DB_PASSWORD'),
      ).rejects.toThrow(
        'OpenBao DELETE failed for stack "plex" key "DB_PASSWORD" (HTTP 403): permission denied',
      );
    });
  });

  describe('getAllSecrets', () => {
    test('lists and fetches all secrets for a stack in sorted order', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { keys: ['DB_PASSWORD', 'API_KEY'] },
          }),
          { status: 200 },
        ),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value: 'pass123' }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );
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
        API_KEY: 'key456',
        DB_PASSWORD: 'pass123',
      });
      // Verify sorted order (API_KEY before DB_PASSWORD)
      expect(Object.keys(secrets)).toEqual(['API_KEY', 'DB_PASSWORD']);
    });

    test('returns empty record when no secrets exist', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 404 }),
      );

      const secrets = await client.getAllSecrets('empty-stack');
      expect(secrets).toEqual({});
    });

    test('skips secrets that return null on read (404 race)', async () => {
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

    test('throws when any secret fetch fails with non-404 error', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { keys: ['GOOD_KEY', 'BAD_KEY'] },
          }),
          { status: 200 },
        ),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value: 'good-value' }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: ['permission denied'] }), { status: 403 }),
      );

      await expect(client.getAllSecrets('plex')).rejects.toThrow(
        'Failed to fetch 1/2 secrets for stack "plex"',
      );
    });
  });

  describe('ensureSecretsEngine', () => {
    test('does not re-enable if already mounted', async () => {
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
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );
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

    test('throws when mount check fails', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: ['permission denied'] }), { status: 403 }),
      );

      await expect(client.ensureSecretsEngine()).rejects.toThrow(
        'OpenBao GET_MOUNTS failed for sys/mounts (HTTP 403): permission denied',
      );
    });

    test('throws when engine enable fails', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({}), { status: 200 }),
      );
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ errors: ['path already in use'] }), { status: 400 }),
      );

      await expect(client.ensureSecretsEngine()).rejects.toThrow(
        'OpenBao ENABLE_ENGINE failed for secret/ (HTTP 400): path already in use',
      );
    });
  });

  describe('network errors', () => {
    test('wraps fetch rejection with OpenBao context', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(client.listSecrets('plex')).rejects.toThrow(
        'OpenBao LIST failed for stack "plex": could not connect to http://openbao:8200',
      );
    });

    test('preserves original error as cause', async () => {
      const originalError = new TypeError('fetch failed');
      mockFetch.mockRejectedValueOnce(originalError);

      try {
        await client.listSecrets('plex');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).cause).toBe(originalError);
      }
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

    test('does not echo untrusted input in error message', async () => {
      try {
        await client.listSecrets('<script>alert(1)</script>');
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as Error).message).not.toContain('<script>');
        expect((error as Error).message).toContain('must contain only letters');
      }
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

  describe('error response body parsing', () => {
    test('includes error details from JSON response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ errors: ['token expired', 'please reauthenticate'] }),
          { status: 403 },
        ),
      );

      await expect(client.listSecrets('plex')).rejects.toThrow(
        'token expired, please reauthenticate',
      );
    });

    test('handles non-JSON error responses gracefully', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      await expect(client.listSecrets('plex')).rejects.toThrow(
        'OpenBao LIST failed for stack "plex" (HTTP 500)',
      );
    });
  });
});
