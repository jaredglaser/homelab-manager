export const ROLE_VALUES = ['admin', 'operator', 'viewer'] as const;
export type Role = (typeof ROLE_VALUES)[number];

/** Narrows a persisted role, so a value the union does not know is caught at the row. */
export function isRole(value: unknown): value is Role {
  return typeof value === 'string' && (ROLE_VALUES as readonly string[]).includes(value);
}

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  role: Role;
}

export interface OidcTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string;
}

export type RoleMappingConfig = Record<Role, string>;

export interface AuthConfig {
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  sessionTtlHours: number;
  roleMapping: RoleMappingConfig;
}

/** Synthetic admin user injected when auth is disabled */
export const SYNTHETIC_ADMIN: AuthUser = {
  id: 0,
  email: 'admin@local',
  name: 'Admin',
  role: 'admin',
};
