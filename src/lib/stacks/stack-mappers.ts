/**
 * Pure mapping functions for stack data transformations.
 * Separated from stack-service.ts to enable testing without mock.module pollution
 * (stacks.functions.test.ts mocks '@/lib/stacks/stack-service').
 */

import type { StackSummary, StackDetail, StackDeployRecord, SyncStatus } from '@/types/stacks';
import type { DeployAction, DeployRecord, DeployRequest } from '@/lib/deploy/types';
import type { StackEntry } from '@/lib/git/manifest';

/**
 * Compute the sync status of a stack given its latest deploy record and the current HEAD SHA.
 * - No deploy history → 'unknown'
 * - Latest deploy failed → 'failed'
 * - Latest successful/no_change deploy SHA matches HEAD → 'in_sync'
 * - Latest successful/no_change deploy SHA differs from HEAD → 'pending'
 */
export function computeSyncStatus(
  latestDeploy: DeployRecord | null,
  currentHeadSha: string | null,
): SyncStatus {
  if (!latestDeploy) return 'unknown';
  if (latestDeploy.status === 'failed') return 'failed';
  if (latestDeploy.status === 'in_progress') return 'in_progress';
  if (latestDeploy.status === 'pending') return 'pending';
  const isDeployed = latestDeploy.status === 'succeeded' || latestDeploy.status === 'no_change';
  if (isDeployed && latestDeploy.commitSha === currentHeadSha) return 'in_sync';
  if (isDeployed) return 'pending';
  return 'unknown';
}

/** Map a manifest entry to a StackSummary. */
export function manifestEntryToSummary(name: string, entry: StackEntry): StackSummary {
  return {
    name,
    host: entry.host,
    syncStatus: 'unknown',
    deployMode: entry.autoDeploy ? 'auto' : 'manual',
    lastDeployAt: null,
    lastDeployStatus: null,
    containerCount: 0,
    icon: null,
  };
}

/** Map a manifest entry + compose content to a StackDetail. */
export function manifestEntryToDetail(name: string, entry: StackEntry, composeContent: string): StackDetail {
  return {
    name,
    host: entry.host,
    syncStatus: 'unknown',
    deployMode: entry.autoDeploy ? 'auto' : 'manual',
    composeContent,
    lastDeployCommitSha: null,
    currentCommitSha: '',
    variableNames: extractVariableNames(composeContent),
    icon: null,
  };
}

/** Extract ${VAR_NAME} references from compose content (supports all Docker Compose variable forms: ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?err}, ${VAR?err}, ${VAR:+alt}, ${VAR+alt}). */
export function extractVariableNames(content: string): string[] {
  const regex = /\$\{([a-zA-Z_]\w*)(?::?[-?+][^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpMatchArray | null;
  while ((match = regex.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars).sort((a, b) => a.localeCompare(b));
}

/** Convert internal DeployRecord (Date) to API-facing StackDeployRecord (string). */
export function toStackDeployRecord(record: DeployRecord): StackDeployRecord {
  return {
    id: record.id,
    stack: record.stack,
    host: record.host,
    commitSha: record.commitSha,
    envHash: record.envHash,
    status: record.status,
    trigger: record.trigger,
    action: record.action,
    forceRecreate: record.forceRecreate,
    logs: record.logs,
    createdAt: record.createdAt.toISOString(),
  };
}

export interface DeployDeps {
  readCompose: (stack: string) => Promise<string>;
  getCommitSha: () => Promise<string>;
  buildRequest: (input: { stack: string; host: string; composeContent: string; commitSha: string; action: DeployAction; forceRecreate?: boolean }) => DeployRequest;
  executePipeline: (request: DeployRequest) => Promise<{ deployId?: number; logs?: string }>;
}

/** Testable deploy handler: takes deps instead of importing them. */
export async function handleTriggerDeploy(
  deps: DeployDeps,
  params: { stack: string; host: string; action: DeployAction; forceRecreate?: boolean },
): Promise<{ deployId: number }> {
  let composeContent = '';
  try {
    composeContent = await deps.readCompose(params.stack);
  } catch {
    if (params.action === 'deploy') {
      throw new Error(`No compose file found for stack "${params.stack}"`);
    }
  }

  const commitSha = await deps.getCommitSha();

  const request = deps.buildRequest({
    stack: params.stack,
    host: params.host,
    composeContent,
    commitSha,
    action: params.action,
    forceRecreate: params.forceRecreate,
  });

  const result = await deps.executePipeline(request);
  if (result.deployId === undefined) {
    throw new Error(`Deploy could not be queued: ${result.logs}`);
  }
  return { deployId: result.deployId };
}
