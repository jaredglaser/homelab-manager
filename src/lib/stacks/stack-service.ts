/**
 * Stack service: integration layer between git management and deploy pipeline.
 * Called by server functions in src/data/stacks/functions.tsx.
 */

import type {
  StackSummary,
  StackDetail,
  StackDeployRecord,
  StackDriftReport,
  StackDriftResolution,
  StackDriftResolutionResult,
} from '@/types/stacks';
import type { DeployRecord, DeployRequest } from '@/lib/deploy/types';
import { loadGitConfig } from '@/lib/config/git-config';
import { readFileFromRepo, commitFiles, FileNotFoundError } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';
import { saveAndCommitFile } from '@/lib/git/editor-operations';
import { computeHash } from '@/lib/deploy/change-detection';
import { AgentClientError } from '@/lib/clients/agent-client';
import type { AgentStackInventoryEntry } from '@homelab-manager/agent/types';
import yaml from 'js-yaml';
import { SAFE_PATH_SEGMENT_PATTERN } from '@/lib/constants/openbao';
import {
  manifestEntryToSummary,
  manifestEntryToDetail,
  toStackDeployRecord,
  handleTriggerDeploy,
  computeSyncStatus,
} from '@/lib/stacks/stack-mappers';
import { resolveDeleteStack, type DeleteStackResult } from '@/lib/stacks/delete-stack-resolver';
import {
  buildStackDriftReport,
  resolveStackDriftItem,
  type RepoStackSnapshot,
} from '@/lib/stacks/stack-drift-service';

/** Re-exported alongside service layer for consistent mock.module() targeting in tests. */
export { resolveDeleteStack } from '@/lib/stacks/delete-stack-resolver';
export type { DeleteStackDeps, DeleteStackResult } from '@/lib/stacks/delete-stack-resolver';

const COMPOSE_FILENAME = 'docker-compose.yml';
const MANIFEST_FILENAME = 'manifest.yaml';
const SYSTEM_AUTHOR = { name: 'homelab-manager', email: 'homelab-manager@localhost' };

function getRepoPath(): string {
  const config = loadGitConfig();
  return config.repoPath;
}

export async function getStackSummaries(): Promise<StackSummary[]> {
  const repoPath = getRepoPath();

  let manifestContent: string;
  try {
    manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
  } catch {
    return [];
  }

  const manifest = parseManifest(manifestContent);
  const entries = Object.entries(manifest.stacks);

  try {
    // Batch-fetch latest deploy per stack and resolve HEAD SHA in parallel
    const { databaseConnectionManager } = await import('@/lib/clients/database-client');
    const { loadDatabaseConfig } = await import('@/lib/config/database-config');
    const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');
    const { default: git } = await import('isomorphic-git');
    const fs = await import('node:fs');

    const dbConfig = loadDatabaseConfig();
    const dbClient = await databaseConnectionManager.getClient(dbConfig);
    const deployRepo = new DeployRepository(dbClient.getPool());

    const [latestDeploys, headSha] = await Promise.all([
      deployRepo.getLatestDeployPerStack(),
      git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' }).catch(() => null),
    ]);

    const latestDeployMap = new Map(latestDeploys.map((d) => [`${d.host}/${d.stack}`, d]));

    return entries.map(([name, entry]) => {
      const summary = manifestEntryToSummary(name, entry);
      summary.syncStatus = computeSyncStatus(latestDeployMap.get(`${entry.host}/${name}`) ?? null, headSha);
      return summary;
    });
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw error;
    }
    console.error('[StackService] Failed to enrich stack summaries:', error);
    // Return manifest stacks with 'unknown' sync status when DB/git fails
    return entries.map(([name, entry]) => manifestEntryToSummary(name, entry));
  }
}

