import { describe, it, expect } from 'bun:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { loadTrustedPublicKey, verifyAgentJwt } from '../jwt-auth';

async function makePair() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return { publicKey, privateKey };
}

async function sign(privateKey: CryptoKey, opts: { iss?: string; aud?: string; expSeconds?: number } = {}) {
  let b = new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(opts.iss ?? 'homelab-manager')
    .setIssuedAt()
    .setJti(crypto.randomUUID());
  if (opts.aud !== undefined) b = b.setAudience(opts.aud);
  if (opts.expSeconds !== undefined) b = b.setExpirationTime(`${opts.expSeconds}s`);
  return b.sign(privateKey);
}

describe('verifyAgentJwt', () => {
  it('accepts a valid JWT signed by the trusted key', async () => {
    const { publicKey, privateKey } = await makePair();
    const jwk = await exportJWK(publicKey);
    const trusted = await loadTrustedPublicKey(JSON.stringify(jwk));
    const jwt = await sign(privateKey, { expSeconds: 30 });
    await expect(verifyAgentJwt(jwt, trusted)).resolves.toBeUndefined();
  });

  it('rejects JWT with wrong issuer', async () => {
    const { publicKey, privateKey } = await makePair();
    const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
    const jwt = await sign(privateKey, { iss: 'attacker', expSeconds: 30 });
    await expect(verifyAgentJwt(jwt, trusted)).rejects.toThrow();
  });

  it('rejects expired JWT', async () => {
    const { publicKey, privateKey } = await makePair();
    const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('homelab-manager')
      .setIssuedAt(Math.floor(Date.now() / 1000) - 120)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .setJti(crypto.randomUUID())
      .sign(privateKey);
    await expect(verifyAgentJwt(jwt, trusted)).rejects.toThrow();
  });

  it('rejects JWT signed by a different key', async () => {
    const trustedPair = await makePair();
    const otherPair = await makePair();
    const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(trustedPair.publicKey)));
    const jwt = await sign(otherPair.privateKey, { expSeconds: 30 });
    await expect(verifyAgentJwt(jwt, trusted)).rejects.toThrow();
  });

  it('accepts a JWT whose aud matches the expected audience', async () => {
    const { publicKey, privateKey } = await makePair();
    const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
    const jwt = await sign(privateKey, { aud: 'host-a', expSeconds: 30 });
    await expect(verifyAgentJwt(jwt, trusted, 'host-a')).resolves.toBeUndefined();
  });

  it('rejects a JWT whose aud does not match the expected audience', async () => {
    const { publicKey, privateKey } = await makePair();
    const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
    const jwt = await sign(privateKey, { aud: 'host-b', expSeconds: 30 });
    await expect(verifyAgentJwt(jwt, trusted, 'host-a')).rejects.toThrow();
  });

  it('rejects a JWT without aud when an expected audience is set', async () => {
    const { publicKey, privateKey } = await makePair();
    const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
    const jwt = await sign(privateKey, { expSeconds: 30 });
    await expect(verifyAgentJwt(jwt, trusted, 'host-a')).rejects.toThrow();
  });

  it('skips audience verification when no expected audience is set', async () => {
    const { publicKey, privateKey } = await makePair();
    const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
    const jwt = await sign(privateKey, { aud: 'some-other-host', expSeconds: 30 });
    await expect(verifyAgentJwt(jwt, trusted)).resolves.toBeUndefined();
  });

  it('accepts a JWT that expired within the 5s clock tolerance', async () => {
    const { publicKey, privateKey } = await makePair();
    const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('homelab-manager')
      .setIssuedAt(now - 33)
      .setExpirationTime(now - 3)
      .setJti(crypto.randomUUID())
      .sign(privateKey);
    await expect(verifyAgentJwt(jwt, trusted)).resolves.toBeUndefined();
  });

  it('accepts a JWT issued slightly in the future (skewed agent clock)', async () => {
    const { publicKey, privateKey } = await makePair();
    const trusted = await loadTrustedPublicKey(JSON.stringify(await exportJWK(publicKey)));
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'EdDSA' })
      .setIssuer('homelab-manager')
      .setIssuedAt(now + 3)
      .setExpirationTime(now + 33)
      .setJti(crypto.randomUUID())
      .sign(privateKey);
    await expect(verifyAgentJwt(jwt, trusted)).resolves.toBeUndefined();
  });

  it('loadTrustedPublicKey throws on invalid JSON', async () => {
    await expect(loadTrustedPublicKey('not-json')).rejects.toThrow();
  });

  it('loadTrustedPublicKey throws on valid JSON that is not an Ed25519 public JWK', async () => {
    const rsaLike = JSON.stringify({ kty: 'RSA', n: 'abc', e: 'AQAB' });
    await expect(loadTrustedPublicKey(rsaLike)).rejects.toThrow(
      'AGENT_TRUSTED_PUBKEY must be a public Ed25519 JWK',
    );
  });

  it('loadTrustedPublicKey throws when JWK contains a private key component', async () => {
    const { privateKey } = await makePair();
    const privateJwk = JSON.stringify(await exportJWK(privateKey));
    await expect(loadTrustedPublicKey(privateJwk)).rejects.toThrow(
      'AGENT_TRUSTED_PUBKEY must be a public Ed25519 JWK',
    );
  });
});
