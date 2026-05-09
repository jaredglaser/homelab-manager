import { jwtVerify, importJWK, type JWK } from 'jose';

export const AGENT_JWT_ISSUER = 'homelab-manager';

export async function loadTrustedPublicKey(jwkJson: string): Promise<CryptoKey> {
  const parsed = JSON.parse(jwkJson) as JWK;
  if (parsed.kty !== 'OKP' || parsed.crv !== 'Ed25519' || typeof parsed.x !== 'string' || 'd' in parsed) {
    throw new Error(
      'AGENT_TRUSTED_PUBKEY must be a public Ed25519 JWK (kty=OKP, crv=Ed25519, with x, without d)',
    );
  }
  return (await importJWK(parsed, 'EdDSA')) as CryptoKey;
}

export async function verifyAgentJwt(jwt: string, publicKey: CryptoKey): Promise<void> {
  await jwtVerify(jwt, publicKey, {
    issuer: AGENT_JWT_ISSUER,
    algorithms: ['EdDSA'],
    maxTokenAge: '30s',
  });
}
