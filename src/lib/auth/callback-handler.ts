import type { OidcTokens, Role, RoleMappingConfig } from '@/lib/auth/types';
import type { UserRow } from '@/lib/database/repositories/user-repository';

export interface CallbackOidcClient {
  exchangeCode(code: string): Promise<OidcTokens>;
  getUserGroups(accessToken: string): Promise<string[]>;
  verifyIdToken(idToken: string): Promise<Record<string, unknown>>;
}

export interface CallbackUserRepo {
  upsertFromOidc(input: {
    oidcSubject: string;
    email: string;
    name: string | null;
    role: string;
    groups: string[];
  }): Promise<UserRow>;
}

export interface CallbackSessionManager {
  createSession(
    userId: number,
    tokens: OidcTokens,
    ipAddress: string | null,
    userAgent: string | null,
  ): Promise<string>;
}

export interface CallbackHandlerDeps {
  oidcClient: CallbackOidcClient;
  mapGroupsToRole: (groups: string[], mapping: RoleMappingConfig) => Role | null;
  userRepo: CallbackUserRepo;
  sessionManager: CallbackSessionManager;
  roleMapping: RoleMappingConfig;
  isSecure: boolean;
}

export function buildSessionCookie(rawToken: string, isSecure: boolean): string {
  const securePart = isSecure ? ' Secure;' : '';
  return `session=${encodeURIComponent(rawToken)}; HttpOnly;${securePart} SameSite=Lax; Path=/`;
}

export const CLEAR_STATE_COOKIE =
  'oidc_state=; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=0';

export async function handleCallback(
  deps: CallbackHandlerDeps,
  code: string,
  state: string,
  cookieHeader: string,
  ipAddress: string | null,
  userAgent: string | null,
): Promise<Response> {
  const stateMatch = cookieHeader.match(/(?:^|;\s*)oidc_state=([^;]*)/);
  if (!stateMatch) {
    return new Response('Missing state cookie', { status: 400 });
  }

  let storedState: { state: string; nonce: string };
  try {
    storedState = JSON.parse(decodeURIComponent(stateMatch[1]));
  } catch {
    return new Response('Invalid state cookie', { status: 400 });
  }

  if (state !== storedState.state) {
    return new Response('State mismatch', { status: 400 });
  }

  const tokens = await deps.oidcClient.exchangeCode(code);

  // Providers vary on whether groups appear in userinfo or id_token; merge both.
  const userinfoGroups = await deps.oidcClient.getUserGroups(tokens.accessToken);

  // Signature verification (issuer, audience, alg pinned to the discovery document)
  // must happen before the nonce check, otherwise the nonce binds to a forgeable payload.
  let idTokenClaims: Record<string, unknown>;
  try {
    idTokenClaims = await deps.oidcClient.verifyIdToken(tokens.idToken);
  } catch (err) {
    console.error('[auth/callback] ID token verification failed:', err);
    return new Response('ID token verification failed', { status: 401 });
  }

  if (idTokenClaims.nonce !== storedState.nonce) {
    return new Response('Nonce mismatch', { status: 400 });
  }

  const subject = idTokenClaims.sub;
  if (typeof subject !== 'string' || !subject) {
    return new Response('ID token missing required "sub" claim', { status: 400 });
  }
  const email = idTokenClaims.email;
  if (typeof email !== 'string' || !email) {
    return new Response('ID token missing required "email" claim', { status: 400 });
  }

  const idTokenGroups = Array.isArray(idTokenClaims.groups)
    ? (idTokenClaims.groups as string[])
    : [];
  const allGroups = [...new Set([...userinfoGroups, ...idTokenGroups])];

  const role = deps.mapGroupsToRole(allGroups, deps.roleMapping);

  if (!role) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: '/denied',
        'Set-Cookie': CLEAR_STATE_COOKIE,
      },
    });
  }

  const name = typeof idTokenClaims.name === 'string' ? idTokenClaims.name : null;

  const user = await deps.userRepo.upsertFromOidc({
    oidcSubject: subject,
    email,
    name,
    role,
    groups: allGroups,
  });

  const rawSessionToken = await deps.sessionManager.createSession(
    user.id,
    tokens,
    ipAddress,
    userAgent,
  );

  const sessionCookie = buildSessionCookie(rawSessionToken, deps.isSecure);

  return new Response(null, {
    status: 302,
    headers: [
      ['Location', '/'],
      ['Set-Cookie', sessionCookie],
      ['Set-Cookie', CLEAR_STATE_COOKIE],
    ],
  });
}

export async function callbackGetHandler({
  request,
}: {
  request: Request;
}): Promise<Response> {
  try {
    const { isAuthDisabled, loadAuthConfig } = await import('@/lib/config/auth-config');
    if (isAuthDisabled()) {
      return new Response(null, { status: 302, headers: { Location: '/' } });
    }

    const url = new URL(request.url);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');

    if (!code || !state) {
      return new Response('Missing code or state', { status: 400 });
    }

    const config = loadAuthConfig();
    const { OidcClient } = await import('@/lib/auth/oidc-client');
    const { getOidcClientSecret } = await import('@/lib/auth/oidc-secrets');
    const { mapGroupsToRole } = await import('@/lib/auth/role-mapper');
    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { UserRepository } = await import('@/lib/database/repositories/user-repository');
    const { buildSessionManager } = await import('@/lib/auth/session-manager');

    const clientSecret = await getOidcClientSecret();

    const oidc = new OidcClient({
      issuerUrl: config.issuerUrl,
      clientId: config.clientId,
      clientSecret,
      redirectUri: config.redirectUri,
    });

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const userRepo = new UserRepository(dbClient.getPool());
    const sessionManager = await buildSessionManager();

    const cookieHeader = request.headers.get('cookie') ?? '';
    const ipAddress =
      request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
    const userAgent = request.headers.get('user-agent') ?? null;

    const isSecure = config.redirectUri.startsWith('https://');

    return handleCallback(
      {
        oidcClient: oidc,
        mapGroupsToRole,
        userRepo,
        sessionManager,
        roleMapping: config.roleMapping,
        isSecure,
      },
      code,
      state,
      cookieHeader,
      ipAddress,
      userAgent,
    );
  } catch (err) {
    console.error('[auth/callback] Unhandled error during callback:', err);
    return new Response(null, {
      status: 302,
      headers: { Location: '/login?error=callback_failed' },
    });
  }
}
