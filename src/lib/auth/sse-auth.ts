import type { AuthUser } from '@/lib/auth/types';

/** Callers turn a null result into a 401 Response themselves. */
export async function authenticateSSE(request: Request): Promise<AuthUser | null> {
  const { resolveUserFromCookie } = await import('@/lib/auth/resolve-user');
  return resolveUserFromCookie(request);
}
