import { describe, expect, test, mock } from 'bun:test';
import { OpenBaoSecretResolver } from '@/lib/services/openbao-secret-resolver';
import { OpenBaoClient } from '@/lib/clients/openbao-client';

describe('OpenBaoSecretResolver', () => {
  function createMockClient(
    secrets: Record<string, string>,
  ): OpenBaoClient {
    const mockFetch = mock();

    // list call
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { keys: Object.keys(secrets) },
        }),
        { status: 200 },
      ),
    );

    // get calls for each key
    for (const value of Object.values(secrets)) {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: { data: { value }, metadata: { version: 1 } },
          }),
          { status: 200 },
        ),
      );
    }

    return new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'test' },
      mockFetch as unknown as typeof fetch,
    );
  }

  test('resolves all secrets for a stack', async () => {
    const client = createMockClient({
      DB_PASSWORD: 'pass123',
      API_KEY: 'key456',
    });
    const resolver = new OpenBaoSecretResolver(client);

    const result = await resolver.resolveSecrets('plex');
    expect(result).toEqual({
      DB_PASSWORD: 'pass123',
      API_KEY: 'key456',
    });
  });

  test('returns empty record when stack has no secrets', async () => {
    const mockFetch = mock();
    mockFetch.mockResolvedValueOnce(
      new Response(null, { status: 404 }),
    );

    const client = new OpenBaoClient(
      { url: 'http://openbao:8200', token: 'test' },
      mockFetch as unknown as typeof fetch,
    );
    const resolver = new OpenBaoSecretResolver(client);

    const result = await resolver.resolveSecrets('empty-stack');
    expect(result).toEqual({});
  });
});
