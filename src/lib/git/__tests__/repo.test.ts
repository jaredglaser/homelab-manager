import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import git from 'isomorphic-git';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'node:path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import {
  initBareRepo,
  repoExists,
  readFileFromRepo,
  listFilesInRepo,
  commitFiles,
  getLog,
} from '../repo';

describe('repo initialization', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-test-'));
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

  it('should return false for directory with only HEAD file (missing objects/refs)', async () => {
    const fakePath = join(testDir, 'fake.git');
    mkdirSync(fakePath, { recursive: true });
    writeFileSync(join(fakePath, 'HEAD'), 'ref: refs/heads/main\n');
    expect(await repoExists(fakePath)).toBe(false);
  });

  it('should return false and log error for unexpected git errors', async () => {
    const repoPath = join(testDir, 'unexpected.git');
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, 'HEAD'), 'ref: refs/heads/main\n');
    mkdirSync(join(repoPath, 'objects'), { recursive: true });
    mkdirSync(join(repoPath, 'refs'), { recursive: true });

    const resolveRefSpy = spyOn(git, 'resolveRef').mockRejectedValueOnce(
      new Error('Disk I/O failure'),
    );
    const consoleSpy = spyOn(console, 'error').mockImplementation(() => {});

    const result = await repoExists(repoPath);
    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[Git] Unexpected error checking repo:',
      'Disk I/O failure',
    );

    resolveRefSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});

describe('readFileFromRepo', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-read-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    // Seed with a commit
    await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'services:\n  plex:\n    image: plexinc/pms-docker\n' },
      ],
      message: 'initial commit',
      author: { name: 'test', email: 'test@test.com' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should read a file from the repo at HEAD', async () => {
    const content = await readFileFromRepo(repoPath, 'manifest.yaml');
    expect(content).toContain('stacks:');
    expect(content).toContain('plex:');
  });

  it('should read a nested file', async () => {
    const content = await readFileFromRepo(repoPath, 'plex/docker-compose.yml');
    expect(content).toContain('plexinc/pms-docker');
  });

  it('should throw for non-existent file', async () => {
    await expect(readFileFromRepo(repoPath, 'nonexistent.txt')).rejects.toThrow();
  });
});

describe('listFilesInRepo', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-list-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks: {}' },
        { path: 'plex/docker-compose.yml', content: 'services: {}' },
        { path: 'traefik/docker-compose.yml', content: 'services: {}' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should list all files at root', async () => {
    const files = await listFilesInRepo(repoPath);
    expect(files).toContain('manifest.yaml');
    expect(files).toContain('plex/docker-compose.yml');
    expect(files).toContain('traefik/docker-compose.yml');
  });

  it('should list files in a subdirectory', async () => {
    const files = await listFilesInRepo(repoPath, 'plex');
    expect(files).toEqual(['plex/docker-compose.yml']);
  });
});

describe('commitFiles with filesToDelete', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-delete-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks: {}' },
        { path: 'plex/docker-compose.yml', content: 'services: {}' },
        { path: 'plex/env.txt', content: 'KEY=value' },
        { path: 'traefik/docker-compose.yml', content: 'services: {}' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should delete a single file', async () => {
    await commitFiles(repoPath, {
      files: [],
      filesToDelete: ['manifest.yaml'],
      message: 'delete manifest',
      author: { name: 'test', email: 'test@test.com' },
    });

    const files = await listFilesInRepo(repoPath);
    expect(files).not.toContain('manifest.yaml');
    expect(files).toContain('plex/docker-compose.yml');
  });

  it('should delete an entire directory', async () => {
    await commitFiles(repoPath, {
      files: [],
      filesToDelete: ['plex'],
      message: 'delete plex stack',
      author: { name: 'test', email: 'test@test.com' },
    });

    const files = await listFilesInRepo(repoPath);
    expect(files).not.toContain('plex/docker-compose.yml');
    expect(files).not.toContain('plex/env.txt');
    expect(files).toContain('manifest.yaml');
    expect(files).toContain('traefik/docker-compose.yml');
  });

  it('should handle trailing slash in directory path', async () => {
    await commitFiles(repoPath, {
      files: [],
      filesToDelete: ['plex/'],
      message: 'delete plex with trailing slash',
      author: { name: 'test', email: 'test@test.com' },
    });

    const files = await listFilesInRepo(repoPath);
    expect(files).not.toContain('plex/docker-compose.yml');
    expect(files).not.toContain('plex/env.txt');
  });
});

describe('commitFiles mutex', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-mutex-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should serialize concurrent commits without data loss', async () => {
    const author = { name: 'test', email: 'test@test.com' };

    const [oid1, oid2] = await Promise.all([
      commitFiles(repoPath, {
        files: [{ path: 'a.txt', content: 'file-a' }],
        message: 'add a',
        author,
      }),
      commitFiles(repoPath, {
        files: [{ path: 'b.txt', content: 'file-b' }],
        message: 'add b',
        author,
      }),
    ]);

    expect(oid1).not.toBe(oid2);

    const log = await getLog(repoPath, 10);
    expect(log).toHaveLength(2);

    const files = await listFilesInRepo(repoPath);
    expect(files.sort()).toEqual(['a.txt', 'b.txt']);

    const contentA = await readFileFromRepo(repoPath, 'a.txt');
    const contentB = await readFileFromRepo(repoPath, 'b.txt');
    expect(contentA).toBe('file-a');
    expect(contentB).toBe('file-b');
  });
});
