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
  if (scheme !== 'Bearer' || token !== expectedToken) {
    return new Response('Unauthorized', { status: 401 });
  }

  return null;
}
