import type { AuthUser, Role } from '@/lib/auth/types';

export class ForbiddenError extends Error {
  public readonly status = 403;

  constructor(message = 'Insufficient permissions') {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/**
 * Returns a guard function that throws ForbiddenError if the user's role
 * is not among the allowed roles.
 */
export function requireRole(...allowed: Role[]) {
  return (user: AuthUser): void => {
    if (!allowed.includes(user.role)) {
      throw new ForbiddenError();
    }
  };
}
