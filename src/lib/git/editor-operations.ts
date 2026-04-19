import yaml from 'js-yaml';
import { commitFiles, FileNotFoundError } from '@/lib/git/repo';
import { parseManifest } from '@/lib/git/manifest';

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
 * Add or update a stack entry in manifest.yaml and commit.
 */
export async function updateManifest(
  repoPath: string,
  options: UpdateManifestOptions,
): Promise<SaveResult> {
  const commitSha = await commitFiles(repoPath, (existingFiles) => {
    const manifestContent = existingFiles.get('manifest.yaml');
    if (manifestContent === undefined) {
      throw new FileNotFoundError('manifest.yaml');
    }
    const manifest = parseManifest(manifestContent);

    manifest.stacks[options.stackName] = {
      host: options.host,
      autoDeploy: options.autoDeploy,
    };

    const newContent = yaml.dump(manifest, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: true,
    });

    return {
      files: [{ path: 'manifest.yaml', content: newContent }],
      message: `Update manifest: ${options.stackName} on ${options.host}`,
      author: options.author,
    };
  });

  return { commitSha };
}