export async function getStackDetailByName(
  stackName: string,
): Promise<StackDetail | null> {
  try {
    const repoPath = getRepoPath();
    const manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
    const manifest = parseManifest(manifestContent);
    const entry = manifest.stacks[stackName];
    if (!entry) return null;

    let composeContent = '';
    try {
      composeContent = await readFileFromRepo(repoPath, `${stackName}/${COMPOSE_FILENAME}`);
    } catch (err) {
      if (!(err instanceof FileNotFoundError)) {
        console.error(`[StackService] Unexpected error reading compose file for "${stackName}":`, err);
        throw err;
      }
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
  commitSha?: string;
  forceRecreate?: boolean;
  postSuccess?: 'removeFromManifest';
}): Promise<{ deployId: number }> {
  const repoPath = getRepoPath();

  const { default: git } = await import('isomorphic-git');
  const fs = await import('node:fs');
  const { UITriggerBuilder } = await import('@/lib/deploy/builders/ui-trigger-builder');
  const { createDeployPipeline } = await import('@/lib/deploy/pipeline-factory');

  const builder = new UITriggerBuilder();
  const { pipeline } = await createDeployPipeline();

  if (params.commitSha) {
    // Rollback: read compose from the historical commit and use buildRollback
    const rollbackSha = params.commitSha;
    return handleTriggerDeploy({
      readCompose: (stack) =>
        readFileFromRepo(repoPath, `${stack}/${COMPOSE_FILENAME}`, rollbackSha),
      getCommitSha: () => Promise.resolve(rollbackSha),
      buildRequest: (input) =>
        builder.buildRollback({
          stack: input.stack,
          host: input.host,
          composeContent: input.composeContent,
          commitSha: input.commitSha,
        }),
      executePipeline: (request) => pipeline.execute(request),
    }, params);
  }

  return handleTriggerDeploy({
    readCompose: (stack) => readFileFromRepo(repoPath, `${stack}/${COMPOSE_FILENAME}`),
    getCommitSha: () => git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' }),
    buildRequest: (input) => {
      const req = builder.build(input);
      return params.postSuccess ? { ...req, postSuccess: params.postSuccess } : req;
    },
    executePipeline: (request) => pipeline.execute(request),
  }, params);
}

/**
 * Approve a pending deploy and run it through the pipeline's `resumePending` path.
 * Rebuilds the `DeployRequest` from the stored deploy record, reading the compose
 * file at the record's commitSha so the exact configuration that was pending is what gets deployed.
 */
export async function resumePendingDeploy(deployId: number): Promise<{ deployId: number }> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');
  const { ManagedHostsRepository } = await import('@/lib/database/repositories/managed-hosts-repository');
  const { createDeployPipeline } = await import('@/lib/deploy/pipeline-factory');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const pool = dbClient.getPool();
  const deployRepo = new DeployRepository(pool);
  const hostsRepo = new ManagedHostsRepository(pool);

  const deploy = await deployRepo.getById(deployId);
  if (!deploy) throw new Error(`Deploy ${deployId} not found`);
  if (deploy.status !== 'pending') {
    throw new Error(`Deploy is not pending (status: ${deploy.status})`);
  }

  const host = await hostsRepo.getByName(deploy.host);
  if (!host) throw new Error(`Host "${deploy.host}" not found in managed_hosts`);

  // Rebuild the DeployRequest. For deploy action we need compose content; read it
  // from the commit the pending deploy was recorded against so what we approve
  // is exactly what was pending.
  const request = await buildRequestFromDeployRecord(deploy);

  const { pipeline } = await createDeployPipeline();
  const result = await pipeline.resumePending(deployId, host, request);
  // resumePending returns failed (instead of throwing) when claimPending loses a
  // race or the dispatch fails. Surface either case to the caller so the UI
  // shows an error toast instead of a misleading "Deploy approved" success.
  if (result.status === 'failed') {
    throw new Error(result.logs);
  }
  return { deployId: result.deployId ?? deployId };
}

/**
 * Reject a pending deploy. Marks it as `failed` with a "Manually rejected" log
 * message and notifies subscribers so the UI refreshes.
 */
export async function rejectPendingDeploy(deployId: number): Promise<{ deployId: number }> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const deployRepo = new DeployRepository(dbClient.getPool());

  const deploy = await deployRepo.getById(deployId);
  if (!deploy) throw new Error(`Deploy ${deployId} not found`);
  if (deploy.status !== 'pending') {
    throw new Error(`Deploy is not pending (status: ${deploy.status})`);
  }

  // Atomic transition guards against rejecting a deploy that was just approved
  // by another client between the getById above and this UPDATE.
  const claimed = await deployRepo.rejectPending(deployId, 'Manually rejected');
  if (!claimed) {
    throw new Error(`Deploy ${deployId} is no longer pending: it was approved or rejected by another client`);
  }
  try {
    await deployRepo.notifyStackChange(deploy.stack, deploy.host);
  } catch (err) {
    console.error(`Failed to notify stack change after rejecting deploy ${deployId}:`, err);
  }
  return { deployId };
}

