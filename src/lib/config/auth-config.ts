import type { AuthConfig } from '@/lib/auth/types';

export function isAuthDisabled(): boolean {
  return process.env.DISABLE_AUTH === 'true';
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

  return {
    issuerUrl,
    clientId,
    redirectUri,
    sessionTtlHours: Number(process.env.SESSION_TTL_HOURS) || 8,
    roleMapping: {
      admin: process.env.OIDC_ROLE_ADMIN ?? 'homelab-admins',
      operator: process.env.OIDC_ROLE_OPERATOR ?? 'homelab-operators',
      viewer: process.env.OIDC_ROLE_VIEWER ?? 'homelab-viewers',
    },
  };
}
