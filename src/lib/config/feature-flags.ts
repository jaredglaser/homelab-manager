import { isAuthDisabled } from '@/lib/config/auth-config';

/**
 * Check if authentication is enabled (server-side only). Auth is required by
 * default; AUTH_DISABLED=true is the explicit opt-out.
 * Auth state reaches the client through the getSession() server function.
 */
export function isAuthEnabled(): boolean {
  return !isAuthDisabled();
}
