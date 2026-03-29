import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { initBareRepo, commitFiles, getLog, diffCommits } from '../repo';

describe('getLog', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-log-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return commit log entries', async () => {
    await commitFiles(repoPath, {
      files: [{ path: 'file.txt', content: 'hello' }],
      message: 'first commit',
      author: { name: 'test', email: 'test@test.com' },
    });

    await commitFiles(repoPath, {
      files: [{ path: 'file.txt', content: 'world' }],
      message: 'second commit',
      author: { name: 'test', email: 'test@test.com' },
    });

    const log = await getLog(repoPath, 10);
    expect(log).toHaveLength(2);
    expect(log[0].message).toBe('second commit');
    expect(log[1].message).toBe('first commit');
  });

  it('should respect depth limit', async () => {
    await commitFiles(repoPath, {
      files: [{ path: 'a.txt', content: 'a' }],
      message: 'first',
      author: { name: 'test', email: 'test@test.com' },
    });
    await commitFiles(repoPath, {
      files: [{ path: 'b.txt', content: 'b' }],
      message: 'second',
      author: { name: 'test', email: 'test@test.com' },
    });
    await commitFiles(repoPath, {
      files: [{ path: 'c.txt', content: 'c' }],
      message: 'third',
      author: { name: 'test', email: 'test@test.com' },
    });

    const log = await getLog(repoPath, 2);
    expect(log).toHaveLength(2);
  });
});

describe('diffCommits', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-diff-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should detect changed files between two commits', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks: {}' },
        { path: 'plex/docker-compose.yml', content: 'v1' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [{ path: 'plex/docker-compose.yml', content: 'v2' }],
      message: 'update plex',
      author: { name: 'test', email: 'test@test.com' },
    });

    const changed = await diffCommits(repoPath, sha1, sha2);
    expect(changed).toContain('plex/docker-compose.yml');
    expect(changed).not.toContain('manifest.yaml');
  });

  it('should detect new files', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [{ path: 'manifest.yaml', content: 'stacks: {}' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [{ path: 'traefik/docker-compose.yml', content: 'services: {}' }],
      message: 'add traefik',
      author: { name: 'test', email: 'test@test.com' },
    });

    const changed = await diffCommits(repoPath, sha1, sha2);
    expect(changed).toContain('traefik/docker-compose.yml');
  });

  it('should detect deleted files', async () => {
    // sha1 has only manifest, sha2 adds traefik on top
    // Diffing sha2→sha1 exercises the deletion detection code path
    const sha1 = await commitFiles(repoPath, {
      files: [{ path: 'manifest.yaml', content: 'stacks: {}' }],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [{ path: 'traefik/docker-compose.yml', content: 'services: {}' }],
      message: 'add traefik',
      author: { name: 'test', email: 'test@test.com' },
    });

    // Reverse diff: from sha2 (has traefik) to sha1 (no traefik) = traefik deleted
    const changed = await diffCommits(repoPath, sha2, sha1);
    expect(changed).toContain('traefik/docker-compose.yml');
    expect(changed).not.toContain('manifest.yaml');
  });
});
