import { useEffect } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { getSession } from '@/data/auth.functions';
import { queryClient } from '@/lib/query-client';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser } from '@/lib/auth/types';

export const SESSION_QUERY_KEY = ['auth', 'session'] as const;

export type SessionState =
  | { status: 'loading' }
  | { status: 'signed-in'; user: AuthUser }
  | { status: 'auth-disabled' }
  | { status: 'signed-out' }
  | { status: 'failed' };

async function fetchSession(): Promise<AuthUser | null> {
  try {
    return await getSession();
  } catch (error) {
    console.error('[useAuth] Session check failed:', error);
    throw error;
  }
}

/** One getSession per page load, shared by every caller through the app's query cache. */
export function useSession(): SessionState {
  // AppShell calls this above its QueryClientProvider, so the client is passed explicitly.
  const { data, isPending, isError } = useQuery(
    {
      queryKey: SESSION_QUERY_KEY,
      queryFn: fetchSession,
      staleTime: Infinity,
      gcTime: Infinity,
      retry: false,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
    },
    queryClient,
  );
  if (isPending) return { status: 'loading' };
  if (isError) return { status: 'failed' };
  if (!data) return { status: 'signed-out' };
  if (data.id === SYNTHETIC_ADMIN.id) return { status: 'auth-disabled' };
  return { status: 'signed-in', user: data };
}

/**
 * Reads the shared session and redirects to /login when there is none or the check failed.
 *
 * @returns user - the authenticated user, or null when auth is disabled or not logged in
 * @returns loading - true until the session check resolves
 * @returns authEnabled - true when authentication is on (AUTH_DISABLED not truthy, i.e. not the synthetic-admin path)
 */
export function useAuth(): { user: AuthUser | null; loading: boolean; authEnabled: boolean } {
  const session = useSession();
  const navigate = useNavigate();
  const mustLogIn = session.status === 'signed-out' || session.status === 'failed';

  useEffect(() => {
    if (mustLogIn) void navigate({ to: '/login' });
  }, [mustLogIn, navigate]);

  return {
    user: session.status === 'signed-in' ? session.user : null,
    loading: session.status === 'loading',
    authEnabled: session.status === 'signed-in' || session.status === 'signed-out',
  };
}

export type RoleRequirement = 'write' | 'admin';

export const VIEWER_DENIED_COPY = 'Your role can view but not change things. Ask an operator or admin.';
export const OPERATOR_DENIED_COPY = 'Only an admin can do this.';

export type RoleAccess =
  | { kind: 'allowed' }
  | { kind: 'unknown' }
  | { kind: 'denied'; reason: string };

/** `write` is admin or operator. A session still loading, or one whose check failed, is unknown and never allowed. */
export function roleAccess(session: SessionState, requires: RoleRequirement): RoleAccess {
  if (session.status === 'auth-disabled') return { kind: 'allowed' };
  if (session.status !== 'signed-in') return { kind: 'unknown' };
  const { role } = session.user;
  if (role === 'admin') return { kind: 'allowed' };
  if (role === 'operator' && requires === 'write') return { kind: 'allowed' };
  return { kind: 'denied', reason: role === 'operator' ? OPERATOR_DENIED_COPY : VIEWER_DENIED_COPY };
}

export function useRoleAccess(requires: RoleRequirement): RoleAccess {
  return roleAccess(useSession(), requires);
}

/** True when the session may call server functions guarded by `requireRole('admin', 'operator')`. */
export function useCanWrite(): boolean {
  return useRoleAccess('write').kind === 'allowed';
}
