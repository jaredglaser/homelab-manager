/**
 * Stack service — integration layer between git management and deploy pipeline.
 * Called by server functions in src/data/stacks.functions.tsx.
 *
 * TODO: Wire up to actual git repo operations and deploy pipeline.
 * For now, returns stub data so the UI compiles and can be developed against.
 */

import type { StackSummary, StackDetail, DeployRecord } from '@/types/stacks';

export async function getStackSummaries(): Promise<StackSummary[]> {
  // TODO: Read manifest from git repo, cross-reference deploy_history
  return [];
}

export async function getStackDetailByName(
  _stackName: string,
): Promise<StackDetail | null> {
  // TODO: Read compose file from git repo, extract variables
  return null;
}

export async function triggerStackDeploy(params: {
  stack: string;
  host: string;
  action: 'deploy' | 'teardown' | 'restart';
}): Promise<{ deployId: number }> {
  // TODO: Build DeployRequest via UITriggerBuilder, execute pipeline
  console.error(`[StackService] Deploy requested: ${params.action} ${params.stack} on ${params.host}`);
  return { deployId: 0 };
}

export async function getStackDeployHistory(
  _stackName: string,
  _limit: number,
): Promise<DeployRecord[]> {
  // TODO: Query deploy_history table via DeployRepository
  return [];
}

export async function saveStackComposeFile(
  _stackName: string,
  _content: string,
): Promise<{ commitSha: string }> {
  // TODO: Use saveAndCommitFile from editor-operations
  return { commitSha: 'stub' };
}

export async function updateStackIconSlug(
  _stackName: string,
  _iconSlug: string,
): Promise<void> {
  // TODO: Store icon in entity_metadata
}
