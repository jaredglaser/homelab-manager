import { SignJWT } from 'jose';

export const AGENT_JWT_ISSUER = 'homelab-manager';
const TTL_SECONDS = 30;

export async function signAgentJwt(privateKey: CryptoKey, hostName: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuer(AGENT_JWT_ISSUER)
    .setSubject(hostName)
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime(`${TTL_SECONDS}s`)
    .sign(privateKey);
}
