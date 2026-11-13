import { createMiddleware } from '@tanstack/react-start';

/** Validates session cookies and injects AuthUser into server function context. Dynamic imports keep server-only modules out of the client bundle. */
export const authMiddleware = createMiddleware().server(
  async ({ next }) => {
    const { getRequest } = await import('@tanstack/start-server-core');
    const { resolveUserFromCookie } = await import('@/lib/auth/resolve-user');
    const user = await resolveUserFromCookie(getRequest());

    if (!user) {
      throw new AuthError(401, 'Unauthorized');
    }

    return next({ context: { user } });
  },
);

export class AuthError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}
