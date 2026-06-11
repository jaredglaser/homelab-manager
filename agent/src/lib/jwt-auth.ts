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

/**
 * Verifies a manager-issued JWT.
 *
 * @param expectedAudience host name to match against the token's aud claim
 *   (from AGENT_HOST_NAME). When undefined, audience verification is skipped
 *   for back-compat with deployments that predate the env var.
 */
export async function verifyAgentJwt(
  jwt: string,
  publicKey: CryptoKey,
  expectedAudience?: string,
): Promise<void> {
  await jwtVerify(jwt, publicKey, {
    issuer: AGENT_JWT_ISSUER,
    algorithms: ['EdDSA'],
    maxTokenAge: '30s',
    // Worker and agent run on different machines; a few seconds of NTP drift
    // would otherwise produce hard-to-diagnose 401s on every request.
    clockTolerance: '5s',
    ...(expectedAudience !== undefined ? { audience: expectedAudience } : {}),
  });
}
