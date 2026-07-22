import type { AuthUser } from '@/lib/auth/types';

let cachedSessionManager: import('@/lib/auth/session-manager').SessionManager | null = null;

/**
 * Parses a single cookie value from a Cookie header string.
 */
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

/**
 * Resolves the current user from a request's session cookie. This is the
 * single seam for cookie-to-AuthUser resolution: cookie extraction, the
 * AUTH_DISABLED synthetic-admin short-circuit, and session validation
 * against the cached SessionManager all live here so auth fixes (PKCE,
 * id_token-only sessions, JWKS verification, aud claim) only need to land
 * once. Callers pick their own error mode (throw / null / 401 response)
 * around this return value; none of them re-implement resolution.
 */
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

/**
 * Reset the cached session manager (for testing only).
 */
export function resetAuthResolverState(): void {
  cachedSessionManager = null;
}
