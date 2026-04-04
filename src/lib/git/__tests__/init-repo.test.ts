import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import git from 'isomorphic-git';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'node:path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { ensureRepoInitialized } from '../init-repo';
import { repoExists, readFileFromRepo } from '../repo';

describe('ensureRepoInitialized', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-init-'));
    process.env.GIT_REPOS_DIR = testDir;
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GIT_REPOS_DIR;
  });

  it('should initialize a bare repo if it does not exist', async () => {
    await ensureRepoInitialized();
    const repoPath = join(testDir, 'stacks.git');
    expect(await repoExists(repoPath)).toBe(true);
  });

  it('should create initial manifest.yaml with empty stacks', async () => {
    await ensureRepoInitialized();
    const repoPath = join(testDir, 'stacks.git');
    const content = await readFileFromRepo(repoPath, 'manifest.yaml');
    expect(content).toContain('stacks:');
  });

  it('should be idempotent', async () => {
    await ensureRepoInitialized();
    await ensureRepoInitialized();
    const repoPath = join(testDir, 'stacks.git');
    expect(await repoExists(repoPath)).toBe(true);
  });

  it('should complete initialization when resolveRef throws an unexpected error', async () => {
    const resolveRefSpy = spyOn(git, 'resolveRef').mockRejectedValueOnce(
      new Error('Disk I/O failure'),
    );
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      await ensureRepoInitialized();

      expect(resolveRefSpy).toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        '[GitInit] Unexpected error checking HEAD:',
        'Disk I/O failure',
      );
    } finally {
      resolveRefSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
