import { createRemoteJWKSet, customFetch, jwtVerify } from 'jose';
import { z } from 'zod';
import type { OidcTokens } from '@/lib/auth/types';

// These payloads come from the OIDC provider over the network, so validate them like any
// other untrusted input. Required fields must be strings; optional fields are parsed
// leniently (`.catch`) because providers vary in what they advertise and a malformed
// optional field should not fail discovery or token exchange.
const discoveryResponseSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  userinfo_endpoint: z.string(),
  jwks_uri: z.string(),
  end_session_endpoint: z.string().optional().catch(undefined),
  id_token_signing_alg_values_supported: z.array(z.string()).optional().catch(undefined),
});

const tokenResponseSchema = z.object({
  access_token: z.string(),
  id_token: z.string(),
  refresh_token: z.string().optional().catch(undefined),
});

const userinfoResponseSchema = z
  .object({
    groups: z.array(z.string()).catch([]),
  })
  .catch({ groups: [] });

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface OidcEndpoints {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  jwksUri: string;
  endSessionEndpoint: string | null;
  idTokenSigningAlgs: string[];
}

export class OidcClient {
  private endpoints: OidcEndpoints | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private readonly fetchFn: typeof fetch;

  constructor(
    private readonly config: OidcConfig,
    fetchFn: typeof fetch = globalThis.fetch,
  ) {
    this.fetchFn = fetchFn;
  }

  private async fetchWithTimeout(
    input: string,
    init?: RequestInit,
    timeoutMs = 10_000,
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchFn(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async discoverEndpoints(): Promise<OidcEndpoints> {
    if (this.endpoints) return this.endpoints;

    const url = `${this.config.issuerUrl}/.well-known/openid-configuration`;
    const response = await this.fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`OIDC discovery failed (HTTP ${response.status})`);
    }

    const parsed = discoveryResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error('OIDC discovery response missing required fields (issuer, authorization_endpoint, token_endpoint, userinfo_endpoint, jwks_uri)');
    }
    const body = parsed.data;
    // 'none' is never acceptable for ID tokens; RS256 is the OIDC Core default when the
    // provider does not advertise id_token_signing_alg_values_supported.
    const advertisedAlgs = (body.id_token_signing_alg_values_supported ?? []).filter(
      (alg) => alg !== 'none',
    );
    const idTokenSigningAlgs = advertisedAlgs.length > 0 ? advertisedAlgs : ['RS256'];
    this.endpoints = {
      issuer: body.issuer,
      authorizationEndpoint: body.authorization_endpoint,
      tokenEndpoint: body.token_endpoint,
      userinfoEndpoint: body.userinfo_endpoint,
      jwksUri: body.jwks_uri,
      endSessionEndpoint: body.end_session_endpoint ?? null,
      idTokenSigningAlgs,
    };
    return this.endpoints;
  }

  async getAuthorizationUrl(state: string, nonce: string, prompt?: string): Promise<string> {
    const endpoints = await this.discoverEndpoints();
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: 'openid profile email groups',
      state,
      nonce,
    });
    if (prompt) params.set('prompt', prompt);
    return `${endpoints.authorizationEndpoint}?${params.toString()}`;
  }

  /** Returns the RP-initiated logout URL, or null if the provider has no end_session_endpoint. */
  async getLogoutUrl(postLogoutRedirectUri: string, idTokenHint?: string): Promise<string | null> {
    const endpoints = await this.discoverEndpoints();
    if (!endpoints.endSessionEndpoint) return null;
    const params = new URLSearchParams({ post_logout_redirect_uri: postLogoutRedirectUri });
    if (idTokenHint) params.set('id_token_hint', idTokenHint);
    return `${endpoints.endSessionEndpoint}?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<OidcTokens> {
    const endpoints = await this.discoverEndpoints();

    const response = await this.fetchWithTimeout(endpoints.tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        code,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`OIDC token exchange failed (HTTP ${response.status}): ${body}`);
    }

    const parsed = tokenResponseSchema.safeParse(await response.json());
    if (!parsed.success) {
      throw new Error('OIDC token response missing required fields (access_token, id_token)');
    }
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? null,
      idToken: parsed.data.id_token,
    };
  }

  async getUserGroups(accessToken: string): Promise<string[]> {
    const endpoints = await this.discoverEndpoints();

    const response = await this.fetchWithTimeout(endpoints.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new Error(`Userinfo endpoint returned HTTP ${response.status}`);
    }

    return userinfoResponseSchema.parse(await response.json()).groups;
  }

  /**
   * Verifies the ID token signature against the provider's JWKS and returns its claims.
   * Pins issuer, audience (client_id), and the signing algorithms advertised in the
   * discovery document, so the nonce check downstream binds to an authenticated document.
   * The remote JWK set is cached per client instance; jose handles refresh on key rotation.
   */
  async verifyIdToken(idToken: string): Promise<Record<string, unknown>> {
    const endpoints = await this.discoverEndpoints();
    this.jwks ??= createRemoteJWKSet(new URL(endpoints.jwksUri), {
      [customFetch]: this.fetchFn,
    });
    const { payload } = await jwtVerify(idToken, this.jwks, {
      issuer: endpoints.issuer,
      audience: this.config.clientId,
      algorithms: endpoints.idTokenSigningAlgs,
    });
    return payload;
  }
}
