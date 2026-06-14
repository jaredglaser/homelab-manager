import { describe, it, expect, mock, afterEach, beforeEach } from 'bun:test';
import { buildStateCookie } from '@/lib/auth/login-handler';

// Module mocks must be registered before importing the handler so its dynamic
// `await import()` calls receive the stubs.
const mockGetAuthorizationUrl = mock(
  async (_state: string, _nonce: string, _prompt?: string): Promise<string> => {
    return 'https://pocketid.example.com/authorize';
  },
);

const MockOidcClient = mock(function (_config: unknown) {
  return { getAuthorizationUrl: mockGetAuthorizationUrl };
});

mock.module('@/lib/auth/oidc-client', () => ({
  OidcClient: MockOidcClient,
}));

mock.module('@/lib/auth/oidc-secrets', () => ({
  getOidcClientSecret: mock(async () => 'test-secret'),
}));

// Import handler after mocks are registered
const { loginGetHandler } = await import('@/lib/auth/login-handler');

function makeRequest(url: string): Request {
  return new Request(url);
}

describe('buildStateCookie', () => {
  it('includes HttpOnly, SameSite=Lax, Path=/api/auth, Max-Age=600', () => {
    const cookie = buildStateCookie('state123', 'nonce456', false);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/auth');
    expect(cookie).toContain('Max-Age=600');
  });

  it('does not include Secure flag when isSecure=false', () => {
    const cookie = buildStateCookie('s', 'n', false);
    expect(cookie).not.toContain('Secure');
  });

  it('includes Secure flag when isSecure=true', () => {
    const cookie = buildStateCookie('s', 'n', true);
    expect(cookie).toContain('Secure');
  });

  it('encodes state and nonce as JSON in the cookie value', () => {
    const cookie = buildStateCookie('my-state', 'my-nonce', false);
    expect(cookie).toMatch(/^oidc_state=/);
    const match = cookie.match(/^oidc_state=([^;]+)/);
    expect(match).not.toBeNull();
    const parsed = JSON.parse(decodeURIComponent(match![1]));
    expect(parsed.state).toBe('my-state');
    expect(parsed.nonce).toBe('my-nonce');
  });
});

describe('loginGetHandler', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockGetAuthorizationUrl.mockClear();
    MockOidcClient.mockClear();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('redirects to / when auth is disabled', async () => {
    process.env.AUTH_DISABLED = 'true';
    const response = await loginGetHandler({ request: makeRequest('http://localhost/api/auth/login') });
    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('/');
  });

  it('redirects to /login?error=login_failed on unhandled error', async () => {
    delete process.env.AUTH_DISABLED;
    // Missing OIDC config causes loadAuthConfig to throw
    delete process.env.OIDC_ISSUER_URL;
    delete process.env.OIDC_CLIENT_ID;
    delete process.env.OIDC_REDIRECT_URI;
    const originalConsoleError = console.error;
    console.error = () => {};
    try {
      const response = await loginGetHandler({ request: makeRequest('http://localhost/api/auth/login') });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe('/login?error=login_failed');
    } finally {
      console.error = originalConsoleError;
    }
  });

  describe('with valid OIDC config', () => {
    const MOCK_AUTH_URL = 'https://pocketid.example.com/authorize?client_id=homelab-manager&state=abc&nonce=xyz';

    function setupEnv() {
      delete process.env.AUTH_DISABLED;
      process.env.OIDC_ISSUER_URL = 'https://pocketid.example.com';
      process.env.OIDC_CLIENT_ID = 'homelab-manager';
      process.env.OIDC_CLIENT_SECRET = 'test-secret';
      process.env.OIDC_REDIRECT_URI = 'http://localhost:3000/api/auth/callback';
    }

    beforeEach(() => {
      mockGetAuthorizationUrl.mockImplementation(async () => MOCK_AUTH_URL);
    });

    it('calls getAuthorizationUrl without prompt when prompt param is absent', async () => {
      setupEnv();
      await loginGetHandler({ request: makeRequest('http://localhost/api/auth/login') });
      expect(mockGetAuthorizationUrl).toHaveBeenCalledTimes(1);
      const [, , prompt] = mockGetAuthorizationUrl.mock.calls[0] as [string, string, string | undefined];
      expect(prompt).toBeUndefined();
    });

    it('forwards prompt=login to getAuthorizationUrl', async () => {
      setupEnv();
      await loginGetHandler({ request: makeRequest('http://localhost/api/auth/login?prompt=login') });
      expect(mockGetAuthorizationUrl).toHaveBeenCalledTimes(1);
      const [, , prompt] = mockGetAuthorizationUrl.mock.calls[0] as [string, string, string | undefined];
      expect(prompt).toBe('login');
    });

    it('sets Location header to the authorization URL returned by getAuthorizationUrl', async () => {
      setupEnv();
      const response = await loginGetHandler({ request: makeRequest('http://localhost/api/auth/login') });
      expect(response.status).toBe(302);
      expect(response.headers.get('Location')).toBe(MOCK_AUTH_URL);
    });

    it('passes unique state and nonce values to getAuthorizationUrl', async () => {
      setupEnv();
      await loginGetHandler({ request: makeRequest('http://localhost/api/auth/login') });
      expect(mockGetAuthorizationUrl).toHaveBeenCalledTimes(1);
      const [state, nonce] = mockGetAuthorizationUrl.mock.calls[0] as [string, string];
      // 32 random bytes encoded as hex = 64 chars
      expect(state).toHaveLength(64);
      expect(nonce).toHaveLength(64);
      expect(state).not.toBe(nonce);
    });
  });
});
