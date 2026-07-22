import { describe, it, expect, mock } from 'bun:test';
import { NoOpSecretResolver, StackSecretsResolver, extractVariableReferences } from '../secret-resolver';
import type { StackSecretsLookup } from '../secret-resolver';

describe('StackSecretsResolver', () => {
  it('returns an empty record when no variables are requested', async () => {
    const stackSecrets: StackSecretsLookup = { get: mock() };
    const resolver = new StackSecretsResolver(stackSecrets);
    const result = await resolver.resolve('plex', []);
    expect(result).toEqual({});
    expect(stackSecrets.get).not.toHaveBeenCalled();
  });

  it('resolves all variables when every lookup settles (all-resolved)', async () => {
    const stackSecrets: StackSecretsLookup = {
      get: mock((_stack: string, key: string) =>
        Promise.resolve(key === 'API_TOKEN' ? 'token-value' : 'tz-value'),
      ),
    };
    const resolver = new StackSecretsResolver(stackSecrets);
    const result = await resolver.resolve('plex', ['API_TOKEN', 'TIMEZONE']);
    expect(result).toEqual({ API_TOKEN: 'token-value', TIMEZONE: 'tz-value' });
  });

  it('omits variables the lookup resolves to null', async () => {
    const stackSecrets: StackSecretsLookup = {
      get: mock((_stack: string, key: string) =>
        Promise.resolve(key === 'API_TOKEN' ? 'token-value' : null),
      ),
    };
    const resolver = new StackSecretsResolver(stackSecrets);
    const result = await resolver.resolve('plex', ['API_TOKEN', 'UNSET_VAR']);
    expect(result).toEqual({ API_TOKEN: 'token-value' });
  });

  it('throws a decryption-summary error when some lookups reject with "Secret decryption failed" (some-rejected-with-decryption-failure)', async () => {
    const stackSecrets: StackSecretsLookup = {
      get: mock((_stack: string, key: string) => {
        if (key === 'BAD_KEY') return Promise.reject(new Error('Secret decryption failed'));
        return Promise.resolve('ok-value');
      }),
    };
    const resolver = new StackSecretsResolver(stackSecrets);
    await expect(resolver.resolve('plex', ['BAD_KEY', 'GOOD_KEY'])).rejects.toThrow(
      'Failed to decrypt 1 secret(s) for stack "plex". Check that MASTER_KEY is correct.',
    );
  });

  it('throws the original error when some lookups reject with a non-decryption error (some-rejected-other)', async () => {
    const dbError = new Error('connection terminated unexpectedly');
    const stackSecrets: StackSecretsLookup = {
      get: mock((_stack: string, key: string) => {
        if (key === 'DB_DOWN') return Promise.reject(dbError);
        return Promise.resolve('ok-value');
      }),
    };
    const resolver = new StackSecretsResolver(stackSecrets);
    await expect(resolver.resolve('plex', ['DB_DOWN', 'GOOD_KEY'])).rejects.toBe(dbError);
  });

  it('prefers surfacing a non-decryption error over a decryption error when both kinds are rejected', async () => {
    const dbError = new Error('connection terminated unexpectedly');
    const stackSecrets: StackSecretsLookup = {
      get: mock((_stack: string, key: string) => {
        if (key === 'DB_DOWN') return Promise.reject(dbError);
        if (key === 'BAD_KEY') return Promise.reject(new Error('Secret decryption failed'));
        return Promise.resolve('ok-value');
      }),
    };
    const resolver = new StackSecretsResolver(stackSecrets);
    await expect(resolver.resolve('plex', ['DB_DOWN', 'BAD_KEY', 'GOOD_KEY'])).rejects.toBe(dbError);
  });

  it('wraps a non-Error rejection reason in an Error', async () => {
    const stackSecrets: StackSecretsLookup = {
      get: mock(() => Promise.reject('plain string rejection')),
    };
    const resolver = new StackSecretsResolver(stackSecrets);
    await expect(resolver.resolve('plex', ['SOME_KEY'])).rejects.toThrow('plain string rejection');
  });
});

describe('NoOpSecretResolver', () => {
  it('throws when variables are requested without a configured backend', async () => {
    const resolver = new NoOpSecretResolver();
    await expect(resolver.resolve('plex', ['MY_SECRET', 'OTHER_VAR'])).rejects.toThrow(
      'no secret backend is configured'
    );
  });

  it('returns an empty record when no variables are requested', async () => {
    const resolver = new NoOpSecretResolver();
    const result = await resolver.resolve('plex', []);
    expect(result).toEqual({});
  });
});

describe('extractVariableReferences', () => {
  it('extracts ${VAR} references from compose content', () => {
    const compose = [
      'services:',
      '  plex:',
      '    environment:',
      '      - PLEX_TOKEN=${PLEX_TOKEN}',
      '      - TZ=${TIMEZONE}',
      '      - PLAIN_VALUE=hello',
      '    image: plexinc/pms-docker:${PLEX_VERSION}',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual(['PLEX_TOKEN', 'TIMEZONE', 'PLEX_VERSION']);
  });

  it('returns empty array when no variables found', () => {
    const compose = [
      'services:',
      '  nginx:',
      '    image: nginx:latest',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual([]);
  });

  it('deduplicates variable references', () => {
    const compose = [
      'services:',
      '  app:',
      '    environment:',
      '      - KEY=${SHARED}',
      '    labels:',
      '      - label=${SHARED}',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual(['SHARED']);
  });

  it('handles ${VAR:-default} syntax by extracting just the variable name', () => {
    const compose = [
      'services:',
      '  app:',
      '    environment:',
      '      - PORT=${APP_PORT:-8080}',
    ].join('\n');
    const vars = extractVariableReferences(compose);
    expect(vars).toEqual(['APP_PORT']);
  });
});
