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
  const { StackSecretsRepository } = await import('@/lib/database/repositories/stack-secrets-repository');
  const { AgentKeypairsRepository } = await import('@/lib/database/repositories/agent-keypairs-repository');
  const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const pool = dbClient.getPool();

  const keyring = await loadMasterKeyring();
  const stackSecrets = new StackSecretsRepository(pool, keyring);
  const agentKeypairs = new AgentKeypairsRepository(pool, keyring);

  // DeployRepository and HostRepository are lightweight pool wrappers.
  // The pool itself is cached by databaseConnectionManager, so per-call allocation
  // is negligible, so no singleton is needed here.
  const deployRepo = new DeployRepository(pool);

  const { createStackRepoWriter } = await import('@/lib/deploy/stack-repo-writer');
  const stackRepoWriter = createStackRepoWriter();

  const pipeline = new DeployPipeline({
    deployRepo,
    hostsRepo: new HostRepository(pool),
    agentClientFactory: (url, signer) => new AgentClient({ agentUrl: url, signer }),
    stackRepoWriter,
    secretResolver: {
      async resolve(stack: string, variables: string[]): Promise<Record<string, string>> {
        if (variables.length === 0) return {};
        const results = await Promise.allSettled(
          variables.map(async (v) => [v, await stackSecrets.get(stack, v)] as const),
        );
        const failed = results.filter((r) => r.status === 'rejected').length;
        if (failed > 0) {
          throw new Error(`Failed to decrypt ${failed} secret(s) for stack "${stack}". Check that MASTER_KEY is correct.`);
        }
        const entries = results
          .filter((r): r is PromiseFulfilledResult<readonly [string, string | null]> => r.status === 'fulfilled')
          .map((r) => r.value);
        const secrets: Record<string, string> = {};
        for (const [k, v] of entries) {
          if (v !== null) secrets[k] = v;
        }
        return secrets;
      },
    },
    tokenResolver: async (host) => {
      const privateKey = await agentKeypairs.getPrivateKeyForHost(host.name);
      if (!privateKey) {
        throw new Error(`No agent keypair found for host "${host.name}". Re-enroll the agent.`);
      }
      return () => signAgentJwt(privateKey, host.name);
    },
  });

  return { pipeline, deployRepo, stackRepoWriter };
}
