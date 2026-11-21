import { verifyAgentJwt } from './lib/jwt-auth';

/**
 * Validates an HTTP request's Authorization Bearer JWT against the agent's
 * trusted public key. Bypasses /health.
 *
 * @param expectedAudience host name the token's aud claim must match.
 * Returns a Response on rejection, or `null` on success.
 */
/**
 * Paths served without a JWT: the liveness probe, plus the enrollment handshake,
 * which carries its own authorization (a signature over a single-use nonce) and
 * must stay reachable on a host that cannot yet verify a token.
 */
export const AUTH_BYPASS_PATHS: ReadonlySet<string> = new Set(['/health', '/tls/challenge', '/tls/enroll']);

export async function authenticateRequest(
  headers: Headers,
  trustedPublicKey: CryptoKey,
  pathname: string,
  expectedAudience: string,
): Promise<Response | null> {
  if (AUTH_BYPASS_PATHS.has(pathname)) return null;

  const authHeader = headers.get('Authorization');
  if (!authHeader) return new Response('Unauthorized', { status: 401 });

  const [scheme, token] = authHeader.split(' ', 2);
  if (scheme !== 'Bearer' || !token?.trim()) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    await verifyAgentJwt(token, trustedPublicKey, expectedAudience);
    return null;
  } catch (err) {
    console.error('JWT verification failed:', err);
    return new Response('Unauthorized', { status: 401 });
  }
}