async function buildRequestFromDeployRecord(
  deploy: DeployRecord,
): Promise<DeployRequest> {
  const base = {
    stack: deploy.stack,
    host: deploy.host,
    commitSha: deploy.commitSha,
    trigger: deploy.trigger,
    autoApproved: true,
    postSuccess: deploy.postSuccess ?? undefined,
  };

  if (deploy.action === 'deploy') {
    const repoPath = getRepoPath();
    let composeContent = '';
    try {
      composeContent = await readFileFromRepo(
        repoPath,
        `${deploy.stack}/${COMPOSE_FILENAME}`,
        deploy.commitSha,
      );
    } catch (err) {
      if (!(err instanceof FileNotFoundError)) throw err;
      console.warn(`[stack-service] compose file not found for deploy ${deploy.id}, proceeding with empty content`);
    }
    return {
      ...base,
      action: 'deploy',
      composeContent,
      envContent: '',
      forceRecreate: deploy.forceRecreate,
    };
  }

  return { ...base, action: deploy.action };
}

export async function getStackDeployHistory(
  stackName: string,
  limit: number,
): Promise<StackDeployRecord[]> {
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
}

export async function saveStackComposeFile(
  stackName: string,
  content: string,
): Promise<{ commitSha: string }> {
  const repoPath = getRepoPath();

  return saveAndCommitFile(repoPath, {
    filePath: `${stackName}/${COMPOSE_FILENAME}`,
    content,
    author: SYSTEM_AUTHOR,
    message: `Update ${stackName}/${COMPOSE_FILENAME}`,
  });
}

export async function createStackInRepo(
  stackName: string,
  host: string,
  autoDeploy: boolean,
): Promise<{ commitSha: string }> {
  const repoPath = getRepoPath();

  if (!SAFE_PATH_SEGMENT_PATTERN.test(stackName)) {
    throw new Error(`Invalid stack name "${stackName}": must contain only letters, numbers, hyphens, and underscores`);
  }

  // Validate host exists in managed_hosts
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { ManagedHostsRepository } = await import('@/lib/database/repositories/managed-hosts-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const hostsRepo = new ManagedHostsRepository(dbClient.getPool());
  const managedHost = await hostsRepo.getByName(host);
  if (!managedHost) throw new Error(`Host "${host}" not found in managed_hosts`);

  const commitSha = await commitFiles(repoPath, (existingFiles) => {
    const manifestContent = existingFiles.get(MANIFEST_FILENAME);
    const manifest = manifestContent ? parseManifest(manifestContent) : { stacks: {} };

    if (manifest.stacks[stackName]) {
      throw new Error(`Stack "${stackName}" already exists`);
    }

    manifest.stacks[stackName] = { host, autoDeploy };
    const newManifestContent = yaml.dump(manifest, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: true,
    });

    return {
      files: [
        { path: `${stackName}/${COMPOSE_FILENAME}`, content: '' },
        { path: MANIFEST_FILENAME, content: newManifestContent },
      ],
      message: `Add stack: ${stackName} on ${host}`,
      author: SYSTEM_AUTHOR,
    };
  });

  return { commitSha };
}

export async function deleteStackFromRepo(
  stackName: string,
  teardown: boolean,
): Promise<DeleteStackResult> {
  const repoPath = getRepoPath();

  const manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
  const manifest = parseManifest(manifestContent);
  const entry = manifest.stacks[stackName];
  if (!entry) throw new Error(`Stack "${stackName}" not found in manifest`);

  const { host } = entry;

  // Check for active deploys
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const pool = dbClient.getPool();

  const deployRepo = new DeployRepository(pool);
  const hasActive = await deployRepo.hasActiveDeployForStack(stackName, host);
  if (hasActive) {
    throw new Error(`Stack "${stackName}" has an active deploy in progress, cannot delete`);
  }

  return resolveDeleteStack(stackName, host, teardown, {
    triggerDeploy: (params) => triggerStackDeploy(params),
    commitRemoveFromManifest: (sn) => commitRemoveStackFromManifest(repoPath, sn),
  });
}

