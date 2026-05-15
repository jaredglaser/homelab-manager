import { describe, it, expect, afterEach } from 'bun:test';
import { loadAuthConfig, isAuthDisabled } from '@/lib/config/auth-config';

describe('loadAuthConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when OIDC_ISSUER_URL is missing', () => {
    delete process.env.OIDC_ISSUER_URL;
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';

    expect(() => loadAuthConfig()).toThrow(
      'OIDC configuration incomplete. Required: OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_REDIRECT_URI'
    );
  });

  it('throws when OIDC_CLIENT_ID is missing', () => {
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    delete process.env.OIDC_CLIENT_ID;
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';

    expect(() => loadAuthConfig()).toThrow(
      'OIDC configuration incomplete. Required: OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_REDIRECT_URI'
    );
  });

  it('throws when OIDC_REDIRECT_URI is missing', () => {
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    delete process.env.OIDC_REDIRECT_URI;

    expect(() => loadAuthConfig()).toThrow(
      'OIDC configuration incomplete. Required: OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_REDIRECT_URI'
    );
  });

  it('returns correct config with all vars set', () => {
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    process.env.SESSION_TTL_HOURS = '12';
    process.env.OIDC_ROLE_ADMIN = 'my-admins';
    process.env.OIDC_ROLE_OPERATOR = 'my-operators';
    process.env.OIDC_ROLE_VIEWER = 'my-viewers';

    const config = loadAuthConfig();
    expect(config.issuerUrl).toBe('https://pocketid.example.com');
    expect(config.clientId).toBe('homelab-manager');
    expect(config.redirectUri).toBe('http://localhost:3000/api/auth/callback');
    expect(config.sessionTtlHours).toBe(12);
    expect(config.roleMapping.admin).toBe('my-admins');
    expect(config.roleMapping.operator).toBe('my-operators');
    expect(config.roleMapping.viewer).toBe('my-viewers');
  });

  it('throws when SESSION_TTL_HOURS is not a positive integer string', () => {
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    process.env.SESSION_TTL_HOURS = 'abc';

    expect(() => loadAuthConfig()).toThrow('SESSION_TTL_HOURS must be a positive integer');
  });

  it('throws when SESSION_TTL_HOURS is zero', () => {
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    process.env.SESSION_TTL_HOURS = '0';

    expect(() => loadAuthConfig()).toThrow('SESSION_TTL_HOURS must be a positive integer');
  });

  it('throws when OIDC_ROLE_ADMIN is set to whitespace only', () => {
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    process.env.OIDC_ROLE_ADMIN = '   ';

    expect(() => loadAuthConfig()).toThrow(
      'OIDC_ROLE_ADMIN, OIDC_ROLE_OPERATOR, and OIDC_ROLE_VIEWER must be non-empty'
    );
  });

  it('defaults SESSION_TTL_HOURS to 8 when not set', () => {
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    delete process.env.SESSION_TTL_HOURS;

    const config = loadAuthConfig();
    expect(config.sessionTtlHours).toBe(8);
  });

  it('defaults role mapping group names when not set', () => {
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    delete process.env.OIDC_ROLE_ADMIN;
    delete process.env.OIDC_ROLE_OPERATOR;
    delete process.env.OIDC_ROLE_VIEWER;

    const config = loadAuthConfig();
    expect(config.roleMapping.admin).toBe('homelab-admins');
    expect(config.roleMapping.operator).toBe('homelab-operators');
    expect(config.roleMapping.viewer).toBe('homelab-viewers');
  });
});

describe('isAuthDisabled', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns true when AUTH_ENABLED is not set', () => {
    delete process.env.AUTH_ENABLED;
    expect(isAuthDisabled()).toBe(true);
  });

  it('returns true when AUTH_ENABLED is "false"', () => {
    process.env.AUTH_ENABLED = 'false';
    expect(isAuthDisabled()).toBe(true);
  });

  it('returns true when AUTH_ENABLED is an empty string', () => {
    process.env.AUTH_ENABLED = '';
    expect(isAuthDisabled()).toBe(true);
  });

  it('returns false when AUTH_ENABLED is "true"', () => {
    process.env.AUTH_ENABLED = 'true';
    expect(isAuthDisabled()).toBe(false);
  });
});
