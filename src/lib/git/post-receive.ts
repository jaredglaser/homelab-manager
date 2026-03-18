import { diffCommits, readFileFromRepo } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';

export interface DeployRequest {
  stack: string;
  host: string;
  composePath: string;
  commitSha: string;
  secrets: Record<string, string>;
  action: 'deploy' | 'teardown' | 'restart';
  autoApproved: boolean;
}

/**
 * Extract unique top-level directory names from changed file paths.
 * Root-level files (no `/`) are ignored -- only stack directories matter.
 */
export function identifyChangedStacks(changedFiles: string[]): string[] {
  const stacks = new Set<string>();

  for (const filePath of changedFiles) {
    const parts = filePath.split('/');
    if (parts.length >= 2) {
      stacks.add(parts[0]);
    }
  }

  return Array.from(stacks).sort();
}

/**
 * After a push, diff the commits, parse the manifest, and build deploy requests
 * for each changed stack that exists in the manifest.
 */
export async function buildDeployRequests(
  repoPath: string,
  fromOid: string,
  toOid: string,
): Promise<DeployRequest[]> {
  const changedFiles = await diffCommits(repoPath, fromOid, toOid);
  const changedStacks = identifyChangedStacks(changedFiles);

  if (changedStacks.length === 0) {
    return [];
  }

  const manifestContent = await readFileFromRepo(repoPath, 'manifest.yaml', toOid);
  const manifest = parseManifest(manifestContent);

  const requests: DeployRequest[] = [];

  for (const stackName of changedStacks) {
    const stackConfig = manifest.stacks[stackName];
    if (!stackConfig) {
      console.info(`[PostReceive] Stack "${stackName}" changed but not in manifest — skipping`);
      continue;
    }

    requests.push({
      stack: stackName,
      host: stackConfig.host,
      composePath: `${stackName}/docker-compose.yml`,
      commitSha: toOid,
      secrets: {},
      action: 'deploy',
      autoApproved: stackConfig.auto_deploy,
    });
  }

  return requests;
}
