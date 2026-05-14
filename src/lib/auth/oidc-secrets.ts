/**
 * Load the OIDC client secret from the environment.
 * Reads OIDC_CLIENT_SECRET at startup.
 */
export async function getOidcClientSecret(): Promise<string> {
  const secret = process.env.OIDC_CLIENT_SECRET;
  if (!secret || secret.trim().length === 0) {
    throw new Error('OIDC_CLIENT_SECRET environment variable must be set when auth is enabled');
  }
  return secret.trim();
}

export function resetOidcSecretsCache(): void {
  // No-op: env var reading is stateless
}
