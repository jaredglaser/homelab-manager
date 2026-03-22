let cachedClientSecret: string | null = null;

export async function getOidcClientSecret(): Promise<string> {
  if (cachedClientSecret) return cachedClientSecret;

  const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
  const { loadOpenBaoConfig } = await import('@/lib/config/openbao-config');
  const { initializeOpenBao } = await import('@/lib/services/openbao-init');

  const client = new OpenBaoClient(loadOpenBaoConfig());
  await initializeOpenBao(client);

  const secret = await client.getSecret('oidc', 'client-secret');
  if (!secret) {
    throw new Error('OIDC client secret not found in OpenBao at secret/stacks/oidc/client-secret');
  }

  cachedClientSecret = secret;
  return secret;
}

export function resetOidcSecretsCache(): void {
  cachedClientSecret = null;
}
