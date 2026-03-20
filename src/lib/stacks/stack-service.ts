/**
 * Stack service — integration layer between git management and deploy pipeline.
 * Called by server functions in src/data/stacks.functions.tsx.
 */

import type { StackSummary, StackDetail, StackDeployRecord } from '@/types/stacks';
import { loadGitConfig } from '@/lib/config/git-config';
import { readFileFromRepo } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';

export async function getStackSummaries(): Promise<StackSummary[]> {
  try {
    const gitConfig = loadGitConfig();
    if (!gitConfig.enabled) {
      return [];
    }

    let manifestContent: string;
    try {
      manifestContent = await readFileFromRepo(gitConfig.repoPath, 'manifest.yaml');
    } catch {
      // Repo has no commits or manifest.yaml doesn't exist yet
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
): Promise<StackDeployRecord[]> {
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
