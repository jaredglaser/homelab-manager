/**
 * Stack service: integration layer between git management and deploy pipeline.
 * Called by server functions in src/data/stacks/functions.tsx.
 */

import type {
  StackSummary,
  StackDetail,
  StackDeployRecord,
  StackDriftItem,
  StackDriftKind,
  StackDriftReport,
  StackDriftResolution,
  StackDriftResolutionResult,
  StackDriftScanError,
} from '@/types/stacks';
import type { DeployAction, DeployRecord, DeployRequest, DeployStatus } from '@/lib/deploy/types';
import type { AgentClient, StackControlRequest } from '@/lib/clients/agent-client';
import type { AgentStackInventoryEntry, AgentStackInventoryError } from '@homelab-manager/agent/types';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import type { RepoStackSnapshot } from '@/lib/stacks/stack-drift-service';
import { loadGitConfig } from '@/lib/config/git-config';
import { readFileFromRepo, commitFiles, FileNotFoundError } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';
import { saveAndCommitFile } from '@/lib/git/editor-operations';
import { MANIFEST, composePath, driftRecoveryPath, serializeManifest } from '@/lib/stacks/stack-repo-layout';
import { createStackRepoWriter } from '@/lib/deploy/stack-repo-writer';
import {
  manifestEntryToSummary,
  manifestEntryToDetail,
  toStackDeployRecord,
  handleTriggerDeploy,
  computeSyncStatus,
} from '@/lib/stacks/stack-mappers';
import { resolveDeleteStack, type DeleteStackResult } from '@/lib/stacks/delete-stack-resolver';

/** Safe path segment: allows only alphanumeric, hyphen, and underscore. Used to validate stack names and secret keys. */
export const SAFE_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Re-exported alongside service layer for consistent mock.module() targeting in tests. */
export { resolveDeleteStack } from '@/lib/stacks/delete-stack-resolver';
export type { DeleteStackDeps, DeleteStackResult } from '@/lib/stacks/delete-stack-resolver';

const SYSTEM_AUTHOR = { name: 'homelab-manager', email: 'homelab-manager@localhost' };

function getRepoPath(): string {
  const config = loadGitConfig();
  return config.repoPath;
}

