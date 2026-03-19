import { describe, expect, test, afterEach, mock, beforeEach } from 'bun:test';
import { createSecretResolver } from '@/lib/services/secret-resolver-factory';
import { NoOpSecretResolver } from '@/lib/services/secret-resolver';
import { OpenBaoSecretResolver } from '@/lib/services/openbao-secret-resolver';

describe('NoOpSecretResolver', () => {
  test('resolveSecrets returns empty record', async () => {
    const resolver = new NoOpSecretResolver();
    const result = await resolver.resolveSecrets('any-stack');
    expect(result).toEqual({});
  });
});

describe('createSecretResolver', () => {
  const originalEnv = { ...process.env };
  const originalConsoleInfo = console.info;

  beforeEach(() => {
    console.info = mock();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    console.info = originalConsoleInfo;
  });

  test('returns NoOpSecretResolver when OpenBao is not configured', () => {
    delete process.env.OPENBAO_URL;
    delete process.env.OPENBAO_TOKEN;

    const resolver = createSecretResolver();
    expect(resolver).toBeInstanceOf(NoOpSecretResolver);
  });

  test('returns NoOpSecretResolver when only OPENBAO_URL is set', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    delete process.env.OPENBAO_TOKEN;

    const resolver = createSecretResolver();
    expect(resolver).toBeInstanceOf(NoOpSecretResolver);
  });

  test('logs info message when NoOp resolver is chosen', () => {
    delete process.env.OPENBAO_URL;
    delete process.env.OPENBAO_TOKEN;

    createSecretResolver();
    expect(console.info).toHaveBeenCalledWith(
      'OpenBao not configured — using NoOpSecretResolver (no secrets will be injected)',
    );
  });

  test('returns OpenBaoSecretResolver when OpenBao is configured', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    const resolver = createSecretResolver();
    expect(resolver).toBeInstanceOf(OpenBaoSecretResolver);
  });
});
