import { createServerFn } from '@tanstack/react-start';
import { createMiddleware } from '@tanstack/react-start';
import type { AuthUser } from '@/lib/auth/types';

let cachedSessionManager: import('@/lib/auth/session-manager').SessionManager | null = null;

/**
 * Middleware that reads the session cookie and resolves the AuthUser (or null).
 * Unlike authMiddleware, this never throws — it passes null when unauthenticated.
 */
const sessionReadMiddleware = createMiddleware().server(async ({ next, context }) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ctx = context as any;

  const { isAuthDisabled } = await import('@/lib/config/auth-config');
  if (isAuthDisabled()) {
    const { SYNTHETIC_ADMIN } = await import('@/lib/auth/types');
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return next({ context: { ...ctx, sessionUser: SYNTHETIC_ADMIN as AuthUser | null } });
  }

  const request = ctx.request as Request | undefined;
  const cookieHeader = request?.headers.get('cookie') ?? null;

  const { parseCookie } = await import('@/middleware/auth-middleware');
  const sessionToken = parseCookie(cookieHeader, 'session');

  if (!sessionToken) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    return next({ context: { ...ctx, sessionUser: null as AuthUser | null } });
  }

  if (!cachedSessionManager) {
    const { buildSessionManager } = await import('@/lib/auth/session-manager');
    cachedSessionManager = await buildSessionManager();
  }

  const user = await cachedSessionManager.validateSession(sessionToken);
  // eslint-disable-next-line @typescript-eslint/no-unsafe-return
  return next({ context: { ...ctx, sessionUser: user as AuthUser | null } });
});

/**
 * Returns the currently authenticated user, or null if unauthenticated.
 * Used by the client-side auth hook to check session state without throwing.
 */
export const getSession = createServerFn()
  .middleware([sessionReadMiddleware])
  .handler(async ({ context }): Promise<AuthUser | null> => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (context as any).sessionUser as AuthUser | null;
  });

/**
 * Reset cached session manager (for testing only).
 */
export function resetAuthFunctionsState(): void {
  cachedSessionManager = null;
}
