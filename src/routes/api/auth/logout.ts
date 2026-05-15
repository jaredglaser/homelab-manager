import { createFileRoute } from '@tanstack/react-router';
import { createHash } from 'crypto';

export const Route = createFileRoute('/api/auth/logout')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { isAuthDisabled, loadAuthConfig } = await import('@/lib/config/auth-config');
        let isSecure = false;
        let oidcLogoutUrl: string | null = null;

        if (!isAuthDisabled()) {
          const config = loadAuthConfig();
          isSecure = config.redirectUri.startsWith('https://');

          // Extract session, delete from DB
          const cookieHeader = request.headers.get('cookie') ?? '';
          const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
          const token = match ? decodeURIComponent(match[1]) : null;

          if (token) {
            try {
              const hashedId = createHash('sha256').update(token).digest('hex');
              const { buildSessionManager } = await import('@/lib/auth/session-manager');
              const sessionManager = await buildSessionManager();
              // Retrieve id_token before revoking — needed as id_token_hint for RP-initiated logout
              // so the OIDC provider can identify which session to end without re-prompting the user.
              const idToken = await sessionManager.getIdToken(hashedId);
              await sessionManager.revokeSession(hashedId);

              try {
                const { OidcClient } = await import('@/lib/auth/oidc-client');
                const { getOidcClientSecret } = await import('@/lib/auth/oidc-secrets');
                const clientSecret = await getOidcClientSecret();
                const oidc = new OidcClient({
                  issuerUrl: config.issuerUrl,
                  clientId: config.clientId,
                  clientSecret,
                  redirectUri: config.redirectUri,
                });
                const baseUrl = new URL(config.redirectUri).origin;
                oidcLogoutUrl = await oidc.getLogoutUrl(`${baseUrl}/login`, idToken ?? undefined);
              } catch (err) {
                console.error('[auth/logout] Failed to build OIDC logout URL:', err);
              }
            } catch (err) {
              console.error('[auth/logout] Failed to revoke session:', err);
            }
          }
        }

        const securePart = isSecure ? ' Secure;' : '';
        const clearCookie = `session=; HttpOnly;${securePart} SameSite=Lax; Path=/; Max-Age=0`;
        // Fall back to local login page with prompt=login if provider has no end_session_endpoint
        const redirectTo = oidcLogoutUrl ?? '/login?prompt=login';

        return new Response(null, {
          status: 302,
          headers: {
            Location: redirectTo,
            'Set-Cookie': clearCookie,
          },
        });
      },
    },
  },
});
