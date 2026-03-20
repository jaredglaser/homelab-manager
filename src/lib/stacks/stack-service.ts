/**
 * Stack service — integration layer between git management and deploy pipeline.
 * Called by server functions in src/data/stacks.functions.tsx.
 */

import type { StackSummary, StackDetail, StackDeployRecord } from '@/types/stacks';
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
  // TODO: Build DeployRequest via UITriggerBuilder, dispatch to agent
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
  _stackName: string,
  _iconSlug: string,
): Promise<void> {
  // TODO: Store icon in entity_metadata
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
