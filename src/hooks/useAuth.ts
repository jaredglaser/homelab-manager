import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { getSession } from '@/data/auth.functions';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser } from '@/lib/auth/types';

/**
 * Checks the current session on mount and redirects to /login if unauthenticated.
 * Returns the authenticated user (null when auth is disabled or not logged in) and a loading flag.
 */
export function useAuth(): { user: AuthUser | null; loading: boolean } {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const fetchSession = useServerFn(getSession);

  useEffect(() => {
    fetchSession()
      .then((result) => {
        if (!result) {
          void navigate({ to: '/login' });
        } else if (result.id === SYNTHETIC_ADMIN.id) {
          // Auth disabled: synthetic admin is not a real user, don't surface it in the UI.
          setUser(null);
        } else {
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

  return { user, loading };
}
