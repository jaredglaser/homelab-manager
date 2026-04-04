import { buildDeployRequests } from '@/lib/git/post-receive';
import { readFileFromRepo } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';
import { GitTriggerBuilder } from '@/lib/deploy/builders/git-trigger-builder';
import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';

/**
 * Process a post-receive event after a git push.
 * Diffs the old and new HEAD, builds deploy requests, and dispatches them
 * to the deploy pipeline.
 *
 * @throws {Error} If manifest.yaml is missing from the repo
 * @throws {YAMLException} If manifest.yaml has invalid YAML syntax
 * @throws {ZodError} If manifest.yaml structure doesn't match schema
 */
export async function processPostReceive(
  repoPath: string,
  oldHead: string,
  newHead: string,
  deployRepo?: DeployRepository,
): Promise<void> {
  const postReceiveRequests = await buildDeployRequests(repoPath, oldHead, newHead);

  if (postReceiveRequests.length === 0) {
    return;
  }

  // Read the manifest at newHead to get the authoritative stack config
  const manifestContent = await readFileFromRepo(repoPath, 'manifest.yaml', newHead);
  const manifest = parseManifest(manifestContent);

  // Build a map of stackName -> composeContent for changed stacks.
  const changedStacks = new Map<string, string>();
  for (const req of postReceiveRequests) {
    console.info(
      `[PostReceive] Deploy request: ${req.action} ${req.stack} on ${req.host} (auto=${req.autoApproved})`,
    );
    try {
      const composeContent = await readFileFromRepo(repoPath, req.composePath, newHead);
      changedStacks.set(req.stack, composeContent);
    } catch (err) {
      console.error(
        `[PostReceive] Failed to read compose file for stack "${req.stack}" at ${newHead}:`,
        err,
      );
      if (deployRepo) {
        try {
          await deployRepo.insertDeploy({
            stack: req.stack,
            host: req.host,
            commitSha: req.commitSha,
            composeHash: '',
            envHash: '',
            status: 'failed',
            trigger: 'git_push',
            action: req.action,
          });
        } catch (dbErr) {
          console.error(
            `[PostReceive] Failed to insert failed deploy record for stack "${req.stack}":`,
            dbErr,
          );
        }
      }
    }
  }

  if (changedStacks.size === 0) {
    return;
  }

  // Build pipeline-compatible deploy requests via GitTriggerBuilder
  const builder = new GitTriggerBuilder();
  const deployRequests = builder.build({ manifest, changedStacks, commitSha: newHead });

  if (deployRequests.length === 0) {
    return;
  }

  // Set up pipeline dependencies and dispatch deploy requests.
  // Wrap in try/catch so pipeline failures never propagate — the post-receive
  // hook must always complete so the git push is not blocked.
  try {
    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');
    const { ManagedHostsRepository } = await import(
      '@/lib/database/repositories/managed-hosts-repository'
    );
    const { AgentClient } = await import('@/lib/clients/agent-client');
    const { DeployPipeline } = await import('@/lib/deploy/pipeline');
    const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
    const { loadOpenBaoConfig, isOpenBaoConfigured } = await import(
      '@/lib/config/openbao-config'
    );

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const pool = dbClient.getPool();

    let baoClient: InstanceType<typeof OpenBaoClient> | null = null;
    if (isOpenBaoConfigured()) {
      baoClient = new OpenBaoClient(loadOpenBaoConfig());
    }

    const pipeline = new DeployPipeline({
      deployRepo: new DeployRepository(pool),
      hostsRepo: new ManagedHostsRepository(pool),
      agentClientFactory: (url, token) => new AgentClient({ agentUrl: url, agentToken: token }),
      secretResolver: {
        async resolve(stack: string, variables: string[]): Promise<Record<string, string>> {
          if (variables.length === 0 || !baoClient) return {};
          const entries = await Promise.all(
            variables.map(async (v) => {
              const val = await baoClient.getSecret(stack, v);
              return [v, val] as const;
            }),
          );
          const secrets: Record<string, string> = {};
          for (const [key, val] of entries) {
            if (val !== null) secrets[key] = val;
          }
          return secrets;
        },
      },
      tokenResolver: async (host) => {
        if (!baoClient) throw new Error('OpenBao not configured — cannot resolve agent token');
        const token = await baoClient.getHostSecret(host.name, 'agent_token');
        if (!token) throw new Error(`No agent token found in OpenBao for host "${host.name}"`);
        return token;
      },
    });

    // Group deploys by host — sequential within each host, parallel across hosts
    const byHost = new Map<string, typeof deployRequests>();
    for (const request of deployRequests) {
      const hostRequests = byHost.get(request.host) ?? [];
      hostRequests.push(request);
      byHost.set(request.host, hostRequests);
    }

    await Promise.all(
      [...byHost.values()].map(async (hostRequests) => {
        for (const request of hostRequests) {
          try {
            const result = await pipeline.execute(request);
            console.info(
              `[PostReceive] Deploy pipeline result for "${request.stack}": ${result.status}`,
            );
          } catch (err) {
            console.error(
              `[PostReceive] Deploy pipeline failed for stack "${request.stack}":`,
              err,
            );
          }
        }
      }),
    );
  } catch (err) {
    console.error(
      '[PostReceive] Failed to initialize deploy pipeline:',
      err,
    );
  }
}
