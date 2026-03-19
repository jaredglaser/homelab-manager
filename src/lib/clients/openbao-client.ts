import type { OpenBaoConfig } from '@/lib/config/openbao-config';
import { SAFE_PATH_SEGMENT_PATTERN } from '@/lib/constants/openbao';

/**
 * Thin wrapper around OpenBao HTTP API (KV v2 secrets engine).
 * Uses native fetch() — no SDK dependency.
 *
 * Secret path convention: secret/stacks/<stack-name>/<key>
 */
export class OpenBaoClient {
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
    if (!SAFE_PATH_SEGMENT_PATTERN.test(value)) {
      throw new Error(
        `Invalid ${label}: must contain only letters, numbers, hyphens, and underscores`,
      );
    }
  }

  /**
   * Make a fetch request to OpenBao, wrapping network errors with context.
   */
  private async request(
    url: string,
    init: RequestInit,
    operation: string,
    context: string,
  ): Promise<Response> {
    try {
      return await this.fetchFn(url, init);
    } catch (error) {
      throw new Error(
        `OpenBao ${operation} failed for ${context}: could not connect to ${this.url}`,
        { cause: error },
      );
    }
  }

  /**
   * Parse a JSON response body, wrapping parse failures with OpenBao context.
   * Proxies or load balancers may return HTML with a 200 status — this ensures
   * the error is actionable instead of a raw SyntaxError.
   */
  private async parseJsonResponse(
    response: Response,
    operation: string,
    context: string,
  ): Promise<unknown> {
    try {
      return await response.json();
    } catch (error) {
      throw new Error(
        `OpenBao ${operation} failed for ${context}: response body is not valid JSON`,
        { cause: error },
      );
    }
  }

  /**
   * Read and throw an error from a non-OK OpenBao response.
   * Includes the operation, context, status code, and any error details from the response body.
   */
  private async throwApiError(
    response: Response,
    operation: string,
    context: string,
  ): Promise<never> {
    let detail = '';
    try {
      const body = await response.json();
      if (body.errors) detail = `: ${(body.errors as string[]).join(', ')}`;
    } catch {
      // Response body not JSON — ignore
    }
    throw new Error(
      `OpenBao ${operation} failed for ${context} (HTTP ${response.status})${detail}`,
    );
  }

  /**
   * List secret key names for a stack. Returns names only, never values.
   */
  async listSecrets(stack: string): Promise<string[]> {
    this.validatePathSegment(stack, 'stack');
    const response = await this.request(
      `${this.url}/v1/secret/metadata/stacks/${stack}`,
      {
        method: 'LIST',
        headers: { 'X-Vault-Token': this.token },
      },
      'LIST',
      `stack "${stack}"`,
    );

    if (response.status === 404) {
      return [];
    }

    if (!response.ok) {
      await this.throwApiError(response, 'LIST', `stack "${stack}"`);
    }

    const body = await this.parseJsonResponse(response, 'LIST', `stack "${stack}"`) as
      { data?: { keys?: unknown } } | undefined;
    const keys = body?.data?.keys;
    if (!Array.isArray(keys)) {
      throw new Error(
        `OpenBao LIST failed for stack "${stack}": unexpected response shape`,
      );
    }
    return keys as string[];
  }

  /**
   * Get a single secret value. Returns null if not found.
   */
  async getSecret(stack: string, key: string): Promise<string | null> {
    this.validatePathSegment(stack, 'stack');
    this.validatePathSegment(key, 'key');

    const response = await this.request(
      `${this.url}/v1/secret/data/stacks/${stack}/${key}`,
      {
        method: 'GET',
        headers: { 'X-Vault-Token': this.token },
      },
      'GET',
      `stack "${stack}" key "${key}"`,
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      await this.throwApiError(response, 'GET', `stack "${stack}" key "${key}"`);
    }

    const body = await this.parseJsonResponse(response, 'GET', `stack "${stack}" key "${key}"`) as
      { data?: { data?: { value?: unknown } } } | undefined;
    const value = body?.data?.data?.value;
    if (typeof value !== 'string') {
      throw new Error(
        `OpenBao GET failed for stack "${stack}" key "${key}": unexpected response shape`,
      );
    }
    return value;
  }

  /**
   * Set or update a secret value.
   */
  async setSecret(stack: string, key: string, value: string): Promise<void> {
    this.validatePathSegment(stack, 'stack');
    this.validatePathSegment(key, 'key');

    const response = await this.request(
      `${this.url}/v1/secret/data/stacks/${stack}/${key}`,
      {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: { value } }),
      },
      'SET',
      `stack "${stack}" key "${key}"`,
    );

    if (!response.ok) {
      await this.throwApiError(response, 'SET', `stack "${stack}" key "${key}"`);
    }
  }

  /**
   * Delete a secret (metadata and all versions).
   * Does not throw if the secret does not exist.
   */
  async deleteSecret(stack: string, key: string): Promise<void> {
    this.validatePathSegment(stack, 'stack');
    this.validatePathSegment(key, 'key');

    const response = await this.request(
      `${this.url}/v1/secret/metadata/stacks/${stack}/${key}`,
      {
        method: 'DELETE',
        headers: { 'X-Vault-Token': this.token },
      },
      'DELETE',
      `stack "${stack}" key "${key}"`,
    );

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      await this.throwApiError(response, 'DELETE', `stack "${stack}" key "${key}"`);
    }
  }

  /**
   * Get a single host secret value. Returns null if not found.
   */
  async getHostSecret(hostname: string, key: string): Promise<string | null> {
    this.validatePathSegment(hostname, 'hostname');
    this.validatePathSegment(key, 'key');

    const response = await this.request(
      `${this.url}/v1/secret/data/hosts/${hostname}/${key}`,
      {
        method: 'GET',
        headers: { 'X-Vault-Token': this.token },
      },
      'GET_HOST',
      `host "${hostname}" key "${key}"`,
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      await this.throwApiError(response, 'GET_HOST', `host "${hostname}" key "${key}"`);
    }

    const body = await this.parseJsonResponse(response, 'GET_HOST', `host "${hostname}" key "${key}"`) as
      { data?: { data?: { value?: unknown } } } | undefined;
    const value = body?.data?.data?.value;
    if (typeof value !== 'string') {
      throw new Error(
        `OpenBao GET_HOST failed for host "${hostname}" key "${key}": unexpected response shape`,
      );
    }
    return value;
  }

  /**
   * Set or update a host secret value.
   */
  async setHostSecret(hostname: string, key: string, value: string): Promise<void> {
    this.validatePathSegment(hostname, 'hostname');
    this.validatePathSegment(key, 'key');

    const response = await this.request(
      `${this.url}/v1/secret/data/hosts/${hostname}/${key}`,
      {
        method: 'POST',
        headers: {
          'X-Vault-Token': this.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ data: { value } }),
      },
      'SET_HOST',
      `host "${hostname}" key "${key}"`,
    );

    if (!response.ok) {
      await this.throwApiError(response, 'SET_HOST', `host "${hostname}" key "${key}"`);
    }
  }

  /**
   * Delete a host secret (metadata and all versions).
   * Does not throw if the secret does not exist.
   */
  async deleteHostSecret(hostname: string, key: string): Promise<void> {
    this.validatePathSegment(hostname, 'hostname');
    this.validatePathSegment(key, 'key');

    const response = await this.request(
      `${this.url}/v1/secret/metadata/hosts/${hostname}/${key}`,
      {
        method: 'DELETE',
        headers: { 'X-Vault-Token': this.token },
      },
      'DELETE_HOST',
      `host "${hostname}" key "${key}"`,
    );

    if (response.status === 404) {
      return;
    }

    if (!response.ok) {
      await this.throwApiError(response, 'DELETE_HOST', `host "${hostname}" key "${key}"`);
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
   * Fetches all secrets concurrently. If any fetch fails with a non-404 error,
   * the entire operation fails — partial secrets are worse than no deploy.
   * Individual 404s (race with deletion) are silently skipped.
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

    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    if (failed.length > 0) {
      const reasons = failed.map((r) =>
        r.reason instanceof Error ? r.reason.message : String(r.reason),
      );
      throw new Error(
        `Failed to fetch ${failed.length}/${keys.length} secrets for stack "${stack}": ${reasons.join('; ')}`,
      );
    }

    const entries: (readonly [string, string])[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value !== null) {
        entries.push(result.value);
      }
    }

    entries.sort((a, b) => a[0].localeCompare(b[0]));
    return Object.fromEntries(entries);
  }

  /**
   * Ensure the KV v2 secrets engine is enabled at the `secret/` path.
   * Safe to call multiple times — checks existing mounts first.
   */
  async ensureSecretsEngine(): Promise<void> {
    const mountsResponse = await this.request(
      `${this.url}/v1/sys/mounts`,
      {
        method: 'GET',
        headers: { 'X-Vault-Token': this.token },
      },
      'GET_MOUNTS',
      'sys/mounts',
    );

    if (!mountsResponse.ok) {
      await this.throwApiError(mountsResponse, 'GET_MOUNTS', 'sys/mounts');
    }

    const mounts = await this.parseJsonResponse(mountsResponse, 'GET_MOUNTS', 'sys/mounts');
    if (typeof mounts !== 'object' || mounts === null || Array.isArray(mounts)) {
      throw new Error(
        'OpenBao GET_MOUNTS failed for sys/mounts: unexpected response shape',
      );
    }
    if ((mounts as Record<string, unknown>)['secret/']) {
      return;
    }

    const enableResponse = await this.request(
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
      'ENABLE_ENGINE',
      'secret/',
    );

    if (!enableResponse.ok) {
      await this.throwApiError(enableResponse, 'ENABLE_ENGINE', 'secret/');
    }
  }
}
