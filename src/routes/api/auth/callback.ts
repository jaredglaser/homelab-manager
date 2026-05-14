import { createFileRoute } from '@tanstack/react-router';
import type { OidcTokens, Role, RoleMappingConfig } from '@/lib/auth/types';
import type { UserRow } from '@/lib/database/repositories/user-repository';

export interface CallbackOidcClient {
  exchangeCode(code: string): Promise<OidcTokens>;
  getUserGroups(accessToken: string): Promise<string[]>;
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
  extractIdTokenClaims: (idToken: string) => Record<string, unknown>;
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
  // Validate state from cookie
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

  // Exchange code for tokens
  const tokens = await deps.oidcClient.exchangeCode(code);

  // Get groups from userinfo AND id_token claims (merge, deduplicate)
  const userinfoGroups = await deps.oidcClient.getUserGroups(tokens.accessToken);
  const idTokenClaims = deps.extractIdTokenClaims(tokens.idToken);

  // Issue 1: Validate nonce claim matches stored nonce
  if (idTokenClaims.nonce !== storedState.nonce) {
    return new Response('Nonce mismatch', { status: 400 });
  }

  // Issue 4: Validate required sub and email claims
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

  // Map groups to role
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

  // Extract user info from id_token
  const name = typeof idTokenClaims.name === 'string' ? idTokenClaims.name : null;

  // Upsert user
  const user = await deps.userRepo.upsertFromOidc({
    oidcSubject: subject,
    email,
    name,
    role,
    groups: allGroups,
  });

  // Create session
  const rawSessionToken = await deps.sessionManager.createSession(
    user.id,
    tokens,
    ipAddress,
    userAgent,
  );

  // Set cookies: session cookie + clear oidc_state cookie
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

export const Route = createFileRoute('/api/auth/callback')({
  server: {
    handlers: {
      GET: async ({ request }) => {
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

        // Issue 2: Correct Secure flag logic — set when using HTTPS
        const isSecure = config.redirectUri.startsWith('https://');

        return handleCallback(
          {
            oidcClient: oidc,
            extractIdTokenClaims: OidcClient.extractIdTokenClaims,
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
      },
    },
  },
});
