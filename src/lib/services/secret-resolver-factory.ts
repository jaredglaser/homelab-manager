import { isOpenBaoConfigured, loadOpenBaoConfig } from '@/lib/config/openbao-config';
import { OpenBaoClient } from '@/lib/clients/openbao-client';
import { OpenBaoSecretResolver } from '@/lib/services/openbao-secret-resolver';
import { NoOpSecretResolver, type SecretResolver } from '@/lib/services/secret-resolver';

/**
 * Create the appropriate SecretResolver based on configuration.
 * Returns OpenBaoSecretResolver when OPENBAO_URL is set, NoOpSecretResolver otherwise.
 */
export function createSecretResolver(): SecretResolver {
  if (!isOpenBaoConfigured()) {
    return new NoOpSecretResolver();
  }

  const config = loadOpenBaoConfig();
  const client = new OpenBaoClient(config);
  return new OpenBaoSecretResolver(client);
}
