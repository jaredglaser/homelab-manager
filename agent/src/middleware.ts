import { verifyAgentJwt } from './lib/jwt-auth';

/**
 * Validates an HTTP request's Authorization Bearer JWT against the agent's
 * trusted public key. Bypasses /health.
 *
 * @param expectedAudience host name from AGENT_HOST_NAME; when undefined the
 *   aud claim is not checked (back-compat for agents without the env var)
 *
 * Returns a Response on rejection, or `null` on success.
 */
export async function authenticateRequest(
  headers: Headers,
  trustedPublicKey: CryptoKey,
  pathname?: string,
  expectedAudience?: string,
): Promise<Response | null> {
  if (pathname === '/health') return null;

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
