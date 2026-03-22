export type Role = 'admin' | 'operator' | 'viewer';

export interface AuthUser {
  id: number;
  email: string;
  name: string | null;
  role: Role;
}

export interface SessionData {
  id: string;
  userId: number;
  encryptedOidc: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface OidcTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string;
}

export interface RoleMappingConfig {
  admin: string;
  operator: string;
  viewer: string;
}

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
