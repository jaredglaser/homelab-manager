import { waitFor } from '@testing-library/react';
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

/** The open tooltip popup's text. A role-blocked button also carries its reason in a visually hidden description, so a plain text query cannot tell whether the tooltip opened. */
export async function findOpenTooltip(): Promise<string> {
  return await waitFor(() => {
    const popup = document.querySelector('[data-slot="tooltip-content"]');
    if (!popup) throw new Error('no tooltip is open');
    return popup.textContent;
  });
}

export function openTooltip(): Element | null {
  return document.querySelector('[data-slot="tooltip-content"]');
}
