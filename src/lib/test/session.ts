import { queryClient } from '@/lib/query-client';
import { SESSION_QUERY_KEY } from '@/hooks/useAuth';
import { SYNTHETIC_ADMIN, type AuthUser, type Role } from '@/lib/auth/types';

export function seedSession(as: Role | 'auth-disabled'): void {
  const user: AuthUser = as === 'auth-disabled'
    ? SYNTHETIC_ADMIN
    : { id: 42, email: `${as}@example.com`, name: as, role: as };
  queryClient.setQueryData<AuthUser | null>(SESSION_QUERY_KEY, user);
}

export function clearSession(): void {
  queryClient.removeQueries({ queryKey: SESSION_QUERY_KEY });
}
