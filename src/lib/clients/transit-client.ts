import { SAFE_PATH_SEGMENT_PATTERN } from '@/lib/constants/openbao';

export interface TransitConfig {
  url: string;
  token: string;
}

/**
 * Thin wrapper around OpenBao Transit secrets engine HTTP API.
 * Provides encrypt/decrypt operations using native fetch() — no SDK dependency.
 *
 * Key name convention: matches SAFE_PATH_SEGMENT_PATTERN ([a-zA-Z0-9_-]+)
 */
export class TransitClient {
  private readonly url: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(config: TransitConfig, fetchFn: typeof fetch = globalThis.fetch) {
    this.url = config.url;
    this.token = config.token;
    this.fetchFn = fetchFn;
  }

  /**
   * Validate that a Transit key name contains only safe characters.
   * Prevents path traversal and injection attacks in OpenBao API URLs.
   */
  private validateKeyName(keyName: string): void {
    if (!SAFE_PATH_SEGMENT_PATTERN.test(keyName)) {
      throw new Error(`Invalid Transit key name: must match ${SAFE_PATH_SEGMENT_PATTERN}`);
    }
  }

  /**
   * Extract error detail from a non-OK OpenBao response body.
   * Returns `: <errors>` if errors are present, empty string otherwise.
   */
  private async extractError(response: Response): Promise<string> {
    try {
      const body = await response.json();
      if (body.errors) return `: ${(body.errors as string[]).join(', ')}`;
    } catch {
      // Not JSON — ignore
    }
    return '';
  }

  /**
   * Encrypt plaintext using the named Transit key.
   * The plaintext is base64-encoded before transmission as required by the API.
   * Returns the ciphertext string (e.g. "vault:v1:...").
   */
  async encrypt(keyName: string, plaintext: string): Promise<string> {
    this.validateKeyName(keyName);
    const encoded = Buffer.from(plaintext).toString('base64');

    const response = await this.fetchFn(`${this.url}/v1/transit/encrypt/${keyName}`, {
      method: 'POST',
      headers: {
        'X-Vault-Token': this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ plaintext: encoded }),
    });

    if (!response.ok) {
      const detail = await this.extractError(response);
      throw new Error(`Transit encrypt failed for key "${keyName}" (HTTP ${response.status})${detail}`);
    }

    const body = await response.json() as { data?: { ciphertext?: string } };
    const ciphertext = body?.data?.ciphertext;
    if (typeof ciphertext !== 'string') {
      throw new Error(`Transit encrypt failed for key "${keyName}": unexpected response shape`);
    }
    return ciphertext;
  }

  /**
   * Decrypt ciphertext using the named Transit key.
   * The response plaintext is base64-decoded before returning.
   * Returns the original plaintext string.
   */
  async decrypt(keyName: string, ciphertext: string): Promise<string> {
    this.validateKeyName(keyName);

    const response = await this.fetchFn(`${this.url}/v1/transit/decrypt/${keyName}`, {
      method: 'POST',
      headers: {
        'X-Vault-Token': this.token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ciphertext }),
    });

    if (!response.ok) {
      const detail = await this.extractError(response);
      throw new Error(`Transit decrypt failed for key "${keyName}" (HTTP ${response.status})${detail}`);
    }

    const body = await response.json() as { data?: { plaintext?: string } };
    const encoded = body?.data?.plaintext;
    if (typeof encoded !== 'string') {
      throw new Error(`Transit decrypt failed for key "${keyName}": unexpected response shape`);
    }
    return Buffer.from(encoded, 'base64').toString();
  }
}
