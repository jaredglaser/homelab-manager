import { createHash } from 'node:crypto';

/** Builds the Set-Cookie header value that clears the session cookie. */
export function buildClearSessionCookie(isSecure: boolean): string {
  const securePart = isSecure ? ' Secure;' : '';
  return `session=; HttpOnly;${securePart} SameSite=Lax; Path=/; Max-Age=0`;
}

export interface LogoutHandlerDeps {
  /**
   * Returns the OIDC provider logout URL, or null if end_session_endpoint is absent.
   * The base URL (`origin/login`) is pre-computed by the caller so this function
   * doesn't need to know about the auth config.
   */
  getOidcLogoutUrl(postLogoutRedirectUri: string, idTokenHint?: string): Promise<string | null>;
  sessionManager: {
    getIdToken(hashedId: string): Promise<string | null>;
    revokeSession(hashedId: string): Promise<void>;
  };
  /** Post-logout redirect URI base (origin + /login). */
  postLogoutRedirectUri: string;
  isSecure: boolean;
}

/**
 * Core logout logic: revokes the session, fetches the OIDC logout URL, and returns
 * the redirect response. Accepts explicit params so it can be tested without
 * relying on the Fetch API's cookie header (which Happy-DOM blocks as a forbidden header).
 *
 * @param deps - Injected dependencies
 * @param token - Raw session token from the cookie, or null if absent
 */
export async function handleLogout(
  deps: LogoutHandlerDeps,
  token: string | null,
): Promise<Response> {
  let oidcLogoutUrl: string | null = null;

  if (!token) {
    console.info('[auth/logout] Logout requested without an active session cookie');
  } else {
    try {
      const hashedId = createHash('sha256').update(token).digest('hex');
      // Fetch id_token before revoking: needed as id_token_hint for RP-initiated logout.
      const idToken = await deps.sessionManager.getIdToken(hashedId);
      await deps.sessionManager.revokeSession(hashedId);

      try {
        oidcLogoutUrl = await deps.getOidcLogoutUrl(
          deps.postLogoutRedirectUri,
          idToken ?? undefined,
        );
      } catch (err) {
        console.error('[auth/logout] Failed to build OIDC logout URL:', err);
      }
    } catch (err) {
      console.error(
        '[auth/logout] Session revocation failed (entry may remain active until TTL):',
        err,
      );
    }
  }

  const clearCookie = buildClearSessionCookie(deps.isSecure);
  // prompt=login forces re-auth when the provider still holds a valid browser session.
  const redirectTo = oidcLogoutUrl ?? '/login?prompt=login';

  return new Response(null, {
    status: 302,
    headers: {
      Location: redirectTo,
      'Set-Cookie': clearCookie,
    },
  });
}

export async function logoutWithCookie(cookieHeader: string): Promise<Response> {
  const { isAuthDisabled, loadAuthConfig } = await import('@/lib/config/auth-config');

  if (isAuthDisabled()) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/login?prompt=login',
        'Set-Cookie': buildClearSessionCookie(false),
      },
    });
  }

  const config = loadAuthConfig();
  const isSecure = config.redirectUri.startsWith('https://');
  const postLogoutRedirectUri = `${new URL(config.redirectUri).origin}/login`;

  const match = cookieHeader.match(/(?:^|;\s*)session=([^;]*)/);
  const token = match ? decodeURIComponent(match[1]) : null;

  // Build session manager lazily: only connect to the DB when there's an active session to revoke.
  const getSessionManager = async () => {
    const { buildSessionManager } = await import('@/lib/auth/session-manager');
    return buildSessionManager();
  };

  const sessionManager = {
    getIdToken: async (hashedId: string) => (await getSessionManager()).getIdToken(hashedId),
    revokeSession: async (hashedId: string) => (await getSessionManager()).revokeSession(hashedId),
  };

  const getOidcLogoutUrl = async (
    postLogoutUri: string,
    idTokenHint?: string,
  ): Promise<string | null> => {
    const { OidcClient } = await import('@/lib/auth/oidc-client');
    const { getOidcClientSecret } = await import('@/lib/auth/oidc-secrets');
    const clientSecret = await getOidcClientSecret();
    const oidc = new OidcClient({
      issuerUrl: config.issuerUrl,
      clientId: config.clientId,
      clientSecret,
      redirectUri: config.redirectUri,
    });
    return oidc.getLogoutUrl(postLogoutUri, idTokenHint);
  };

  return handleLogout({ getOidcLogoutUrl, sessionManager, isSecure, postLogoutRedirectUri }, token);
}

export async function logoutGetHandler({ request }: { request: Request }): Promise<Response> {
  return logoutWithCookie(request.headers.get('cookie') ?? '');
}
