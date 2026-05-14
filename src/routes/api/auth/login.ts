import { createFileRoute } from '@tanstack/react-router';
import { randomBytes } from 'crypto';

export const Route = createFileRoute('/api/auth/login')({
  server: {
    handlers: {
      GET: async () => {
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
        const url = await oidc.getAuthorizationUrl(state, nonce);

        const isSecure = config.redirectUri.startsWith('https://');
        const secureFlag = isSecure ? '; Secure' : '';
        const stateCookie = `oidc_state=${encodeURIComponent(JSON.stringify({ state, nonce }))}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=600${secureFlag}`;

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
      },
    },
  },
});
