import type { AuthUser } from '@/lib/auth/types';

/**
 * Authenticates an SSE request by extracting and validating the session cookie.
 * Returns the AuthUser on success, or null if unauthenticated. Callers turn a
 * null into a 401 Response themselves (see createStatsSseHandler,
 * createBroadcastSseHandler, docker-logs.$containerId).
 */
export async function authenticateSSE(request: Request): Promise<AuthUser | null> {
  const { resolveUserFromCookie } = await import('@/lib/auth/resolve-user');
  return resolveUserFromCookie(request);
}
