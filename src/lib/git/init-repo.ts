import git from 'isomorphic-git';
import fs from 'node:fs';
import { loadGitConfig } from '@/lib/config/git-config';
import { initBareRepo, commitFiles } from '@/lib/git/repo';
import { MANIFEST } from '@/lib/stacks/stack-repo-layout';

const DEFAULT_MANIFEST = `stacks: {}
`;

/**
 * Ensure the stacks git repository is initialized.
 * Creates the bare repo and seeds it with an empty manifest if it doesn't exist.
 */
export async function ensureRepoInitialized(): Promise<void> {
  const config = loadGitConfig();
  const { repoPath } = config;

  await initBareRepo(repoPath);

  if (await hasAnyCommits(repoPath)) return;

  await commitFiles(repoPath, (existingFiles) => {
    if (existingFiles.size > 0) return null; // another writer initialized first
    return {
      files: [{ path: MANIFEST, content: DEFAULT_MANIFEST }],
      message: 'Initialize stacks repository',
      author: {
        name: 'homelab-manager',
        email: 'homelab-manager@localhost',
      },
    };
  });
}

async function hasAnyCommits(repoPath: string): Promise<boolean> {
  try {
    await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('Could not resolve') || message.includes('Could not find') || message.includes('resolve ref')) {
      return false;
    }
    console.error('[GitInit] Unexpected error checking HEAD:', message);
    return false;
  }
}
