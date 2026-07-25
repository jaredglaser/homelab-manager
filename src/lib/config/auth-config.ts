import type { AuthConfig } from '@/lib/auth/types';

const TRUTHY_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSY_VALUES = new Set(['false', '0', 'no', 'off']);

function normalizedAuthDisabled(): string | undefined {
  return process.env.AUTH_DISABLED?.trim().toLowerCase();
}

/**
 * Authentication is required by default; disabling it is an explicit opt-out.
 * Returns true only when AUTH_DISABLED is set to a truthy value (true/1/yes/on,
 * case-insensitive). Unset, empty, falsy, or mistyped values keep auth on, so
 * a typo fails closed instead of silently serving every request as a
 * synthetic admin. enforceAuthConfig() rejects unrecognized values at startup.
 */
export function isAuthDisabled(): boolean {
  const value = normalizedAuthDisabled();
  return value !== undefined && TRUTHY_VALUES.has(value);
}

/**
 * Startup validation of the auth opt-out, called from initServer(). Throws on:
 * - the removed AUTH_ENABLED variable (replaced by AUTH_DISABLED)
 * - unrecognized AUTH_DISABLED values
 * - auth required but the OIDC configuration does not load
 *
 * When auth is disabled, logs a prominent warning instead of throwing.
 */
export function enforceAuthConfig(): void {
  if (process.env.AUTH_ENABLED !== undefined) {
    throw new Error(
      'AUTH_ENABLED was replaced by AUTH_DISABLED; authentication is now required by default. ' +
        'Remove AUTH_ENABLED, then either configure OIDC (OIDC_ISSUER_URL, OIDC_CLIENT_ID, ' +
        'OIDC_REDIRECT_URI) or set AUTH_DISABLED=true to run without login on a trusted network.'
    );
  }

  const value = normalizedAuthDisabled();
  if (
    value !== undefined &&
    value !== '' &&
    !TRUTHY_VALUES.has(value) &&
    !FALSY_VALUES.has(value)
  ) {
    throw new Error(
      `AUTH_DISABLED is set to "${process.env.AUTH_DISABLED}", which is not a recognized value. ` +
        'Accepted values: true/1/yes/on to disable authentication, false/0/no/off (or unset) to require it.'
    );
  }

  if (isAuthDisabled()) {
    console.warn(
      '[Auth] AUTHENTICATION IS DISABLED (AUTH_DISABLED=true). Every request runs as a ' +
        'synthetic admin. Keep the dashboard on a trusted network.'
    );
    return;
  }

  try {
    loadAuthConfig();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Authentication is required by default but the OIDC configuration is not usable: ${reason}. ` +
        'Set AUTH_DISABLED=true to run without login on a trusted network.'
    );
  }
}

/**
 * Picks the session cookie name on read paths that hold no parsed AuthConfig.
 * Unlike loadAuthConfig(), this must never throw on incomplete OIDC env vars:
 * an unauthenticated request has to resolve to null, not a 500.
 */
export function isSecureCookie(): boolean {
  return process.env.OIDC_REDIRECT_URI?.startsWith('https://') ?? false;
}

export function loadAuthConfig(): AuthConfig {
  const issuerUrl = process.env.OIDC_ISSUER_URL;
  const clientId = process.env.OIDC_CLIENT_ID;
  const redirectUri = process.env.OIDC_REDIRECT_URI;

  if (!issuerUrl || !clientId || !redirectUri) {
    throw new Error(
      'OIDC configuration incomplete. Required: OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_REDIRECT_URI'
    );
  }

  const sessionTtlRaw = process.env.SESSION_TTL_HOURS ?? '8';
  if (!/^\d+$/.test(sessionTtlRaw)) {
    throw new Error('SESSION_TTL_HOURS must be a positive integer');
  }
  const sessionTtlHours = Number.parseInt(sessionTtlRaw, 10);
  if (!Number.isFinite(sessionTtlHours) || sessionTtlHours <= 0) {
    throw new Error('SESSION_TTL_HOURS must be a positive integer');
  }

  const roleMapping = {
    admin: (process.env.OIDC_ROLE_ADMIN ?? 'homelab-admins').trim(),
    operator: (process.env.OIDC_ROLE_OPERATOR ?? 'homelab-operators').trim(),
    viewer: (process.env.OIDC_ROLE_VIEWER ?? 'homelab-viewers').trim(),
  };
  if (!roleMapping.admin || !roleMapping.operator || !roleMapping.viewer) {
    throw new Error('OIDC_ROLE_ADMIN, OIDC_ROLE_OPERATOR, and OIDC_ROLE_VIEWER must be non-empty');
  }

  return {
    issuerUrl,
    clientId,
    redirectUri,
    sessionTtlHours,
    roleMapping,
  };
}
