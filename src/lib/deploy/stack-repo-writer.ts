import yaml from 'js-yaml';
import type { StackRepoWriter } from '@/lib/deploy/pipeline';
import { loadGitConfig } from '@/lib/config/git-config';
import { commitFiles } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';

const MANIFEST_FILENAME = 'manifest.yaml';
const SYSTEM_AUTHOR = { name: 'homelab-manager', email: 'homelab-manager@localhost' };

/**
 * Create a StackRepoWriter backed by the configured git repo.
 * Idempotent per stack: if the stack is already absent from the manifest and
 * its files are gone, the commit becomes a no-op.
 */
export function createStackRepoWriter(): StackRepoWriter {
  return {
    async removeStackFromManifest(stackName: string): Promise<{ commitSha: string }> {
      const { repoPath } = loadGitConfig();
      const commitSha = await commitFiles(repoPath, (existingFiles) => {
        const manifestContent = existingFiles.get(MANIFEST_FILENAME);
        if (manifestContent === undefined) {
          throw new Error(`manifest.yaml not found in repo "${repoPath}"`);
        }
        const manifest = parseManifest(manifestContent);

        // Idempotent: if the stack is already gone from the manifest, just
        // remove any lingering stack files.
        if (manifest.stacks[stackName]) {
          delete manifest.stacks[stackName];
        }

        const newManifestContent = yaml.dump(manifest, {
          indent: 2,
          lineWidth: -1,
          noRefs: true,
          sortKeys: true,
        });

        const stackDirPrefix = `${stackName}/`;
        const stackFiles = Array.from(existingFiles.keys()).filter((p) =>
          p.startsWith(stackDirPrefix),
        );

        return {
          files: [{ path: MANIFEST_FILENAME, content: newManifestContent }],
          filesToDelete: stackFiles,
          message: `Remove stack: ${stackName}`,
          author: SYSTEM_AUTHOR,
        };
      });

      return { commitSha };
    },
  };
}
