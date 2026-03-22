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

  async discoverEndpoints(): Promise<OidcEndpoints> {
    if (this.endpoints) return this.endpoints;

    const url = `${this.config.issuerUrl}/.well-known/openid-configuration`;
    const response = await this.fetchFn(url);
    if (!response.ok) {
      throw new Error(`OIDC discovery failed (HTTP ${response.status})`);
    }

    const body = await response.json();
    this.endpoints = {
      authorizationEndpoint: body.authorization_endpoint,
      tokenEndpoint: body.token_endpoint,
      userinfoEndpoint: body.userinfo_endpoint,
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

  async exchangeCode(code: string): Promise<OidcTokens> {
    const endpoints = await this.discoverEndpoints();

    const response = await this.fetchFn(endpoints.tokenEndpoint, {
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
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token ?? null,
      idToken: body.id_token,
    };
  }

  async getUserGroups(accessToken: string): Promise<string[]> {
    const endpoints = await this.discoverEndpoints();

    const response = await this.fetchFn(endpoints.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) return [];

    const body = await response.json();
    return Array.isArray(body.groups) ? body.groups : [];
  }

  /** Decode JWT payload without verification (server already verified via token endpoint) */
  static extractIdTokenClaims(idToken: string): Record<string, unknown> {
    const parts = idToken.split('.');
    if (parts.length !== 3) throw new Error('Invalid ID token format');
    return JSON.parse(atob(parts[1]));
  }
}
