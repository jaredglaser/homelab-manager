import { describe, it, expect } from 'bun:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { authenticateRequest } from '../middleware';
import { loadTrustedPublicKey } from '../lib/jwt-auth';

const HOST = 'test-host';

async function makeAuth(): Promise<{ trusted: CryptoKey; sign: (overrides?: { iss?: string; aud?: string }) => Promise<string>; privateKey: CryptoKey }> {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
  return {
    trusted,
    privateKey,
    sign: (overrides) =>
      new SignJWT({})
        .setProtectedHeader({ alg: 'EdDSA' })
        .setIssuer(overrides?.iss ?? 'homelab-manager')
        .setAudience(overrides?.aud ?? HOST)
        .setIssuedAt()
        .setJti(crypto.randomUUID())
        .setExpirationTime('30s')
        .sign(privateKey),
  };
}

describe('authenticateRequest (JWT)', () => {
  it('skips auth on /health', async () => {
    const { trusted } = await makeAuth();
    const result = await authenticateRequest(new Headers(), trusted, '/health', HOST);
    expect(result).toBeNull();
  });

  it('returns 401 when Authorization missing', async () => {
    const { trusted } = await makeAuth();
    const result = await authenticateRequest(new Headers(), trusted, '/stats', HOST);
    expect(result?.status).toBe(401);
  });

  it('accepts a valid Bearer JWT', async () => {
    const { trusted, sign } = await makeAuth();
    const jwt = await sign();
    const result = await authenticateRequest(
      new Headers({ Authorization: `Bearer ${jwt}` }),
      trusted,
      '/stats',
      HOST,
    );
    expect(result).toBeNull();
  });

  it('rejects malformed Authorization scheme', async () => {
    const { trusted } = await makeAuth();
    const result = await authenticateRequest(
      new Headers({ Authorization: 'Basic xyz' }),
      trusted,
      '/stats',
      HOST,
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
      HOST,
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
      HOST,
    );
    expect(result?.status).toBe(401);
  });

  it('rejects a JWT whose aud is another host', async () => {
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
      HOST,
    );
    expect(result?.status).toBe(401);
  });

  it('requires auth on /auth/verify (not bypassed like /health)', async () => {
    const { trusted, sign } = await makeAuth();
    const noAuth = await authenticateRequest(new Headers(), trusted, '/auth/verify', HOST);
    expect(noAuth?.status).toBe(401);
    const jwt = await sign();
    const withAuth = await authenticateRequest(
      new Headers({ Authorization: `Bearer ${jwt}` }),
      trusted,
      '/auth/verify',
      HOST,
    );
    expect(withAuth).toBeNull();
  });

  it('requires auth on /info (version and capability detail is not public)', async () => {
    const { trusted, sign } = await makeAuth();
    const noAuth = await authenticateRequest(new Headers(), trusted, '/info');
    expect(noAuth?.status).toBe(401);
    const jwt = await sign();
    const withAuth = await authenticateRequest(
      new Headers({ Authorization: `Bearer ${jwt}` }),
      trusted,
      '/info',
    );
    expect(withAuth).toBeNull();
  });
});
