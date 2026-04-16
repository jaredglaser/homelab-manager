/**
 * Stack service — integration layer between git management and deploy pipeline.
 * Called by server functions in src/data/stacks/functions.tsx.
 */

import type { StackSummary, StackDetail, StackDeployRecord } from '@/types/stacks';
import { loadGitConfig } from '@/lib/config/git-config';
import { readFileFromRepo, commitFiles, FileNotFoundError } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';
import { saveAndCommitFile } from '@/lib/git/editor-operations';
import yaml from 'js-yaml';
import { SAFE_PATH_SEGMENT_PATTERN } from '@/lib/constants/openbao';
import {
  manifestEntryToSummary,
  manifestEntryToDetail,
  toStackDeployRecord,
  handleTriggerDeploy,
  computeSyncStatus,
} from '@/lib/stacks/stack-mappers';
import { teardownAndAwaitWithDeps } from '@/lib/stacks/teardown-poller';

const COMPOSE_FILENAME = 'docker-compose.yml';
const MANIFEST_FILENAME = 'manifest.yaml';
const SYSTEM_AUTHOR = { name: 'homelab-manager', email: 'homelab-manager@localhost' };

function getRepoPath(): string {
  const config = loadGitConfig();
  return config.repoPath;
}

/** Trigger teardown and poll until it reaches a terminal status. */
async function teardownAndAwait(
  stackName: string,
  host: string,
  deployRepo: { getById: (id: number) => Promise<{ status: string; logs?: string | null } | null> },
): Promise<void> {
  return teardownAndAwaitWithDeps(stackName, host, {
    deployRepo,
    triggerDeploy: (params) => triggerStackDeploy(params),
  });
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
    buildRequest: (input) => builder.build(input),
    executePipeline: (request) => pipeline.execute(request),
  }, params);
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
    throw new Error(`Invalid stack name "${stackName}" — must contain only letters, numbers, hyphens, and underscores`);
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

  // Read manifest and validate stack doesn't already exist
  let manifest: ReturnType<typeof parseManifest>;
  try {
    const manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
    manifest = parseManifest(manifestContent);
  } catch (err: unknown) {
    if (err instanceof FileNotFoundError) {
      // No manifest yet — start with empty stacks
      manifest = { stacks: {} };
    } else {
      throw err;
    }
  }

  if (manifest.stacks[stackName]) {
    throw new Error(`Stack "${stackName}" already exists`);
  }

  // Build updated manifest
  manifest.stacks[stackName] = { host, autoDeploy };
  const newManifestContent = yaml.dump(manifest, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: true,
  });

  // Atomic commit: empty compose file + updated manifest
  const commitSha = await commitFiles(repoPath, {
    files: [
      { path: `${stackName}/${COMPOSE_FILENAME}`, content: '' },
      { path: MANIFEST_FILENAME, content: newManifestContent },
    ],
    message: `Add stack: ${stackName} on ${host}`,
    author: SYSTEM_AUTHOR,
  });

  return { commitSha };
}

export async function deleteStackFromRepo(
  stackName: string,
  teardown: boolean,
): Promise<{ commitSha: string }> {
  const repoPath = getRepoPath();

  // Read manifest to get host for this stack
  const manifestContent = await readFileFromRepo(repoPath, MANIFEST_FILENAME);
  const manifest = parseManifest(manifestContent);
  const entry = manifest.stacks[stackName];
  if (!entry) throw new Error(`Stack "${stackName}" not found in manifest`);

  const { host } = entry;

  // Check for active deploys
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');
  const { StackStatusRepository } = await import('@/lib/database/repositories/stack-status-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const pool = dbClient.getPool();

  const deployRepo = new DeployRepository(pool);
  const hasActive = await deployRepo.hasActiveDeployForStack(stackName, host);
  if (hasActive) {
    throw new Error(`Stack "${stackName}" has an active deploy in progress — cannot delete`);
  }

  if (teardown) {
    await teardownAndAwait(stackName, host, deployRepo);
  }

  // Remove stack from manifest
  delete manifest.stacks[stackName];
  const newManifestContent = yaml.dump(manifest, {
    indent: 2,
    lineWidth: -1,
    noRefs: true,
    sortKeys: true,
  });

  // Get all files in the stack directory to remove them
  let stackFiles: string[];
  try {
    stackFiles = await (await import('@/lib/git/repo')).listFilesInRepo(repoPath, stackName);
  } catch (err: unknown) {
    if (err instanceof FileNotFoundError || (err instanceof Error && err.message.includes('Could not resolve'))) {
      stackFiles = [];
    } else {
      throw err;
    }
  }

  // Atomic commit: remove stack files + update manifest
  const commitSha = await commitFiles(repoPath, {
    files: [{ path: MANIFEST_FILENAME, content: newManifestContent }],
    filesToDelete: stackFiles,
    message: `Remove stack: ${stackName}`,
    author: SYSTEM_AUTHOR,
  });

  // Delete stack_status row (best-effort — don't block the delete on this)
  try {
    const statusRepo = new StackStatusRepository(pool);
    await statusRepo.deleteByStackHost(stackName, host);
  } catch (err) {
    console.error(`[StackService] Failed to delete stack_status row for "${stackName}" on "${host}":`, err);
  }

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
  const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const repo = new StatsRepository(dbClient.getPool());

  await repo.upsertEntityMetadata('docker', `${entry.host}/${stackName}`, 'icon', iconSlug);
}
