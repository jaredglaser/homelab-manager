import { createServerFn } from '@tanstack/react-start';
import { createMiddleware } from '@tanstack/react-start';
import { z } from 'zod';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
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
 * List all users (admin only).
 */
export const listUsers = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    requireRole('admin')(context.user);

    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { UserRepository } = await import('@/lib/database/repositories/user-repository');

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new UserRepository(dbClient.getPool());

    return repo.findAll();
  });

/**
 * List all active sessions with user info (admin only).
 */
export const listSessions = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }) => {
    requireRole('admin')(context.user);

    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { SessionRepository } = await import('@/lib/database/repositories/session-repository');

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new SessionRepository(dbClient.getPool());

    return repo.findAllWithUser();
  });

/**
 * Revoke a session by ID (admin only).
 */
export const revokeSession = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(z.object({ sessionId: z.string() }))
  .handler(async ({ data, context }): Promise<void> => {
    requireRole('admin')(context.user);

    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { SessionRepository } = await import('@/lib/database/repositories/session-repository');

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new SessionRepository(dbClient.getPool());

    await repo.deleteById(data.sessionId);
  });

/**
 * Revoke all sessions for a user (admin only).
 */
export const revokeAllUserSessions = createServerFn()
  .middleware([authMiddleware])
  .inputValidator(z.object({ userId: z.number() }))
  .handler(async ({ data, context }): Promise<void> => {
    requireRole('admin')(context.user);

    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { SessionRepository } = await import('@/lib/database/repositories/session-repository');

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new SessionRepository(dbClient.getPool());

    await repo.deleteByUserId(data.userId);
  });

/**
 * Returns the OIDC group names mapped to each role (admin only).
 * Reads server-side OIDC_ROLE_* env vars so the UI shows the actual deployed values.
 */
export const getRoleMapping = createServerFn()
  .middleware([authMiddleware])
  .handler(async ({ context }): Promise<{ admin: string; operator: string; viewer: string }> => {
    requireRole('admin')(context.user);

    const { isAuthDisabled, loadAuthConfig } = await import('@/lib/config/auth-config');
    if (isAuthDisabled()) {
      return { admin: 'homelab-admins', operator: 'homelab-operators', viewer: 'homelab-viewers' };
    }
    const config = loadAuthConfig();
    return config.roleMapping;
  });

/**
 * Reset cached session manager (for testing only).
 */
export function resetAuthFunctionsState(): void {
  cachedSessionManager = null;
}
