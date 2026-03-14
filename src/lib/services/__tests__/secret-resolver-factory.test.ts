import { describe, expect, test, afterEach } from 'bun:test';
import { createSecretResolver } from '@/lib/services/secret-resolver-factory';
import { NoOpSecretResolver } from '@/lib/services/secret-resolver';
import { OpenBaoSecretResolver } from '@/lib/services/openbao-secret-resolver';

describe('createSecretResolver', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('returns NoOpSecretResolver when OpenBao is not configured', () => {
    delete process.env.OPENBAO_URL;
    delete process.env.OPENBAO_TOKEN;

    const resolver = createSecretResolver();
    expect(resolver).toBeInstanceOf(NoOpSecretResolver);
  });

  test('returns OpenBaoSecretResolver when OpenBao is configured', () => {
    process.env.OPENBAO_URL = 'http://openbao:8200';
    process.env.OPENBAO_TOKEN = 'dev-root-token';

    const resolver = createSecretResolver();
    expect(resolver).toBeInstanceOf(OpenBaoSecretResolver);
  });
});
