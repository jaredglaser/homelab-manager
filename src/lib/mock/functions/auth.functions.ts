import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser, RoleMappingConfig } from '@/lib/auth/types';

/**
 * Demo mocks for the auth server functions.
 *
 * The demo is a static SPA with no backend, so the real server functions in
 * `@/data/auth.functions` have no endpoint to hit. Vite aliases this module in
 * its place (see `vite.config.ts`).
 *
 * `getSession` returns the synthetic admin so `useAuth` takes its auth-disabled
 * branch (no /login redirect, user stays null). With user null the settings
 * page never renders `AuthManagementCard`, so the admin-only functions below are
 * never actually called; they exist only to satisfy module resolution.
 */
export const getSession = async (): Promise<AuthUser | null> => SYNTHETIC_ADMIN;

export const listUsers = async (): Promise<AuthUser[]> => [];

export const listSessions = async (): Promise<never[]> => [];

export const revokeSession = async (): Promise<void> => {};

export const revokeAllUserSessions = async (): Promise<void> => {};

export const getRoleMapping = async (): Promise<RoleMappingConfig> => ({
  admin: 'homelab-admins',
  operator: 'homelab-operators',
  viewer: 'homelab-viewers',
});
