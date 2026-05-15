import { createMiddleware } from '@tanstack/react-start';
import type { AuthUser } from '@/lib/auth/types';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';

let cachedSessionManager: import('@/lib/auth/session-manager').SessionManager | null = null;

/** Validates session cookies and injects AuthUser into server function context. Dynamic imports keep server-only modules out of the client bundle. */
export const authMiddleware = createMiddleware().server(
  async ({ next, context }) => {
    const { isAuthDisabled } = await import('@/lib/config/auth-config');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ctx = context as any;

    if (isAuthDisabled()) {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-return
      return next({ context: { ...ctx, user: SYNTHETIC_ADMIN as AuthUser } });
    }

    // Check the cookie before building the session manager to skip DB connections on unauthenticated requests.
    const { getRequest } = await import('@tanstack/start-server-core');
    const cookieHeader = getRequest().headers.get('cookie') ?? null;
    const sessionToken = parseCookie(cookieHeader, 'session');

    if (!sessionToken) {
      throw new AuthError(401, 'No session');
    }

    if (!cachedSessionManager) {
      const { buildSessionManager } = await import('@/lib/auth/session-manager');
      cachedSessionManager = await buildSessionManager();
    }

    const user = await cachedSessionManager.validateSession(sessionToken);
    if (!user) {
      throw new AuthError(401, 'Invalid or expired session');
    }

    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return next({ context: { ...ctx, user } });
  },
);

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

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Reset cached session manager (for testing only).
 */
export function resetAuthMiddlewareState(): void {
  cachedSessionManager = null;
}
