/**
 * Stack service — integration layer between git management and deploy pipeline.
 * Called by server functions in src/data/stacks.functions.tsx.
 */

import type { StackSummary, StackDetail, StackDeployRecord } from '@/types/stacks';
import { loadGitConfig } from '@/lib/config/git-config';
import { readFileFromRepo } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';
import { saveAndCommitFile } from '@/lib/git/editor-operations';
import {
  manifestEntryToSummary,
  manifestEntryToDetail,
  toStackDeployRecord,
  handleTriggerDeploy,
  computeSyncStatus,
} from '@/lib/stacks/stack-mappers';

const COMPOSE_FILENAME = 'docker-compose.yml';
const MANIFEST_FILENAME = 'manifest.yaml';
const SYSTEM_AUTHOR = { name: 'homelab-manager', email: 'homelab-manager@localhost' };

function getRepoPath(): string | null {
  const config = loadGitConfig();
  return config.enabled ? config.repoPath : null;
}

// ----- Service functions (wiring layer) -----

export async function getStackSummaries(): Promise<StackSummary[]> {
  try {
    const repoPath = getRepoPath();
    if (!repoPath) return [];

    let manifestContent: string;
    try {
      manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
    } catch {
      return [];
    }

    const manifest = parseManifest(manifestContent);
    const entries = Object.entries(manifest.stacks);

    // Batch-fetch latest deploy per stack and resolve HEAD SHA in parallel
    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');
    const { default: git } = await import('isomorphic-git');
    const fs = await import('fs');

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const deployRepo = new DeployRepository(dbClient.getPool());

    const [latestDeploys, headSha] = await Promise.all([
      deployRepo.getLatestDeployPerStack(),
      git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' }).catch(() => null),
    ]);

    const latestDeployMap = new Map(latestDeploys.map((d) => [d.stack, d]));

    return entries.map(([name, entry]) => {
      const summary = manifestEntryToSummary(name, entry);
      summary.syncStatus = computeSyncStatus(latestDeployMap.get(name) ?? null, headSha);
      return summary;
    });
  } catch (error) {
    console.error('[StackService] Failed to load stack summaries:', error);
    return [];
  }
}

export async function getStackDetailByName(
  stackName: string,
): Promise<StackDetail | null> {
  try {
    const repoPath = getRepoPath();
    if (!repoPath) return null;

    const manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
    const manifest = parseManifest(manifestContent);
    const entry = manifest.stacks[stackName];
    if (!entry) return null;

    let composeContent = '';
    try {
      composeContent = await readFileFromRepo(repoPath, `${stackName}/${COMPOSE_FILENAME}`);
    } catch {
      // Stack is in manifest but compose file doesn't exist yet
    }

    return manifestEntryToDetail(stackName, entry, composeContent);
  } catch (error) {
    console.error(`[StackService] Failed to load stack detail for "${stackName}":`, error);
    return null;
  }
}

export async function triggerStackDeploy(params: {
  stack: string;
  host: string;
  action: 'deploy' | 'teardown' | 'restart';
}): Promise<{ deployId: number }> {
  const repoPath = getRepoPath();
  if (!repoPath) throw new Error('Git management is not enabled');

  const { default: git } = await import('isomorphic-git');
  const fs = await import('fs');
  const { UITriggerBuilder } = await import('@/lib/deploy/builders/ui-trigger-builder');
  const { DeployPipeline } = await import('@/lib/deploy/pipeline');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');
  const { ManagedHostsRepository } = await import('@/lib/database/repositories/managed-hosts-repository');
  const { AgentClient } = await import('@/lib/clients/agent-client');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { OpenBaoClient } = await import('@/lib/clients/openbao-client');
  const { loadOpenBaoConfig, isOpenBaoConfigured } = await import('@/lib/config/openbao-config');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const pool = dbClient.getPool();

  let baoClient: InstanceType<typeof OpenBaoClient> | null = null;
  if (isOpenBaoConfigured()) {
    baoClient = new OpenBaoClient(loadOpenBaoConfig());
  }

  const builder = new UITriggerBuilder();
  const pipeline = new DeployPipeline({
    deployRepo: new DeployRepository(pool),
    hostsRepo: new ManagedHostsRepository(pool),
    agentClientFactory: (url, token) => new AgentClient({ agentUrl: url, agentToken: token }),
    secretResolver: {
      async resolve(stack: string, variables: string[]): Promise<Record<string, string>> {
        if (variables.length === 0 || !baoClient) return {};
        const secrets: Record<string, string> = {};
        for (const v of variables) {
          const val = await baoClient.getSecret(stack, v);
          if (val !== null) secrets[v] = val;
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

  return handleTriggerDeploy({
    readCompose: (stack) => readFileFromRepo(repoPath, `${stack}/${COMPOSE_FILENAME}`),
    getCommitSha: () => git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' }),
    buildRequest: (input) => builder.build(input),
    executePipeline: (request) => pipeline.execute(request),
  }, params);
}

export async function getStackDeployHistory(
  stackName: string,
  limit: number,
): Promise<StackDeployRecord[]> {
  try {
    const repoPath = getRepoPath();
    if (!repoPath) return [];

    const manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
    const manifest = parseManifest(manifestContent);
    const entry = manifest.stacks[stackName];
    if (!entry) return [];

    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new DeployRepository(dbClient.getPool());

    const records = await repo.getDeployHistory(stackName, entry.host, limit);
    return records.map(toStackDeployRecord);
  } catch (error) {
    console.error(`[StackService] Failed to load deploy history for "${stackName}":`, error);
    return [];
  }
}

export async function saveStackComposeFile(
  stackName: string,
  content: string,
): Promise<{ commitSha: string }> {
  const repoPath = getRepoPath();
  if (!repoPath) throw new Error('Git management is not enabled');

  return saveAndCommitFile(repoPath, {
    filePath: `${stackName}/${COMPOSE_FILENAME}`,
    content,
    author: SYSTEM_AUTHOR,
    message: `Update ${stackName}/${COMPOSE_FILENAME}`,
  });
}

export async function updateStackIconSlug(
  stackName: string,
  iconSlug: string,
): Promise<void> {
  try {
    const repoPath = getRepoPath();
    if (!repoPath) return;

    const manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
    const manifest = parseManifest(manifestContent);
    const entry = manifest.stacks[stackName];
    if (!entry) return;

    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const repo = new StatsRepository(dbClient.getPool());

    await repo.upsertEntityMetadata('docker', `${entry.host}/${stackName}`, 'icon', iconSlug);
  } catch (error) {
    console.error(`[StackService] Failed to update icon for "${stackName}":`, error);
  }
}
