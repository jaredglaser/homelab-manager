import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, repoExists } from '../repo';

describe('repo initialization', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'git-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should initialize a bare git repo', async () => {
    const repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    expect(await repoExists(repoPath)).toBe(true);
  });

  it('should be idempotent - calling init twice does not throw', async () => {
    const repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await initBareRepo(repoPath);
    expect(await repoExists(repoPath)).toBe(true);
  });

  it('should return false for non-existent repo', async () => {
    const repoPath = join(testDir, 'nonexistent.git');
    expect(await repoExists(repoPath)).toBe(false);
  });
});
