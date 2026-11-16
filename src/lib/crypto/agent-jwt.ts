import { SignJWT } from 'jose';

export const AGENT_JWT_ISSUER = 'homelab-manager';
const TTL_SECONDS = 30;

/**
 * The payload both sides sign for enrollment: the agent rebuilds it from its own
 * host name and the sans it received, so the format is pinned by a test on each
 * side rather than shared through an import.
 */
export function enrollmentPayload(nonce: string, hostName: string, sans: readonly string[]): string {
  return `${nonce}\n${hostName}\n${sans.join(',')}`;
}

/** Detached Ed25519 signature (base64) over an enrollment payload. The agent verifies it. */
export async function signAgentPayload(privateKey: CryptoKey, payload: string): Promise<string> {
  const signature = await crypto.subtle.sign('Ed25519', privateKey, new TextEncoder().encode(payload));
  return Buffer.from(signature).toString('base64');
}

export async function signAgentJwt(privateKey: CryptoKey, hostName: string): Promise<string> {
  // aud pins the token to one host so a reused keypair can't accept another's.
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(AGENT_JWT_ISSUER)
    .setSubject(hostName)
    .setAudience(hostName)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(privateKey);
}
