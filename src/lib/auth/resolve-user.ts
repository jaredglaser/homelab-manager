import type { AuthUser } from '@/lib/auth/types';

let cachedSessionManager: import('@/lib/auth/session-manager').SessionManager | null = null;

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = header.match(new RegExp(`(?:^|;\\s*)${escapedName}=([^;]*)`));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/** Single seam for cookie-to-AuthUser resolution; callers pick their own error mode around the result. */
export async function resolveUserFromCookie(request: Request): Promise<AuthUser | null> {
  const { isAuthDisabled } = await import('@/lib/config/auth-config');
  if (isAuthDisabled()) {
    const { SYNTHETIC_ADMIN } = await import('@/lib/auth/types');
    return SYNTHETIC_ADMIN;
  }

  // Check the cookie before building the session manager to skip DB connections on unauthenticated requests.
  const cookieHeader = request.headers.get('cookie');
  const sessionToken = parseCookie(cookieHeader, 'session');
  if (!sessionToken) return null;

  if (!cachedSessionManager) {
    const { buildSessionManager } = await import('@/lib/auth/session-manager');
    cachedSessionManager = await buildSessionManager();
  }

  return cachedSessionManager.validateSession(sessionToken);
}

/** Test-only reset of the cached session manager. */
export function resetAuthResolverState(): void {
  cachedSessionManager = null;
}
