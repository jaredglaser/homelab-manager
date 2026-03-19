import { isOpenBaoConfigured, loadOpenBaoConfig } from '@/lib/config/openbao-config';
import { OpenBaoClient } from '@/lib/clients/openbao-client';
import { OpenBaoSecretResolver } from '@/lib/services/openbao-secret-resolver';
import { NoOpSecretResolver, type SecretResolver } from '@/lib/services/secret-resolver';

/**
 * Create the appropriate SecretResolver based on configuration.
 * Returns OpenBaoSecretResolver when both OPENBAO_URL and OPENBAO_TOKEN are set,
 * NoOpSecretResolver otherwise.
 */
export function createSecretResolver(): SecretResolver {
  if (!isOpenBaoConfigured()) {
    console.info('OpenBao not configured — using NoOpSecretResolver (no secrets will be injected)');
    return new NoOpSecretResolver();
  }

  const config = loadOpenBaoConfig();
  const client = new OpenBaoClient(config);
  return new OpenBaoSecretResolver(client);
}
