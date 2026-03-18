import type { StackSummary, StackDetail, StackDeployRecord } from '@/types/stacks';

/** List all stacks from the manifest with current sync status. */
export async function getStackSummaries(): Promise<StackSummary[]> {
  // TODO: read manifest via isomorphic-git, cross-reference deploy_history
  throw new Error('Not implemented: getStackSummaries');
}

/** Get full detail for a single stack by name. */
export async function getStackDetailByName(stackName: string): Promise<StackDetail | null> {
  void stackName;
  // TODO: read compose file + variables from git repo
  throw new Error('Not implemented: getStackDetailByName');
}

/** Trigger a deploy, teardown, or restart for a stack. */
export async function triggerStackDeploy(params: {
  stack: string;
  host: string;
  action: 'deploy' | 'teardown' | 'restart';
}): Promise<{ deployId: number }> {
  void params;
  // TODO: insert deploy_history row, dispatch to agent
  throw new Error('Not implemented: triggerStackDeploy');
}

/** Get deploy history for a stack. */
export async function getStackDeployHistory(
  stackName: string,
  limit: number,
): Promise<StackDeployRecord[]> {
  void stackName;
  void limit;
  // TODO: query deploy_history table
  throw new Error('Not implemented: getStackDeployHistory');
}

/** Save compose file content (creates a git commit). */
export async function saveStackComposeFile(
  stackName: string,
  content: string,
): Promise<{ commitSha: string }> {
  void stackName;
  void content;
  // TODO: write file, commit via isomorphic-git
  throw new Error('Not implemented: saveStackComposeFile');
}

/** Update the icon slug for a stack. */
export async function updateStackIconSlug(stackName: string, iconSlug: string): Promise<void> {
  void stackName;
  void iconSlug;
  // TODO: update manifest metadata
  throw new Error('Not implemented: updateStackIconSlug');
}
