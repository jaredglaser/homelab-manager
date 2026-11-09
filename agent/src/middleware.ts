import { verifyAgentJwt } from './lib/jwt-auth';

/**
 * Validates an HTTP request's Authorization Bearer JWT against the agent's
 * trusted public key. Bypasses /health.
 *
 * @param expectedAudience host name the token's aud claim must match.
 * Returns a Response on rejection, or `null` on success.
 */
/** Path that may be served without a JWT (the liveness probe). A test pins this to be inside HTTP_ENROLLMENT_ALLOWED_PATHS, so restricted plain-HTTP mode does not 403 the health check. */
export const AUTH_BYPASS_PATH = '/health';

export async function authenticateRequest(
  headers: Headers,
  trustedPublicKey: CryptoKey,
  pathname: string,
  expectedAudience: string,
): Promise<Response | null> {
  if (pathname === AUTH_BYPASS_PATH) return null;

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
