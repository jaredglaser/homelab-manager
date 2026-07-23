import { commitFiles, FileNotFoundError } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';
import { MANIFEST, serializeManifest } from '@/lib/stacks/stack-repo-layout';

interface SaveFileOptions {
  filePath: string;
  content: string;
  author: { name: string; email: string };
  message: string;
}

interface SaveResult {
  commitSha: string;
}

/**
 * Save a file to the repo and create a commit.
 * Used by the in-app editor for compose file edits.
 */
export async function saveAndCommitFile(
  repoPath: string,
  options: SaveFileOptions,
): Promise<SaveResult> {
  const commitSha = await commitFiles(repoPath, () => ({
    files: [{ path: options.filePath, content: options.content }],
    message: options.message,
    author: options.author,
  }));

  return { commitSha };
}

interface UpdateManifestOptions {
  stackName: string;
  host: string;
  autoDeploy: boolean;
  author: { name: string; email: string };
}

/**
 * Add or update a stack entry in the manifest and commit.
 */
export async function updateManifest(
  repoPath: string,
  options: UpdateManifestOptions,
): Promise<SaveResult> {
  const commitSha = await commitFiles(repoPath, (existingFiles) => {
    const manifestContent = existingFiles.get(MANIFEST);
    if (manifestContent === undefined) {
      throw new FileNotFoundError(MANIFEST);
    }
    const manifest = parseManifest(manifestContent);

    manifest.stacks[options.stackName] = {
      host: options.host,
      autoDeploy: options.autoDeploy,
    };

    return {
      files: [{ path: MANIFEST, content: serializeManifest(manifest) }],
      message: `Update manifest: ${options.stackName} on ${options.host}`,
      author: options.author,
    };
  });

  return { commitSha };
}
