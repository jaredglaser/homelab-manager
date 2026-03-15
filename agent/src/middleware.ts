import { timingSafeEqual } from 'crypto';

/**
 * Compares two strings for equality using a timing-safe algorithm to prevent timing attacks.
 *
 * @param a - First string to compare.
 * @param b - Second string to compare.
 * @returns `true` if the strings are equal, `false` otherwise. If the strings have different lengths, returns `false`.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Validate an HTTP request's Authorization header against an expected Bearer token, bypassing the /health path.
 *
 * @param headers - The request headers to inspect for an `Authorization` entry
 * @param expectedToken - The expected bearer token value to verify
 * @param pathname - Optional request path; authentication is skipped when this equals `/health`
 * @returns A `Response` with status 401 when authentication fails, or `null` when authentication succeeds or is bypassed
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
    return new Response('Internal Server Error', { status: 500 });
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
