import { createMiddleware } from '@tanstack/react-start';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import type { Role } from '@/lib/auth/types';

/** Server-function middleware that throws ForbiddenError unless the signed-in user holds one of `allowed`. */
export function roleMiddleware(...allowed: [Role, ...Role[]]) {
  return createMiddleware({ type: 'function' })
    .middleware([authMiddleware])
    .server(({ next, context }) => {
      requireRole(...allowed)(context.user);
      return next();
    });
}
