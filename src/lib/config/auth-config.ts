import type { AuthConfig } from '@/lib/auth/types';

export function isAuthDisabled(): boolean {
  return process.env.AUTH_ENABLED !== 'true';
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
