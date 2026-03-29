import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { ensureRepoInitialized } from '../init-repo';
import { repoExists, readFileFromRepo } from '../repo';

describe('ensureRepoInitialized', () => {
  let testDir: string;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-init-'));
    process.env.GIT_REPOS_DIR = testDir;
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.GIT_REPOS_DIR;
    delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
    Object.assign(process.env, originalEnv);
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

  it('should do nothing when feature flag is off', async () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'false';
    await ensureRepoInitialized();
    const repoPath = join(testDir, 'stacks.git');
    expect(existsSync(repoPath)).toBe(false);
  });
});
