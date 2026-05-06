import { jwtVerify, importJWK, type JWK } from 'jose';

export const AGENT_JWT_ISSUER = 'homelab-manager';

export async function loadTrustedPublicKey(jwkJson: string): Promise<CryptoKey> {
  const parsed = JSON.parse(jwkJson) as JWK;
  return (await importJWK(parsed, 'EdDSA')) as CryptoKey;
}

export async function verifyAgentJwt(jwt: string, publicKey: CryptoKey): Promise<void> {
  await jwtVerify(jwt, publicKey, {
    issuer: AGENT_JWT_ISSUER,
    algorithms: ['EdDSA'],
  });
}
