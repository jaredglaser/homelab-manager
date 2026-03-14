import git from 'isomorphic-git';
import * as fs from 'fs';
import { existsSync, mkdirSync } from 'fs';

/**
 * Initialize a bare git repository at the given path.
 * Creates the directory if it does not exist.
 * Idempotent -- safe to call on an already-initialized repo.
 */
export async function initBareRepo(repoPath: string): Promise<void> {
  if (!existsSync(repoPath)) {
    mkdirSync(repoPath, { recursive: true });
  }

  await git.init({ fs, dir: repoPath, bare: true });
}

/**
 * Check whether a directory is a valid bare git repository.
 */
export async function repoExists(repoPath: string): Promise<boolean> {
  if (!existsSync(repoPath)) {
    return false;
  }

  try {
    // A bare repo has HEAD at the top level
    await git.resolveRef({ fs, gitdir: repoPath, ref: 'HEAD' });
    return true;
  } catch {
    // resolveRef throws if HEAD doesn't exist yet (empty repo)
    // but the repo can still be valid - check for HEAD file
    return existsSync(`${repoPath}/HEAD`);
  }
}
