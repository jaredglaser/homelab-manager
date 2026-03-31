import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { join } from 'path';
import { loadGitConfig } from '../git-config';

describe('loadGitConfig', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.GIT_REPOS_DIR;
    delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
  });

  afterEach(() => {
    delete process.env.GIT_REPOS_DIR;
    delete process.env.DOCKER_MANAGEMENT_FEATURE_FLAG;
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

  it('should set enabled to true when DOCKER_MANAGEMENT_FEATURE_FLAG is true', () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'true';
    const config = loadGitConfig();
    expect(config.enabled).toBe(true);
  });

  it('should set enabled to false when DOCKER_MANAGEMENT_FEATURE_FLAG is not set', () => {
    const config = loadGitConfig();
    expect(config.enabled).toBe(false);
  });

  it('should set enabled to false for non-true values of DOCKER_MANAGEMENT_FEATURE_FLAG', () => {
    process.env.DOCKER_MANAGEMENT_FEATURE_FLAG = 'false';
    const config = loadGitConfig();
    expect(config.enabled).toBe(false);
  });
});
