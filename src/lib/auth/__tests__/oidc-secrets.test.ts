import { afterEach, describe, expect, it } from 'bun:test';
import { getOidcClientSecret } from '@/lib/auth/oidc-secrets';

describe('getOidcClientSecret', () => {
  const saved = process.env.OIDC_CLIENT_SECRET;

  afterEach(() => {
    if (saved === undefined) {
      delete process.env.OIDC_CLIENT_SECRET;
    } else {
      process.env.OIDC_CLIENT_SECRET = saved;
    }
  });

  it('returns the trimmed secret', async () => {
    process.env.OIDC_CLIENT_SECRET = ' secret-value ';
    await expect(getOidcClientSecret()).resolves.toBe('secret-value');
  });

  it('throws when the variable is missing', async () => {
    delete process.env.OIDC_CLIENT_SECRET;
    await expect(getOidcClientSecret()).rejects.toThrow(
      'OIDC_CLIENT_SECRET environment variable must be set when auth is enabled',
    );
  });

  it('throws when the variable is blank', async () => {
    process.env.OIDC_CLIENT_SECRET = '   ';
    await expect(getOidcClientSecret()).rejects.toThrow();
  });
});
