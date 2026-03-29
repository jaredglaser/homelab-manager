import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { initBareRepo, commitFiles, readFileFromRepo, getLog } from '../repo';
import { saveAndCommitFile, updateManifest } from '../editor-operations';

describe('saveAndCommitFile', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-editor-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'services:\n  plex:\n    image: plex:v1\n' },
      ],
      message: 'initial',
      author: { name: 'system', email: 'system@localhost' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should save a file and create a commit', async () => {
    const newContent = 'services:\n  plex:\n    image: plex:v2\n';
    const result = await saveAndCommitFile(repoPath, {
      filePath: 'plex/docker-compose.yml',
      content: newContent,
      author: { name: 'jared', email: 'jared@example.com' },
      message: 'Update plex to v2',
    });

    expect(result.commitSha).toBeDefined();
    expect(result.commitSha.length).toBe(40);

    const saved = await readFileFromRepo(repoPath, 'plex/docker-compose.yml');
    expect(saved).toBe(newContent);
  });

  it('should create a new file in a new stack directory', async () => {
    const result = await saveAndCommitFile(repoPath, {
      filePath: 'traefik/docker-compose.yml',
      content: 'services:\n  traefik:\n    image: traefik:v3\n',
      author: { name: 'jared', email: 'jared@example.com' },
      message: 'Add traefik stack',
    });

    expect(result.commitSha).toBeDefined();
    const saved = await readFileFromRepo(repoPath, 'traefik/docker-compose.yml');
    expect(saved).toContain('traefik:v3');
  });

  it('should preserve existing files when writing a new one', async () => {
    await saveAndCommitFile(repoPath, {
      filePath: 'traefik/docker-compose.yml',
      content: 'services: {}',
      author: { name: 'test', email: 'test@test.com' },
      message: 'add traefik',
    });

    // Original file should still exist
    const plex = await readFileFromRepo(repoPath, 'plex/docker-compose.yml');
    expect(plex).toContain('plex:v1');
  });

  it('should use provided commit message', async () => {
    await saveAndCommitFile(repoPath, {
      filePath: 'plex/docker-compose.yml',
      content: 'updated',
      author: { name: 'jared', email: 'jared@example.com' },
      message: 'Custom commit message',
    });

    const log = await getLog(repoPath, 1);
    expect(log[0].message).toBe('Custom commit message');
  });
});

describe('updateManifest', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-manifest-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
      ],
      message: 'initial',
      author: { name: 'system', email: 'system@localhost' },
    });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should add a new stack to the manifest', async () => {
    const result = await updateManifest(repoPath, {
      stackName: 'traefik',
      host: 'homeserver',
      autoDeploy: false,
      author: { name: 'jared', email: 'jared@example.com' },
    });

    expect(result.commitSha).toBeDefined();
    const content = await readFileFromRepo(repoPath, 'manifest.yaml');
    expect(content).toContain('traefik:');
    expect(content).toContain('homeserver');
  });

  it('should update an existing stack in the manifest', async () => {
    const result = await updateManifest(repoPath, {
      stackName: 'plex',
      host: 'new-host',
      autoDeploy: false,
      author: { name: 'jared', email: 'jared@example.com' },
    });

    expect(result.commitSha).toBeDefined();
    const content = await readFileFromRepo(repoPath, 'manifest.yaml');
    expect(content).toContain('new-host');
  });
});
