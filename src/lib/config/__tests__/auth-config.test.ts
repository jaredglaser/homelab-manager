import { describe, it, expect, afterEach, beforeEach, spyOn } from 'bun:test';
import { loadAuthConfig, isAuthDisabled, enforceAuthConfig } from '@/lib/config/auth-config';

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

  it('returns false when AUTH_DISABLED is not set (auth required by default)', () => {
    delete process.env.AUTH_DISABLED;
    expect(isAuthDisabled()).toBe(false);
  });

  it.each(['true', '1', 'YES', ' on '])(
    'returns true for truthy value %p (case-insensitive, trimmed)',
    (value) => {
      process.env.AUTH_DISABLED = value;
      expect(isAuthDisabled()).toBe(true);
    },
  );

  it.each(['false', '0', 'no', 'off', ''])('returns false for falsy value %p', (value) => {
    process.env.AUTH_DISABLED = value;
    expect(isAuthDisabled()).toBe(false);
  });

  it('returns false for an unrecognized value (fails closed)', () => {
    process.env.AUTH_DISABLED = 'definitely';
    expect(isAuthDisabled()).toBe(false);
  });
});

describe('enforceAuthConfig', () => {
  const originalEnv = { ...process.env };
  let warnSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    delete process.env.AUTH_ENABLED;
    delete process.env.AUTH_DISABLED;
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_REDIRECT_URI;
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env = { ...originalEnv };
  });

  it('throws when the removed AUTH_ENABLED variable is set (any value)', () => {
    process.env.AUTH_ENABLED = 'false';
    expect(() => enforceAuthConfig()).toThrow(/AUTH_ENABLED was replaced by AUTH_DISABLED/);
  });

  it('throws on an unrecognized AUTH_DISABLED value, naming it and the accepted values', () => {
    process.env.AUTH_DISABLED = 'truee';
    expect(() => enforceAuthConfig()).toThrow(/"truee".*true\/1\/yes\/on.*false\/0\/no\/off/s);
  });

  it('warns without throwing when auth is disabled', () => {
    process.env.AUTH_DISABLED = 'true';
    expect(() => enforceAuthConfig()).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('AUTHENTICATION IS DISABLED');
  });

  it('passes without warning when auth is required and OIDC config is complete', () => {
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
    process.env.OIDC_CLIENT_ID = 'homelab-manager';
    process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';

    expect(() => enforceAuthConfig()).not.toThrow();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('throws with the AUTH_DISABLED hint when auth is required but OIDC config is incomplete', () => {
    process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';

    expect(() => enforceAuthConfig()).toThrow(
      /Authentication is required by default.*OIDC configuration incomplete.*Set AUTH_DISABLED=true/s,
    );
  });
});
