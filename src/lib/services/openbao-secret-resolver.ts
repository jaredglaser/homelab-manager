import type { SecretResolver } from '@/lib/services/secret-resolver';
import type { OpenBaoClient } from '@/lib/clients/openbao-client';

/**
 * SecretResolver implementation backed by OpenBao KV v2.
 * Fetches all secrets for a stack and returns them as key-value pairs.
 */
export class OpenBaoSecretResolver implements SecretResolver {
  private readonly client: OpenBaoClient;

  constructor(client: OpenBaoClient) {
    this.client = client;
  }

  async resolveSecrets(stack: string): Promise<Record<string, string>> {
    return this.client.getAllSecrets(stack);
  }
}
