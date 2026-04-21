/**
 * Stack service: integration layer between git management and deploy pipeline.
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
import { resolveDeleteStack, type DeleteStackResult } from '@/lib/stacks/delete-stack-resolver';

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
