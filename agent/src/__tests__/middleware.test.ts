import { describe, it, expect } from 'bun:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { authenticateRequest } from '../middleware';
import { loadTrustedPublicKey } from '../lib/jwt-auth';

async function makeAuth(): Promise<{ trusted: CryptoKey; sign: (overrides?: { iss?: string; aud?: string }) => Promise<string>; privateKey: CryptoKey }> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
  return {
    trusted,
    privateKey,
    sign: (overrides) => {
      let b = new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA' })
        .setIssuer(overrides?.iss ?? 'homelab-manager')
        .setIssuedAt()
        .setJti(crypto.randomUUID())
        .setExpirationTime('30s');
      if (overrides?.aud !== undefined) b = b.setAudience(overrides.aud);
      return b.sign(privateKey);
    },
  };
}

describe('authenticateRequest (JWT)', () => {
  it('skips auth on /health', async () => {
    const { trusted } = await makeAuth();
    const result = await authenticateRequest(new Headers(), trusted, '/health');
    expect(result).toBeNull();
  });

  it('returns 401 when Authorization missing', async () => {
    const { trusted } = await makeAuth();
    const result = await authenticateRequest(new Headers(), trusted, '/stats');
    expect(result?.status).toBe(401);
  });

  it('accepts a valid Bearer JWT', async () => {
    const { trusted, sign } = await makeAuth();
    const jwt = await sign();
    const result = await authenticateRequest(
      new Headers({ Authorization: `Bearer ${jwt}` }),
      trusted,
      '/stats',
    );
    expect(result).toBeNull();
  });

  it('rejects malformed Authorization scheme', async () => {
    const { trusted } = await makeAuth();
    const result = await authenticateRequest(
      new Headers({ Authorization: 'Basic xyz' }),
      trusted,
      '/stats',
    );
    expect(result?.status).toBe(401);
  });

  it('rejects JWT signed by a different key', async () => {
    const { trusted } = await makeAuth();
    const other = await makeAuth();
    const jwt = await other.sign();
    const result = await authenticateRequest(
      new Headers({ Authorization: `Bearer ${jwt}` }),
      trusted,
      '/stats',
    );
    expect(result?.status).toBe(401);
  });

  it('rejects JWT with wrong issuer', async () => {
    const { trusted, sign } = await makeAuth();
    const jwt = await sign({ iss: 'attacker' });
    const result = await authenticateRequest(
      new Headers({ Authorization: `Bearer ${jwt}` }),
      trusted,
      '/stats',
    );
    expect(result?.status).toBe(401);
  });

  it('accepts a JWT with matching aud when expectedAudience is set', async () => {
    const { trusted, sign } = await makeAuth();
    const jwt = await sign({ aud: 'host-a' });
    const result = await authenticateRequest(
      new Headers({ Authorization: `Bearer ${jwt}` }),
      trusted,
      '/stats',
      'host-a',
    );
    expect(result).toBeNull();
  });

  it('rejects a JWT with mismatched aud when expectedAudience is set', async () => {
    const { trusted, sign } = await makeAuth();
    const jwt = await sign({ aud: 'host-b' });
    const result = await authenticateRequest(
      new Headers({ Authorization: `Bearer ${jwt}` }),
      trusted,
      '/stats',
      'host-a',
    );
    expect(result?.status).toBe(401);
  });

  it('returns 401 when Bearer token is empty', async () => {
    const { trusted } = await makeAuth();
    const result = await authenticateRequest(
      new Headers({ Authorization: 'Bearer ' }),
      trusted,
      '/stats',
    );
    expect(result?.status).toBe(401);
  });

  it('requires auth on /auth/verify (not bypassed like /health)', async () => {
    const { trusted, sign } = await makeAuth();
    const noAuth = await authenticateRequest(new Headers(), trusted, '/auth/verify');
    expect(noAuth?.status).toBe(401);
    const jwt = await sign();
    const withAuth = await authenticateRequest(
      new Headers({ Authorization: `Bearer ${jwt}` }),
      trusted,
      '/auth/verify',
    );
    expect(withAuth).toBeNull();
  });
});
