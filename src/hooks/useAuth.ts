import { useEffect, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useServerFn } from '@tanstack/react-start';
import { getSession } from '@/data/auth.functions';
import type { AuthUser } from '@/lib/auth/types';

/**
 * Checks the current session on mount and redirects to /login if unauthenticated.
 * Returns the authenticated user and a loading flag.
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
        } else {
          setUser(result);
        }
      })
      .catch(() => {
        void navigate({ to: '/login' });
      })
      .finally(() => setLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { user, loading };
}
