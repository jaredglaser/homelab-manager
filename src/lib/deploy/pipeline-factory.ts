import type { DeployPipeline, StackRepoWriter } from '@/lib/deploy/pipeline';
import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';

export interface DeployPipelineBundle {
  pipeline: DeployPipeline;
  deployRepo: DeployRepository;
  stackRepoWriter: StackRepoWriter;
}

/**
 * Creates a fully-wired DeployPipeline and DeployRepository from the
 * current environment configuration.
 *
 * Uses dynamic imports for all server-only modules to prevent them from
 * leaking into the client bundle.
 *
 * The `deployRepo` is exposed separately because some call sites (e.g.
 * post-receive-handler) need to insert failed deploy records independently
 * before the pipeline has had a chance to run.
 */
export async function createDeployPipeline(): Promise<DeployPipelineBundle> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');
  const { AgentClient } = await import('@/lib/clients/agent-client');
  const { DeployPipeline } = await import('@/lib/deploy/pipeline');
  const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
  const { loadOpenBaoConfig, isOpenBaoConfigured } = await import('@/lib/config/openbao-config');
  const { StackSecretsRepository } = await import('@/lib/database/repositories/stack-secrets-repository');
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const pool = dbClient.getPool();

  let baoClient: InstanceType<typeof OpenBaoClient> | null = null;
  if (isOpenBaoConfigured()) {
    baoClient = new OpenBaoClient(loadOpenBaoConfig());
  }

  const keyring = await loadMasterKeyring();
  const stackSecrets = new StackSecretsRepository(pool, keyring);

  // DeployRepository and HostRepository are lightweight pool wrappers.
  // The pool itself is cached by databaseConnectionManager, so per-call allocation
  // is negligible, so no singleton is needed here.
  const deployRepo = new DeployRepository(pool);

  const { createStackRepoWriter } = await import('@/lib/deploy/stack-repo-writer');
  const stackRepoWriter = createStackRepoWriter();

  const pipeline = new DeployPipeline({
    deployRepo,
    hostsRepo: new HostRepository(pool),
    agentClientFactory: (url, token) => new AgentClient({ agentUrl: url, agentToken: token }),
    stackRepoWriter,
    secretResolver: {
      async resolve(stack: string, variables: string[]): Promise<Record<string, string>> {
        if (variables.length === 0) return {};
        const entries = await Promise.all(
          variables.map(async (v) => [v, await stackSecrets.get(stack, v)] as const),
        );
        const secrets: Record<string, string> = {};
        for (const [k, v] of entries) {
          if (v !== null) secrets[k] = v;
        }
        return secrets;
      },
    },
    tokenResolver: async (host) => {
      if (!baoClient) throw new Error('OpenBao not configured, cannot resolve agent token');
      const token = await baoClient.getHostSecret(host.name, 'agent_token');
      if (!token) throw new Error(`No agent token found in OpenBao for host "${host.name}"`);
      return token;
    },
  });

  return { pipeline, deployRepo, stackRepoWriter };
}
