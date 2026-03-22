/**
 * Pure mapping functions for stack data transformations.
 * Separated from stack-service.ts to enable testing without mock.module pollution
 * (stacks.functions.test.ts mocks '@/lib/stacks/stack-service').
 */

import type { StackSummary, StackDetail, StackDeployRecord } from '@/types/stacks';
import type { DeployRecord, DeployRequest } from '@/lib/deploy/types';
import type { StackEntry } from '@/lib/git/manifest';

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

/** Extract ${VAR_NAME} references from compose content. Handles all Docker Compose operators: :-, -, :+, +, :?, ? */
export function extractVariableNames(content: string): string[] {
  const regex = /\$\{([a-zA-Z_][a-zA-Z0-9_]*)(?::?[-+?][^}]*)?\}/g;
  const vars = new Set<string>();
  let match: RegExpMatchArray | null;
  while ((match = regex.exec(content)) !== null) {
    vars.add(match[1]);
  }
  return Array.from(vars).sort();
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
    logs: record.logs,
    createdAt: record.createdAt.toISOString(),
  };
}

export interface DeployDeps {
  readCompose: (stack: string) => Promise<string>;
  getCommitSha: () => Promise<string>;
  buildRequest: (input: { stack: string; host: string; composeContent: string; commitSha: string; action: 'deploy' | 'teardown' | 'restart' }) => DeployRequest;
  executePipeline: (request: DeployRequest) => Promise<{ deployId?: number }>;
}

/** Testable deploy handler — takes deps instead of importing them. */
export async function handleTriggerDeploy(
  deps: DeployDeps,
  params: { stack: string; host: string; action: 'deploy' | 'teardown' | 'restart' },
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
  });

  const result = await deps.executePipeline(request);
  return { deployId: result.deployId ?? 0 };
}
