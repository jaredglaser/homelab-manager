import type { StackRepoWriter } from '@/lib/deploy/pipeline';
import { loadGitConfig } from '@/lib/config/git-config';
import { commitFiles } from '@/lib/git/repo';
import { removeStackFromManifest as buildRemoveStackFromManifestPlan } from '@/lib/stacks/stack-repo-layout';

/**
 * Create a StackRepoWriter backed by the configured git repo.
 * Idempotent per stack: if the stack is already absent from the manifest and
 * its files are gone, the commit becomes a no-op.
 */
export function createStackRepoWriter(): StackRepoWriter {
  return {
    async removeStackFromManifest(stackName: string): Promise<{ commitSha: string }> {
      const { repoPath } = loadGitConfig();
      const commitSha = await commitFiles(repoPath, buildRemoveStackFromManifestPlan(stackName));
      return { commitSha };
    },
  };
}