export async function getStackSummaries(): Promise<StackSummary[]> {
  const repoPath = getRepoPath();

  let manifestContent: string;
  try {
    manifestContent = await readFileFromRepo(repoPath, MANIFEST);
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
    const manifestContent = await readFileFromRepo(repoPath, MANIFEST);
    const manifest = parseManifest(manifestContent);
    const entry = manifest.stacks[stackName];
    if (!entry) return null;

    let composeContent = '';
    try {
      composeContent = await readFileFromRepo(repoPath, composePath(stackName));
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
  action: DeployAction;
  commitSha?: string;
  forceRecreate?: boolean;
  postSuccess?: 'removeFromManifest';
}): Promise<{ deployId: number; status: DeployStatus; logs: string }> {
  const repoPath = getRepoPath();

  const { default: git } = await import('isomorphic-git');
  const fs = await import('node:fs');
  const { createDeployPipeline } = await import('@/lib/deploy/pipeline-factory');

  const { pipeline } = await createDeployPipeline();

  if (params.commitSha) {
    // Rollback is always a full deploy with forceRecreate, regardless of the original action.
    const rollbackSha = params.commitSha;
    return handleTriggerDeploy({
      readCompose: (stack) =>
        readFileFromRepo(repoPath, composePath(stack), rollbackSha),
      getCommitSha: () => Promise.resolve(rollbackSha),
      buildRequest: (input): DeployRequest => ({
        stack: input.stack,
        host: input.host,
        composeContent: input.composeContent,
        commitSha: input.commitSha,
        envContent: '',
        action: 'deploy',
        trigger: 'manual_rollback',
        autoApproved: true,
        forceRecreate: true,
      }),
      executePipeline: (request) => pipeline.execute(request),
    }, params);
  }

  return handleTriggerDeploy({
    readCompose: (stack) => readFileFromRepo(repoPath, composePath(stack)),
    getCommitSha: () => git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' }),
    buildRequest: (input): DeployRequest => {
      const base = {
        stack: input.stack,
        host: input.host,
        commitSha: input.commitSha,
        trigger: 'ui' as const,
        autoApproved: true,
        ...(params.postSuccess ? { postSuccess: params.postSuccess } : {}),
      };
      if (input.action === 'deploy') {
        return { ...base, action: 'deploy', composeContent: input.composeContent, envContent: '', forceRecreate: input.forceRecreate ?? false };
      }
      if (input.action === 'update') {
        return { ...base, action: 'update', composeContent: input.composeContent, envContent: '' };
      }
      return { ...base, action: input.action };
    },
    executePipeline: (request) => pipeline.execute(request),
  }, params);
}

/**
 * Approve a pending deploy and run it through the pipeline's `resumePending` path.
 * Rebuilds the `DeployRequest` from the stored deploy record, reading the compose
 * file at the record's commitSha so the exact configuration that was pending is what gets deployed.
 */
export async function resumePendingDeploy(deployId: number): Promise<{ deployId: number; status: DeployStatus; logs: string }> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');
  const { createDeployPipeline } = await import('@/lib/deploy/pipeline-factory');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const pool = dbClient.getPool();
  const deployRepo = new DeployRepository(pool);
  const hostsRepo = new HostRepository(pool);

  const deploy = await deployRepo.getById(deployId);
  if (!deploy) throw new Error(`Deploy ${deployId} not found`);
  if (deploy.status !== 'pending') {
    throw new Error(`Deploy is not pending (status: ${deploy.status})`);
  }

  const host = await hostsRepo.findByName(deploy.host);
  if (!host) throw new Error(`Host "${deploy.host}" not found in managed_hosts`);

  // Rebuild the DeployRequest. For deploy action we need compose content; read it
  // from the commit the pending deploy was recorded against so what we approve
  // is exactly what was pending.
  const request = await buildRequestFromDeployRecord(deploy);

  const { pipeline } = await createDeployPipeline();
  const result = await pipeline.resumePending(deployId, host, request);
  // resumePending returns failed (instead of throwing) when claimPending loses a
  // race or the dispatch fails. The caller toasts the outcome from the returned
  // status rather than treating every non-throw as success.
  return { deployId: result.deployId ?? deployId, status: result.status, logs: result.logs };
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
    throw new Error(`Deploy ${deployId} is no longer pending (approved or rejected by another client)`);
  }
  try {
    await deployRepo.notifyStackChange(deploy.stack, deploy.host, {
      deployId,
      status: 'failed',
      action: deploy.action,
      trigger: deploy.trigger,
      message: 'Manually rejected',
    });
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

  if (deploy.action === 'deploy' || deploy.action === 'update') {
    const repoPath = getRepoPath();
    let composeContent = '';
    try {
      composeContent = await readFileFromRepo(
        repoPath,
        composePath(deploy.stack),
        deploy.commitSha,
      );
    } catch (err) {
      if (!(err instanceof FileNotFoundError)) throw err;
      console.warn(`[stack-service] compose file not found for deploy ${deploy.id}, proceeding with empty content`);
    }
    if (deploy.action === 'update') {
      return { ...base, action: 'update', composeContent, envContent: '' };
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

  const manifestContent = await readFileFromRepo(repoPath, MANIFEST);
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
    filePath: composePath(stackName),
    content,
    author: SYSTEM_AUTHOR,
    message: `Update ${composePath(stackName)}`,
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
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const hostsRepo = new HostRepository(dbClient.getPool());
  const managedHost = await hostsRepo.findByName(host);
  if (!managedHost) throw new Error(`Host "${host}" not found in managed_hosts`);

  const commitSha = await commitFiles(repoPath, (existingFiles) => {
    const manifestContent = existingFiles.get(MANIFEST);
    const manifest = manifestContent ? parseManifest(manifestContent) : { stacks: {} };

    if (manifest.stacks[stackName]) {
      throw new Error(`Stack "${host}/${stackName}" already exists`);
    }

    manifest.stacks[stackName] = { host, autoDeploy };

    return {
      files: [
        { path: composePath(stackName), content: '' },
        { path: MANIFEST, content: serializeManifest(manifest) },
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

  const manifestContent = await readFileFromRepo(repoPath, MANIFEST);
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
    throw new Error(`Stack "${host}/${stackName}" has an active deploy in progress, cannot delete`);
  }

  return resolveDeleteStack(stackName, host, teardown, {
    triggerDeploy: (params) => triggerStackDeploy(params),
    // Same implementation the async teardown path uses (stack-repo-writer.ts):
    // one remove-stack-from-manifest sequence for both delete paths.
    commitRemoveFromManifest: (sn) => createStackRepoWriter().removeStackFromManifest(sn),
  });
}

export async function getManagedHostNames(): Promise<string[]> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const hostsRepo = new HostRepository(dbClient.getPool());
  const hosts = await hostsRepo.findAll();
  return hosts.map((h) => h.name);
}

async function dispatchControlAction(
  agent: AgentClient,
  action: 'start' | 'stop' | 'restart',
  req: StackControlRequest,
): Promise<{ success: boolean; logs: string }> {
  switch (action) {
    case 'start':   return agent.start(req);
    case 'stop':    return agent.stop(req);
    case 'restart': return agent.restart(req);
    default: {
      const _exhaustive: never = action;
      throw new Error(`Unknown action: ${_exhaustive}`);
    }
  }
}

/**
 * Build an AgentClient for a host, signing requests with that host's Ed25519
 * private key decrypted from `agent_keypairs` via the master keyring.
 */
async function getAgentClientForHost(host: string): Promise<AgentClient> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');
  const { AgentClient } = await import('@/lib/clients/agent-client');
  const { AgentKeypairsRepository } = await import('@/lib/database/repositories/agent-keypairs-repository');
  const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');

  const dbConfig = loadDatabaseConfig();
  const dbClient = await databaseConnectionManager.getClient(dbConfig);
  const pool = dbClient.getPool();

  const hostsRepo = new HostRepository(pool);
  const managedHost = await hostsRepo.findByName(host);
  if (!managedHost) throw new Error(`Host "${host}" not found in managed_hosts`);

  const keyring = await loadMasterKeyring();
  const agentKeypairs = new AgentKeypairsRepository(pool, keyring);
  const privateKey = await agentKeypairs.getPrivateKeyForHost(managedHost.name);
  if (!privateKey) throw new Error(`No agent keypair for host "${managedHost.name}". Re-enroll the agent.`);

  const signer = () => signAgentJwt(privateKey, managedHost.name);
  return new AgentClient({ agentUrl: managedHost.agentUrl, signer });
}

export async function controlStackForHost(
  host: string,
  action: 'start' | 'stop' | 'restart',
  req: StackControlRequest,
): Promise<void> {
  const agent = await getAgentClientForHost(host);

  let result: { success: boolean; logs: string };
  try {
    result = await dispatchControlAction(agent, action, req);
  } catch (err) {
    console.error(`[StackService] controlStack ${action} failed for "${req.stack}" on "${host}":`, err);
    throw err;
  }
  if (!result.success) {
    const msg = `docker compose ${action} failed: ${result.logs}`;
    console.error(`[StackService] ${msg} (host: ${host})`);
    throw new Error(msg);
  }
}

async function loadRepoStacks(): Promise<RepoStackSnapshot[]> {
  const repoPath = getRepoPath();
  let manifestContent: string;
  try {
    manifestContent = await readFileFromRepo(repoPath, MANIFEST);
  } catch (err) {
    // A missing manifest means there are no stacks yet. Rethrow anything else so
    // a corrupt git ODB cannot masquerade as "every agent stack is untracked".
    if (err instanceof FileNotFoundError) return [];
    console.error('[StackService] loadRepoStacks: failed to read manifest:', err);
    throw err;
  }

  const manifest = parseManifest(manifestContent);
  const { computeHash } = await import('@/lib/deploy/change-detection');

  return Promise.all(
    Object.entries(manifest.stacks).map(async ([stack, entry]) => {
      let composeContent = '';
      try {
        composeContent = await readFileFromRepo(repoPath, composePath(stack));
      } catch (err) {
        if (!(err instanceof FileNotFoundError)) throw err;
      }

      return {
        stack,
        host: entry.host,
        autoDeploy: entry.autoDeploy,
        composeHash: computeHash(composeContent),
      } satisfies RepoStackSnapshot;
    }),
  );
}

interface DriftScanInputs {
  repoStacks: RepoStackSnapshot[];
  hosts: ManagedHost[];
  latestDeploys: DeployRecord[];
  currentHeadSha: string | null;
}

async function loadDriftScanInputs(): Promise<DriftScanInputs> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { DeployRepository } = await import('@/lib/database/repositories/deploy-repository');
  const { HostRepository } = await import('@/lib/database/repositories/host-repository');
  const { default: git } = await import('isomorphic-git');
  const fs = await import('node:fs');

  const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
  const pool = dbClient.getPool();

  const [repoStacks, hosts, latestDeploys, currentHeadSha] = await Promise.all([
    loadRepoStacks(),
    new HostRepository(pool).findAll(),
    new DeployRepository(pool).getLatestDeployPerStack(),
    git.resolveRef({ fs, gitdir: getRepoPath(), ref: 'HEAD' }).catch(() => null),
  ]);

  return { repoStacks, hosts, latestDeploys, currentHeadSha };
}

/**
 * Compare the repo manifest against each Docker host's on-disk stack inventory.
 * Read-only: one agent inventory call per host, no writes anywhere.
 */
export async function scanStackDrift(): Promise<StackDriftReport> {
  const { buildStackDriftReport } = await import('@/lib/stacks/stack-drift-service');
  const { repoStacks, hosts, latestDeploys, currentHeadSha } = await loadDriftScanInputs();

  const dockerHosts = hosts
    .filter((host) => host.capabilities.docker === true)
    .map((host) => ({ name: host.name, dockerEnabled: true }));

  const agentStacksByHost = new Map<string, AgentStackInventoryEntry[]>();
  const agentStackErrorsByHost = new Map<string, AgentStackInventoryError[]>();
  const scanErrors: StackDriftScanError[] = [];

  const dockerHostNames = new Set(dockerHosts.map((host) => host.name));
  for (const repoHost of new Set(repoStacks.map((stack) => stack.host))) {
    if (!dockerHostNames.has(repoHost)) {
      scanErrors.push({ host: repoHost, message: 'Host is not managed or is not Docker-capable; drift scan skipped.' });
    }
  }

  // Every path inside must report through scanErrors: an uncaught throw would
  // abort the other host scans and lose visibility on hosts that are reachable.
  await Promise.all(dockerHosts.map(async (host) => {
    try {
      const agent = await getAgentClientForHost(host.name);
      const inventory = await agent.getStackInventory();
      agentStacksByHost.set(host.name, inventory.stacks);
      if (inventory.errors.length > 0) agentStackErrorsByHost.set(host.name, inventory.errors);
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
    currentHeadSha,
    agentStacksByHost,
    agentStackErrorsByHost,
    scanErrors,
  });
}

/**
 * Re-classify drift for one stack on one host. Runs the same
 * `buildStackDriftReport` gate the full scan runs, so a resolution can never act
 * on a stack the scan would not report as drifted.
 */
async function rescanDriftItem(
  agent: AgentClient,
  host: string,
  stack: string,
): Promise<StackDriftItem | null> {
  const { buildStackDriftReport } = await import('@/lib/stacks/stack-drift-service');
  const [{ repoStacks, hosts, latestDeploys, currentHeadSha }, inventory] = await Promise.all([
    loadDriftScanInputs(),
    agent.getStackInventory(),
  ]);

  const managedHost = hosts.find((entry) => entry.name === host);
  if (!managedHost || managedHost.capabilities.docker !== true) {
    throw new Error(`Host "${host}" is not a Docker-capable managed host.`);
  }

  const report = buildStackDriftReport({
    repoStacks: repoStacks.filter((entry) => entry.host === host),
    hosts: [{ name: host, dockerEnabled: true }],
    latestDeploys,
    currentHeadSha,
    agentStacksByHost: new Map([[host, inventory.stacks]]),
    agentStackErrorsByHost: new Map([[host, inventory.errors]]),
    scanErrors: [],
  });

  const unreadable = report.scanErrors.find((error) => error.stack === stack);
  if (unreadable) {
    throw new Error(
      `The agent on "${host}" could not read "${host}/${stack}": ${unreadable.message}. Refresh the drift scan and retry.`,
    );
  }

  return report.items.find((item) => item.stack === stack) ?? null;
}

/**
 * Commit the host's copy of a compose file into the repo before a resolution
 * destroys it. Every failure here throws, and every caller awaits it before the
 * destructive step, so a failed capture aborts the resolution with the host
 * untouched.
 */
async function captureAgentCompose(
  agent: AgentClient,
  host: string,
  stack: string,
  kind: StackDriftKind,
  resolution: StackDriftResolution,
): Promise<string> {
  const capturedAt = new Date().toISOString();
  try {
    const { composeContent } = await agent.getStackCompose(stack);
    if (!composeContent.trim()) {
      throw new Error('The agent returned an empty compose file, so there is nothing to recover from.');
    }
    return await commitFiles(getRepoPath(), () => ({
      files: [{ path: driftRecoveryPath(host, stack, capturedAt), content: composeContent }],
      message: `Archive ${host}/${stack} compose before ${resolution} of ${kind} drift (${capturedAt})`,
      author: SYSTEM_AUTHOR,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[StackService] drift capture failed for "${host}/${stack}":`, err);
    throw new Error(
      `Could not archive the host copy of "${host}/${stack}"; ${resolution} aborted and the host was left untouched. ${message}`,
      { cause: err },
    );
  }
}

async function adoptAgentCompose(
  agent: AgentClient,
  host: string,
  stack: string,
  kind: StackDriftKind,
): Promise<string> {
  const { composeContent } = await agent.getStackCompose(stack);

  return commitFiles(getRepoPath(), (existingFiles) => {
    const manifestContent = existingFiles.get(MANIFEST);
    const manifest = manifestContent ? parseManifest(manifestContent) : { stacks: {} };
    manifest.stacks[stack] = manifest.stacks[stack] ?? { host, autoDeploy: false };

    return {
      files: [
        { path: composePath(stack), content: composeContent },
        { path: MANIFEST, content: serializeManifest(manifest) },
      ],
      message: `Adopt ${host}/${stack} compose from the host (${kind} drift)`,
      author: SYSTEM_AUTHOR,
    };
  });
}

async function teardownOnAgent(
  agent: AgentClient,
  host: string,
  stack: string,
  recoveryCommitSha: string,
): Promise<void> {
  const result = await agent.teardown(stack);
  if (!result.success) {
    throw new Error(
      `docker compose down failed for "${host}/${stack}"; the host may be partly torn down, and re-running this resolution is safe. The host copy is archived in ${recoveryCommitSha.slice(0, 7)}. ${result.logs}`,
    );
  }
}

async function deployAfterCapture(
  host: string,
  stack: string,
  recoveryCommitSha: string,
): Promise<{ deployId: number; status: DeployStatus; logs: string }> {
  try {
    return await triggerStackDeploy({ stack, host, action: 'deploy', forceRecreate: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[StackService] drift redeploy failed for "${host}/${stack}":`, err);
    throw new Error(
      `Could not start the redeploy of "${host}/${stack}"; the host compose file may already be overwritten, and re-running this resolution is safe. The host copy is archived in ${recoveryCommitSha.slice(0, 7)}. ${message}`,
      { cause: err },
    );
  }
}

const EMPTY_RESOLUTION = {
  recoveryCommitSha: null,
  commitSha: null,
  deployId: null,
  deployStatus: null,
} satisfies Omit<StackDriftResolutionResult, 'host' | 'stack' | 'kind' | 'resolution'>;

/**
 * Apply a resolution to a single drifted stack.
 *
 * Re-scans before acting so a stale click from an old report cannot drive a
 * destructive resolution against state that has since changed, and archives the
 * host's compose into the repo before any step that would otherwise leave it
 * unrecoverable (`untracked` teardown, `content` overwrite).
 */
export async function resolveStackDriftItem(input: {
  host: string;
  stack: string;
  kind: StackDriftKind;
  resolution: StackDriftResolution;
}): Promise<StackDriftResolutionResult> {
  const { host, stack, kind, resolution } = input;

  if (!SAFE_PATH_SEGMENT_PATTERN.test(stack)) {
    throw new Error(`Invalid stack name "${stack}": must contain only letters, numbers, hyphens, and underscores`);
  }

  const agent = await getAgentClientForHost(host);
  const current = await rescanDriftItem(agent, host, stack);

  if (!current) {
    throw new Error(`"${host}/${stack}" is no longer drifted. Refresh the drift scan and retry.`);
  }
  if (current.kind !== kind) {
    throw new Error(
      `"${host}/${stack}" drift changed from ${kind} to ${current.kind} since the scan. Refresh the drift scan and retry.`,
    );
  }

  const base = { host, stack, kind, resolution };

  if (kind === 'ghost' && resolution === 'trust_repo') {
    const deploy = await triggerStackDeploy({ stack, host, action: 'deploy' });
    return { ...base, ...EMPTY_RESOLUTION, deployId: deploy.deployId, deployStatus: deploy.status };
  }

  if (kind === 'ghost' && resolution === 'trust_agent') {
    const { commitSha } = await createStackRepoWriter().removeStackFromManifest(stack);
    return { ...base, ...EMPTY_RESOLUTION, commitSha };
  }

  if (kind !== 'ghost' && resolution === 'trust_agent') {
    return { ...base, ...EMPTY_RESOLUTION, commitSha: await adoptAgentCompose(agent, host, stack, kind) };
  }

  // `trust_repo` and `remove` are the same operation on an untracked stack: the
  // repo tracks no version to restore, so trusting it means the stack should not run.
  if (kind === 'untracked') {
    const recoveryCommitSha = await captureAgentCompose(agent, host, stack, kind, resolution);
    await teardownOnAgent(agent, host, stack, recoveryCommitSha);
    return { ...base, ...EMPTY_RESOLUTION, recoveryCommitSha };
  }

  if (resolution === 'remove') {
    throw new Error(`Resolution "remove" does not apply to ${kind} drift on "${host}/${stack}".`);
  }

  const recoveryCommitSha = await captureAgentCompose(agent, host, stack, kind, resolution);
  const deploy = await deployAfterCapture(host, stack, recoveryCommitSha);
  return { ...base, ...EMPTY_RESOLUTION, recoveryCommitSha, deployId: deploy.deployId, deployStatus: deploy.status };
}
