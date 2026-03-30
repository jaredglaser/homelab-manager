import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { loadGitConfig } from '../git-config';

describe('loadGitConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GIT_REPOS_DIR;
  });

  afterEach(() => {
    delete process.env.GIT_REPOS_DIR;
    Object.assign(process.env, originalEnv);
  });

  it('should return default repos dir when not configured', () => {
    const config = loadGitConfig();
    expect(config.reposDir).toBe('/data/repos');
  });

  it('should use custom repos dir from env var', () => {
    process.env.GIT_REPOS_DIR = '/custom/repos';
    const config = loadGitConfig();
    expect(config.reposDir).toBe('/custom/repos');
  });

  it('should return the repo name', () => {
    const config = loadGitConfig();
    expect(config.repoName).toBe('stacks');
  });

  it('should compute full repo path', () => {
    process.env.GIT_REPOS_DIR = '/data/repos';
    const config = loadGitConfig();
    expect(config.repoPath).toBe(join('/data/repos', 'stacks.git'));
  });

  it('should reject empty or whitespace-only values', () => {
    process.env.GIT_REPOS_DIR = '   ';
    expect(() => loadGitConfig()).toThrow();
  });
});
