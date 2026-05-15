import { randomBytes } from 'crypto';

/**
 * Builds the oidc_state cookie value for the login flow.
 * The cookie is HttpOnly, SameSite=Lax, scoped to /api/auth, and expires after 10 minutes.
 * The Secure flag is included when the redirect URI is HTTPS.
 */
export function buildStateCookie(state: string, nonce: string, isSecure: boolean): string {
  const secureFlag = isSecure ? '; Secure' : '';
  return `oidc_state=${encodeURIComponent(JSON.stringify({ state, nonce }))}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=600${secureFlag}`;
}

export async function loginGetHandler({ request }: { request: Request }): Promise<Response> {
  try {
    const { isAuthDisabled, loadAuthConfig } = await import('@/lib/config/auth-config');
    if (isAuthDisabled()) {
      return new Response(null, { status: 302, headers: { Location: '/' } });
    }

    const config = loadAuthConfig();
    const { OidcClient } = await import('@/lib/auth/oidc-client');
    const { getOidcClientSecret } = await import('@/lib/auth/oidc-secrets');
    const clientSecret = await getOidcClientSecret();

    const oidc = new OidcClient({
      issuerUrl: config.issuerUrl,
      clientId: config.clientId,
      clientSecret,
      redirectUri: config.redirectUri,
    });

    const state = randomBytes(32).toString('hex');
    const nonce = randomBytes(32).toString('hex');
    const urlObj = new URL(request.url);
    const prompt = urlObj.searchParams.get('prompt') ?? undefined;
    const url = await oidc.getAuthorizationUrl(state, nonce, prompt);

    const isSecure = config.redirectUri.startsWith('https://');
    const stateCookie = buildStateCookie(state, nonce, isSecure);

    return new Response(null, {
      status: 302,
      headers: {
        Location: url,
        'Set-Cookie': stateCookie,
      },
    });
  } catch (err) {
    console.error('[auth/login] Unhandled error during login:', err);
    return new Response(null, {
      status: 302,
      headers: { Location: '/login?error=login_failed' },
    });
  }
}
