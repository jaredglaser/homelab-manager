import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Compares two strings for equality using a timing-safe algorithm to prevent timing attacks.
 *
 * Both inputs are SHA-256 hashed to fixed 32-byte buffers before comparison,
 * so the comparison time does not leak information about the input lengths.
 *
 * @param a - First string to compare.
 * @param b - Second string to compare.
 * @returns `true` if the strings are equal, `false` otherwise.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Validate an HTTP request's Authorization header against an expected Bearer token, bypassing the /health path.
 *
 * @param headers - The request headers to inspect for an `Authorization` entry
 * @param expectedToken - The expected bearer token value to verify
 * @param pathname - Optional request path; authentication is skipped when this equals `/health`
 * @returns A `Response` with status 500 when `expectedToken` is empty or whitespace-only (defense-in-depth guard), 401 when authentication fails, or `null` when authentication succeeds or is bypassed
 */
export function authenticateRequest(
  headers: Headers,
  expectedToken: string,
  pathname?: string
): Response | null {
  if (pathname === '/health') {
    return null;
  }

  if (!expectedToken.trim()) {
    console.error('AGENT_TOKEN is empty or whitespace — rejecting all requests');
    return Response.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const authHeader = headers.get('Authorization');
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [scheme, token] = authHeader.split(' ', 2);
  if (scheme !== 'Bearer' || !token?.trim() || !constantTimeEqual(token, expectedToken)) {
    return new Response('Unauthorized', { status: 401 });
  }

  return null;
}
