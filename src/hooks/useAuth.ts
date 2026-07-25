import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { getSession } from '@/data/auth.functions';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser } from '@/lib/auth/types';

/**
 * Checks the current session on mount and redirects to /login if unauthenticated.
 *
 * @returns user - the authenticated user, or null when auth is disabled or not logged in
 * @returns loading - true until the session check resolves
 * @returns authEnabled - true when authentication is on (AUTH_DISABLED not truthy, i.e. not the synthetic-admin path)
 */
export function useAuth(): { user: AuthUser | null; loading: boolean; authEnabled: boolean } {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [authEnabled, setAuthEnabled] = useState(false);
  const navigate = useNavigate();
  const fetchSession = useServerFn(getSession);

  useEffect(() => {
    fetchSession()
      .then((result) => {
        if (!result) {
          setAuthEnabled(true);
          void navigate({ to: '/login' });
        } else if (result.id === SYNTHETIC_ADMIN.id) {
          // Auth disabled: synthetic admin is not a real user, don't surface it in the UI.
          setAuthEnabled(false);
          setUser(null);
        } else {
          setAuthEnabled(true);
          setUser(result);
        }
      })
      .catch((error) => {
        console.error('[useAuth] Session check failed:', error);
        void navigate({ to: '/login' });
      })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { user, loading, authEnabled };
}

/**
 * True when the session may call server functions guarded by `requireRole('admin', 'operator')`.
 * False while the check is in flight; true when auth is disabled, where every request runs
 * as the synthetic admin that `useAuth` reports as a null user.
 */
export function useCanWrite(): boolean {
  const { user, loading, authEnabled } = useAuth();
  if (loading) return false;
  if (!authEnabled) return true;
  return user?.role === 'admin' || user?.role === 'operator';
}