async function commitRemoveStackFromManifest(
  repoPath: string,
  stackName: string,
): Promise<{ commitSha: string }> {
  const commitSha = await commitFiles(repoPath, (existingFiles) => {
    const freshManifestContent = existingFiles.get(MANIFEST_FILENAME);
    if (freshManifestContent === undefined) {
      throw new Error(`Stack "${stackName}" not found in manifest`);
    }
    const manifest = parseManifest(freshManifestContent);

    if (!manifest.stacks[stackName]) {
      throw new Error(`Stack "${stackName}" not found in manifest`);
    }

    delete manifest.stacks[stackName];
    const newManifestContent = yaml.dump(manifest, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: true,
    });

    const stackDirPrefix = `${stackName}/`;
    const stackFiles = Array.from(existingFiles.keys()).filter((p) => p.startsWith(stackDirPrefix));

    return {
      files: [{ path: MANIFEST_FILENAME, content: newManifestContent }],
      filesToDelete: stackFiles,
      message: `Remove stack: ${stackName}`,
      author: SYSTEM_AUTHOR,
    };
  });

  return { commitSha };
}

export async function getManagedHostNames(): Promise<string[]> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { ManagedHostsRepository } = await import('@/lib/database/repositories/managed-hosts-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const hostsRepo = new ManagedHostsRepository(dbClient.getPool());
  const hosts = await hostsRepo.getAll();
  return hosts.map((h) => h.name);
}

async function getManagedHosts() {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { ManagedHostsRepository } = await import('@/lib/database/repositories/managed-hosts-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const hostsRepo = new ManagedHostsRepository(dbClient.getPool());
  return hostsRepo.getAll();
}

async function getLatestDeploys() {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const repo = new DeployRepository(dbClient.getPool());
  return repo.getLatestDeployPerStack();
}

async function getAgentClientForHost(hostName: string) {
  const [hosts, { getOpenBaoClient }, { AgentClient }] = await Promise.all([
    getManagedHosts(),
    import('@/lib/clients/openbao-client-factory'),
    import('@/lib/clients/agent-client'),
  ]);
  const host = hosts.find((candidate) => candidate.name === hostName);
  if (!host) throw new Error(`Host "${hostName}" not found in managed_hosts`);
  const baoClient = await getOpenBaoClient();
  const token = await baoClient.getHostSecret(host.name, 'agent_token');
  if (!token) throw new Error(`No agent token found in OpenBao for host "${host.name}"`);
  return new AgentClient({ agentUrl: host.agentUrl, agentToken: token });
}

async function loadRepoStacks(): Promise<RepoStackSnapshot[]> {
  const repoPath = getRepoPath();
  let manifestContent: string;
  try {
    manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
  } catch (err) {
    // A missing manifest means no stacks yet, empty drift state is correct.
    // Rethrow anything else so a corrupt git ODB does not masquerade as
    // "every agent stack is untracked" and invite destructive cleanup.
    if (err instanceof FileNotFoundError) return [];
    console.error('[StackService] loadRepoStacks: failed to read manifest:', err);
    throw err;
  }

  const manifest = parseManifest(manifestContent);
  const entries = await Promise.all(
    Object.entries(manifest.stacks).map(async ([stack, entry]) => {
      let composeContent = '';
      try {
        composeContent = await readFileFromRepo(repoPath, `${stack}/${COMPOSE_FILENAME}`);
      } catch (err) {
        if (!(err instanceof FileNotFoundError)) throw err;
      }

      return {
        stack,
        host: entry.host,
        autoDeploy: entry.autoDeploy,
        composeContent,
        composeHash: computeHash(composeContent),
      } satisfies RepoStackSnapshot;
    }),
  );

  return entries;
}

async function syncRepoStackToAgentCompose(params: {
  stack: string;
  host: string;
  composeContent: string;
}): Promise<{ commitSha: string }> {
  const repoPath = getRepoPath();
  const commitSha = await commitFiles(repoPath, (existingFiles) => {
    const manifestContent = existingFiles.get(MANIFEST_FILENAME);
    const manifest = manifestContent ? parseManifest(manifestContent) : { stacks: {} };
    const existingEntry = manifest.stacks[params.stack];

    // If the stack was created in the repo on a different host since the
    // scan, bail out so we don't silently rewrite the host assignment.
    // The user must re-scan and explicitly pick an action.
    if (existingEntry && existingEntry.host !== params.host) {
      throw new Error(
        `Stack "${params.stack}" already exists in manifest on host "${existingEntry.host}"; refusing to sync from "${params.host}"`,
      );
    }

    manifest.stacks[params.stack] = {
      host: params.host,
      autoDeploy: existingEntry?.autoDeploy ?? false,
    };

    const newManifestContent = yaml.dump(manifest, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: true,
    });

    return {
      files: [
        { path: MANIFEST_FILENAME, content: newManifestContent },
        { path: `${params.stack}/${COMPOSE_FILENAME}`, content: params.composeContent },
      ],
      message: `Sync stack from agent: ${params.stack} on ${params.host}`,
      author: SYSTEM_AUTHOR,
    };
  });

  if (commitSha === null) {
    throw new Error(`Sync produced no commit for stack "${params.stack}"`);
  }
  return { commitSha };
}

