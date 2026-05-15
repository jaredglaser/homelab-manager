import type { OidcTokens } from '@/lib/auth/types';

export interface OidcConfig {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface OidcEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  endSessionEndpoint: string | null;
}

export class OidcClient {
  private endpoints: OidcEndpoints | null = null;
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

    const body = await response.json();
    const authEndpoint = body.authorization_endpoint;
    const tokenEndpoint = body.token_endpoint;
    const userinfoEndpoint = body.userinfo_endpoint;
    if (typeof authEndpoint !== 'string' || typeof tokenEndpoint !== 'string' || typeof userinfoEndpoint !== 'string') {
      throw new Error('OIDC discovery response missing required endpoints (authorization_endpoint, token_endpoint, userinfo_endpoint)');
    }
    const endSessionEndpoint = typeof body.end_session_endpoint === 'string' ? body.end_session_endpoint : null;
    this.endpoints = { authorizationEndpoint: authEndpoint, tokenEndpoint, userinfoEndpoint, endSessionEndpoint };
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

  /**
   * Returns the RP-initiated logout URL, or null if the provider does not advertise
   * end_session_endpoint in its discovery document. Passing idTokenHint lets the provider
   * identify the session to end without prompting the user to re-authenticate.
   */
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

    const body = await response.json();
    if (typeof body.access_token !== 'string' || typeof body.id_token !== 'string') {
      throw new Error('OIDC token response missing required fields (access_token, id_token)');
    }
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      idToken: body.id_token,
    };
  }

  async getUserGroups(accessToken: string): Promise<string[]> {
    const endpoints = await this.discoverEndpoints();

    const response = await this.fetchWithTimeout(endpoints.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      console.error(`[OidcClient] Userinfo endpoint returned HTTP ${response.status} — proceeding with empty groups`);
      return [];
    }

    const body = await response.json();
    return Array.isArray(body.groups) ? body.groups : [];
  }

  /** Decode JWT payload without verification (server already verified via token endpoint) */
  static extractIdTokenClaims(idToken: string): Record<string, unknown> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('Invalid ID token format');
    // JWT payloads are base64url-encoded (RFC 7519): replace - and _ then pad to 4-char boundary
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(atob(padded));
  }
}
