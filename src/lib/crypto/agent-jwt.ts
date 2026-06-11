import { SignJWT } from 'jose';

export const AGENT_JWT_ISSUER = 'homelab-manager';
const TTL_SECONDS = 30;

export async function signAgentJwt(privateKey: CryptoKey, hostName: string): Promise<string> {
  // aud pins the token to one agent: with shared or copy-pasted keys, an agent
  // configured with AGENT_HOST_NAME rejects tokens minted for a different host.
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
