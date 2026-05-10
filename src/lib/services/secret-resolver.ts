/**
 * Resolves secrets for a stack's environment. Used by the deploy pipeline service layer.
 *
 * The deploy pipeline calls resolveSecrets() to build the .env file.
 *
 * Implementations:
 * - NoOpSecretResolver: returns empty record (stacks use whatever .env files exist on the host)
 */
export interface SecretResolver {
  /**
   * Resolve all secrets for a given stack.
   * Returns a Record of key-value pairs to be written as .env content.
   */
  resolveSecrets(stack: string): Promise<Record<string, string>>;
}

/**
 * No-op implementation. Returns empty secrets: stacks use whatever .env files already exist on the host.
 */
export class NoOpSecretResolver implements SecretResolver {
  async resolveSecrets(_stack: string): Promise<Record<string, string>> {
    return {};
  }
}
