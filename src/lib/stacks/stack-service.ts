/**
 * Stack service — integration layer between git management and deploy pipeline.
 * Called by server functions in src/data/stacks.functions.tsx.
 */

import type { StackSummary, StackDetail, StackDeployRecord } from '@/types/stacks';
import type { DeployRecord } from '@/lib/deploy/types';
import { loadGitConfig } from '@/lib/config/git-config';
import { readFileFromRepo } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';
import { saveAndCommitFile } from '@/lib/git/editor-operations';

const COMPOSE_FILENAME = 'docker-compose.yml';
const MANIFEST_FILENAME = 'manifest.yaml';
const SYSTEM_AUTHOR = { name: 'homelab-manager', email: 'homelab-manager@localhost' };

function getRepoPath(): string | null {
  const config = loadGitConfig();
  return config.enabled ? config.repoPath : null;
}

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

    return Object.entries(manifest.stacks).map(([name, entry]) => ({
      name,
      host: entry.host,
      syncStatus: 'unknown' as const,
      deployMode: entry.autoDeploy ? ('auto' as const) : ('manual' as const),
      lastDeployAt: null,
      lastDeployStatus: null,
      containerCount: 0,
      icon: null,
    }));
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

    const variableNames = extractVariableNames(composeContent);

    return {
      name: stackName,
      host: entry.host,
      syncStatus: 'unknown',
      deployMode: entry.autoDeploy ? 'auto' : 'manual',
      composeContent,
      lastDeployCommitSha: null,
      currentCommitSha: '',
      variableNames,
      icon: null,
    };
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

  // Read compose content from the git repo
  let composeContent = '';
  try {
    composeContent = await readFileFromRepo(repoPath, `${params.stack}/${COMPOSE_FILENAME}`);
  } catch {
    if (params.action === 'deploy') {
      throw new Error(`No compose file found for stack "${params.stack}"`);
    }
  }

  // Get current commit SHA
  const commitSha = await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });

  // Build the deploy request
  const builder = new UITriggerBuilder();
  const request = builder.build({
    stack: params.stack,
    host: params.host,
    composeContent,
    commitSha,
    action: params.action,
  });

  // Set up pipeline dependencies
  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const pool = dbClient.getPool();

  // Token resolver: read agent token from OpenBao
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

  const result = await pipeline.execute(request);

  return { deployId: result.deployId ?? 0 };
}

export async function getStackDeployHistory(
  stackName: string,
  limit: number,
): Promise<StackDeployRecord[]> {
  try {
    const repoPath = getRepoPath();
    if (!repoPath) return [];

    // Look up host from manifest
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

    // Look up host from manifest to build entity path
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

/** Extract ${VAR_NAME} references from compose content. */
function extractVariableNames(content: string): string[] {
  const regex = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::-[^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpMatchArray | null;
  while ((match = regex.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars).sort();
}

/** Convert internal DeployRecord (Date) to API-facing StackDeployRecord (string). */
function toStackDeployRecord(record: DeployRecord): StackDeployRecord {
  return {
    id: record.id,
    stack: record.stack,
    host: record.host,
    commitSha: record.commitSha,
    envHash: record.envHash,
    status: record.status,
    trigger: record.trigger,
    logs: record.logs,
    createdAt: record.createdAt.toISOString(),
  };
}
