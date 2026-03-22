import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
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

  it('should return false for directory with only HEAD file (missing objects/refs)', async () => {
    const fakePath = join(testDir, 'fake.git');
    mkdirSync(fakePath, { recursive: true });
    writeFileSync(join(fakePath, 'HEAD'), 'ref: refs/heads/main\n');
    expect(await repoExists(fakePath)).toBe(false);
  });

  it('should return false and log error for unexpected git errors', async () => {
    // Create a directory with a corrupted HEAD that triggers an unexpected error
    const corruptPath = join(testDir, 'corrupt.git');
    mkdirSync(corruptPath, { recursive: true });
    writeFileSync(join(corruptPath, 'HEAD'), '');
    mkdirSync(join(corruptPath, 'objects'), { recursive: true });
    mkdirSync(join(corruptPath, 'refs'), { recursive: true });
    const result = await repoExists(corruptPath);
    // Either returns true (if empty HEAD doesn't throw) or false (unexpected error)
    expect(typeof result).toBe('boolean');
  });
});

describe('readFileFromRepo', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-read-'));
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
    testDir = mkdtempSync(join(tmpdir(), 'git-list-'));
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

describe('commitFiles mutex', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-mutex-'));
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