export async function scanStackDrift(): Promise<StackDriftReport> {
  const [repoStacks, hosts, latestDeploys] = await Promise.all([
    loadRepoStacks(),
    getManagedHosts(),
    getLatestDeploys(),
  ]);

  const dockerHosts = hosts
    .filter((host) => host.capabilities.docker === true)
    .map((host) => ({ name: host.name, dockerEnabled: true }));

  const agentStacksByHost = new Map<string, AgentStackInventoryEntry[]>();
  const scanErrors: Array<{ host: string; message: string }> = [];

  // Every async path inside MUST report via scanErrors. An uncaught throw
  // here would abort all parallel host scans and we'd lose visibility on
  // hosts that are reachable just because one is not.
  await Promise.all(dockerHosts.map(async (host) => {
    try {
      const agent = await getAgentClientForHost(host.name);
      agentStacksByHost.set(host.name, await agent.getStackInventory());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[StackService] drift scan failed for host "${host.name}":`, err);
      scanErrors.push({ host: host.name, message });
    }
  }));

  return buildStackDriftReport({
    repoStacks,
    hosts: dockerHosts,
    latestDeploys,
    agentStacksByHost,
    scanErrors,
  });
}

export async function resolveStackDrift(input: {
  host: string;
  stack: string;
  resolution: StackDriftResolution;
}): Promise<StackDriftResolutionResult> {
  return resolveStackDriftItem({
    ...input,
    loadCurrentReport: () => scanStackDrift(),
    readRepoStack: async (stack) => {
      const repoStacks = await loadRepoStacks();
      return repoStacks.find((candidate) => candidate.stack === stack) ?? null;
    },
    readAgentCompose: async (host, stack) => {
      try {
        const agent = await getAgentClientForHost(host);
        return await agent.getStackCompose(stack);
      } catch (err) {
        if (err instanceof AgentClientError && err.statusCode === 404) return null;
        throw err;
      }
    },
    triggerDeploy: ({ stack, host, action }) => triggerStackDeploy({ stack, host, action }),
    deleteTrackedStack: (stack, teardown) => deleteStackFromRepo(stack, teardown),
    syncRepoToAgent: syncRepoStackToAgentCompose,
  });
}

export async function updateStackIconSlug(
  stackName: string,
  iconSlug: string,
): Promise<void> {
  const repoPath = getRepoPath();
  if (!repoPath) return;

  const manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
  const manifest = parseManifest(manifestContent);
  const entry = manifest.stacks[stackName];
  if (!entry) return;

  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { EntityMetadataRepository } = await import('@/lib/database/repositories/entity-metadata-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const repo = new EntityMetadataRepository(dbClient.getPool());

  await repo.upsertEntityMetadata(`${entry.host}/${stackName}`, 'icon', iconSlug);
}
