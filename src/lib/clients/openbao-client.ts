import type { OpenBaoConfig } from '@/lib/config/openbao-config';

/**
 * Thin wrapper around OpenBao HTTP API (KV v2 secrets engine).
 * Uses native fetch() — no SDK dependency.
 *
 * Secret path convention: secret/stacks/<stack-name>/<key>
 */
export class OpenBaoClient {
  private static readonly SAFE_PATH_SEGMENT = /^[a-zA-Z0-9_-]+$/;

  private readonly url: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: OpenBaoConfig, fetchFn: typeof fetch = globalThis.fetch) {
    this.url = config.url;
    this.token = config.token;
    this.fetchFn = fetchFn;
  }

  /**
   * Validate that a path segment (stack name or key) contains only safe characters.
   * Prevents path traversal and injection attacks in OpenBao API URLs.
   */
  private validatePathSegment(value: string, label: string): void {
    if (!OpenBaoClient.SAFE_PATH_SEGMENT.test(value)) {
      throw new Error(
        `Invalid ${label}: "${value}" — must match ^[a-zA-Z0-9_-]+$`,
      );
    }
  }

  /**
   * List secret key names for a stack. Returns names only, never values.
   */
  async listSecrets(stack: string): Promise<string[]> {
    this.validatePathSegment(stack, 'stack');
    const response = await this.fetchFn(
      `${this.url}/v1/secret/metadata/stacks/${stack}`,
      {
        method: 'LIST',
        headers: { 'X-Vault-Token': this.token },
      },
    );

    if (response.status === 404) {
      return [];
    }

    if (!response.ok) {
      throw new Error(`OpenBao API error: ${response.status}`);
    }

    const body = await response.json();
    return body.data.keys as string[];
  }

  /**
   * Get a single secret value. Returns null if not found.
   */
  async getSecret(stack: string, key: string): Promise<string | null> {
    this.validatePathSegment(stack, 'stack');
    this.validatePathSegment(key, 'key');

    const response = await this.fetchFn(
      `${this.url}/v1/secret/data/stacks/${stack}/${key}`,
      {
        method: 'GET',
        headers: { 'X-Vault-Token': this.token },
      },
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`OpenBao API error: ${response.status}`);
    }

    const body = await response.json();
    return body.data.data.value as string;
  }

  /**
   * Set or update a secret value.
   */
  async setSecret(stack: string, key: string, value: string): Promise<void> {
    this.validatePathSegment(stack, 'stack');
    this.validatePathSegment(key, 'key');

    const response = await this.fetchFn(
      `${this.url}/v1/secret/data/stacks/${stack}/${key}`,
      {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: { value } }),
      },
    );

    if (!response.ok) {
      throw new Error(`OpenBao API error: ${response.status}`);
    }
  }

  /**
   * Delete a secret (metadata and all versions).
   * Does not throw if the secret does not exist.
   */
  async deleteSecret(stack: string, key: string): Promise<void> {
    this.validatePathSegment(stack, 'stack');
    this.validatePathSegment(key, 'key');

    const response = await this.fetchFn(
      `${this.url}/v1/secret/metadata/stacks/${stack}/${key}`,
      {
        method: 'DELETE',
        headers: { 'X-Vault-Token': this.token },
      },
    );

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      throw new Error(`OpenBao API error: ${response.status}`);
    }
  }

  /**
   * Get all secret key-value pairs for a stack.
   * Used by the deploy pipeline to build .env files.
   *
   * NOTE: This makes N+1 HTTP calls (1 LIST + N GETs). Per-key storage is
   * simpler for the reveal-single-secret UX but costs N+1 calls. For v1 with
   * small numbers of secrets this is acceptable. Could be optimized to
   * single-path-per-stack in v2 if needed.
   *
   * Uses Promise.allSettled so individual secret fetch failures don't block
   * the entire operation. Failed fetches are logged and skipped.
   */
  async getAllSecrets(stack: string): Promise<Record<string, string>> {
    const keys = await this.listSecrets(stack);
    if (keys.length === 0) {
      return {};
    }

    const results = await Promise.allSettled(
      keys.map(async (key) => {
        const value = await this.getSecret(stack, key);
        return value !== null ? ([key, value] as const) : null;
      }),
    );

    const entries: (readonly [string, string])[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        entries.push(result.value);
      } else if (result.status === 'rejected') {
        console.error(
          `Failed to fetch secret in stack "${stack}":`,
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        );
      }
    }

    return Object.fromEntries(entries);
  }

  /**
   * Ensure the KV v2 secrets engine is enabled at the `secret/` path.
   * Safe to call multiple times — checks existing mounts first.
   */
  async ensureSecretsEngine(): Promise<void> {
    const mountsResponse = await this.fetchFn(
      `${this.url}/v1/sys/mounts`,
      {
        method: 'GET',
        headers: { 'X-Vault-Token': this.token },
      },
    );

    if (!mountsResponse.ok) {
      throw new Error(`OpenBao API error: ${mountsResponse.status}`);
    }

    const mounts = await mountsResponse.json();
    if (mounts['secret/']) {
      return;
    }

    const enableResponse = await this.fetchFn(
      `${this.url}/v1/sys/mounts/secret`,
      {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          type: 'kv',
          options: { version: '2' },
        }),
      },
    );

    if (!enableResponse.ok) {
      throw new Error(`OpenBao API error: ${enableResponse.status}`);
    }
  }
}
