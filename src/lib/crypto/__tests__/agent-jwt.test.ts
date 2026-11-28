import { describe, it, expect } from 'bun:test';
import { generateKeyPair, jwtVerify } from 'jose';
import { signAgentJwt } from '@/lib/crypto/agent-jwt';

describe('signAgentJwt', () => {
  it('produces a JWT verifiable with the matching public key', async () => {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const jwt = await signAgentJwt(privateKey, 'myhost');
    const { payload, protectedHeader } = await jwtVerify(jwt, publicKey, {
      issuer: 'homelab-manager',
      audience: 'myhost',
    });
    expect(protectedHeader.alg).toBe('EdDSA');
    expect(payload.iss).toBe('homelab-manager');
    expect(payload.sub).toBe('myhost');
    expect(payload.aud).toBe('myhost');
    expect(typeof payload.jti).toBe('string');
    expect(typeof payload.iat).toBe('number');
    expect(typeof payload.exp).toBe('number');
    expect((payload.exp as number) - (payload.iat as number)).toBe(30);
  });

  it('different jti per call', async () => {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const a = await signAgentJwt(privateKey, 'h');
    const b = await signAgentJwt(privateKey, 'h');
    const { payload: payloadA } = await jwtVerify(a, publicKey, { issuer: 'homelab-manager' });
    const { payload: payloadB } = await jwtVerify(b, publicKey, { issuer: 'homelab-manager' });
    expect(payloadA.jti).not.toBe(payloadB.jti);
  });

  it('fails audience verification for a different host', async () => {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const jwt = await signAgentJwt(privateKey, 'host-a');
    await expect(
      jwtVerify(jwt, publicKey, { issuer: 'homelab-manager', audience: 'host-b' }),
    ).rejects.toThrow();
  });
});
