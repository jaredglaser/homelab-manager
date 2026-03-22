import { describe, expect, test, beforeEach, mock } from 'bun:test';
import { TransitClient } from '@/lib/clients/transit-client';

describe('TransitClient', () => {
  let client: TransitClient;
  let mockFetch: ReturnType<typeof mock>;

  beforeEach(() => {
    mockFetch = mock();
    client = new TransitClient(
      { url: 'http://openbao:8200', token: 'dev-root-token' },
      mockFetch as unknown as typeof fetch,
    );
  });

  describe('encrypt', () => {
    test('calls Transit encrypt endpoint with correct URL, headers, and base64-encoded plaintext', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { ciphertext: 'vault:v1:abc123' } }),
          { status: 200 },
        ),
      );

      await client.encrypt('my-key', 'hello world');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://openbao:8200/v1/transit/encrypt/my-key');
      expect(opts.method).toBe('POST');
      expect(opts.headers).toEqual({
        'X-Vault-Token': 'dev-root-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(opts.body as string)).toEqual({
        plaintext: btoa('hello world'),
      });
    });

    test('returns ciphertext from response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { ciphertext: 'vault:v1:abc123' } }),
          { status: 200 },
        ),
      );

      const result = await client.encrypt('my-key', 'hello world');
      expect(result).toBe('vault:v1:abc123');
    });

    test('throws on non-OK response with error detail', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ errors: ['encryption key not found'] }),
          { status: 400 },
        ),
      );

      await expect(client.encrypt('missing-key', 'data')).rejects.toThrow(
        'Transit encrypt failed for key "missing-key" (HTTP 400): encryption key not found',
      );
    });

    test('throws on non-OK response without JSON body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Internal Server Error', { status: 500 }),
      );

      await expect(client.encrypt('my-key', 'data')).rejects.toThrow(
        'Transit encrypt failed for key "my-key" (HTTP 500)',
      );
    });

    test('throws on unexpected response shape (missing ciphertext)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: {} }), { status: 200 }),
      );

      await expect(client.encrypt('my-key', 'data')).rejects.toThrow(
        'unexpected response shape',
      );
    });

    test('validates key name against safe path pattern', async () => {
      await expect(client.encrypt('bad/key', 'data')).rejects.toThrow(
        'Invalid Transit key name',
      );
      await expect(client.encrypt('../traversal', 'data')).rejects.toThrow(
        'Invalid Transit key name',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('decrypt', () => {
    test('calls Transit decrypt endpoint with correct ciphertext', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { plaintext: btoa('hello world') } }),
          { status: 200 },
        ),
      );

      await client.decrypt('my-key', 'vault:v1:abc123');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://openbao:8200/v1/transit/decrypt/my-key');
      expect(opts.method).toBe('POST');
      expect(opts.headers).toEqual({
        'X-Vault-Token': 'dev-root-token',
        'Content-Type': 'application/json',
      });
      expect(JSON.parse(opts.body as string)).toEqual({
        ciphertext: 'vault:v1:abc123',
      });
    });

    test('returns decoded plaintext from response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ data: { plaintext: btoa('hello world') } }),
          { status: 200 },
        ),
      );

      const result = await client.decrypt('my-key', 'vault:v1:abc123');
      expect(result).toBe('hello world');
    });

    test('throws on non-OK response', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ errors: ['permission denied'] }),
          { status: 403 },
        ),
      );

      await expect(client.decrypt('my-key', 'vault:v1:abc123')).rejects.toThrow(
        'Transit decrypt failed for key "my-key" (HTTP 403): permission denied',
      );
    });

    test('throws on non-OK response without JSON body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('Service Unavailable', { status: 503 }),
      );

      await expect(client.decrypt('my-key', 'vault:v1:abc123')).rejects.toThrow(
        'Transit decrypt failed for key "my-key" (HTTP 503)',
      );
    });

    test('throws on unexpected response shape (missing plaintext)', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ data: {} }), { status: 200 }),
      );

      await expect(client.decrypt('my-key', 'vault:v1:abc123')).rejects.toThrow(
        'unexpected response shape',
      );
    });

    test('validates key name against safe path pattern', async () => {
      await expect(client.decrypt('bad/key', 'vault:v1:abc')).rejects.toThrow(
        'Invalid Transit key name',
      );
      await expect(client.decrypt('key with spaces', 'vault:v1:abc')).rejects.toThrow(
        'Invalid Transit key name',
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
