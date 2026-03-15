import { timingSafeEqual } from 'crypto';

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function authenticateRequest(
  headers: Headers,
  expectedToken: string,
  pathname?: string
): Response | null {
  if (pathname === '/health') {
    return null;
  }

  const authHeader = headers.get('Authorization');
  if (!authHeader) {
    return new Response('Unauthorized', { status: 401 });
  }

  const [scheme, token] = authHeader.split(' ', 2);
  if (scheme !== 'Bearer' || !token || !constantTimeEqual(token, expectedToken)) {
    return new Response('Unauthorized', { status: 401 });
  }

  return null;
}
