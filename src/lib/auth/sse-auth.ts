import type { AuthUser } from '@/lib/auth/types';
import type { SessionManager } from '@/lib/auth/session-manager';

let cachedSessionManager: SessionManager | null = null;

/**
 * Authenticates an SSE request by extracting and validating the session cookie.
 * Returns the AuthUser on success, or null if unauthenticated.
 * When auth is disabled (DISABLE_AUTH=true), returns the synthetic admin user.
 */
export async function authenticateSSE(request: Request): Promise<AuthUser | null> {
  const { isAuthDisabled } = await import('@/lib/config/auth-config');
  if (isAuthDisabled()) {
    const { SYNTHETIC_ADMIN } = await import('@/lib/auth/types');
    return SYNTHETIC_ADMIN;
  }

  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader) return null;

  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
  const token = match ? decodeURIComponent(match[1]) : null;
  if (!token) return null;

  if (!cachedSessionManager) {
    const { buildSessionManager } = await import('@/lib/auth/session-manager');
    cachedSessionManager = await buildSessionManager();
  }
  return cachedSessionManager.validateSession(token);
}

/**
 * Reset cached session manager (for testing only).
 */
export function resetSSEAuthState(): void {
  cachedSessionManager = null;
}
