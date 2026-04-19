import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { initBareRepo, commitFiles } from '@/lib/git/repo';
import * as gitConfig from '@/lib/config/git-config';
import { createStackRepoWriter } from '../stack-repo-writer';

const MANIFEST_WITH_PLEX_AND_TRAEFIK = `stacks:
  plex:
    autoDeploy: true
    host: homeserver
  traefik:
    autoDeploy: false
    host: homeserver
`;

const MANIFEST_WITH_PLEX = `stacks:
  plex:
    autoDeploy: true
    host: homeserver
`;

async function seedRepo(repoPath: string, files: Array<{ path: string; content: string }>): Promise<string> {
  return commitFiles(repoPath, () => ({
    files,
    message: 'initial',
    author: { name: 'test', email: 'test@test.com' },
  }));
}

describe('createStackRepoWriter', () => {
  let testDir: string;
  let repoPath: string;
  let loadGitConfigSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'stack-repo-writer-'));
    repoPath = join(testDir, 'stacks.git');
    await initBareRepo(repoPath);

    loadGitConfigSpy = spyOn(gitConfig, 'loadGitConfig').mockReturnValue({
      reposDir: testDir,
      repoName: 'stacks',
      repoPath,
    });
  });

  afterEach(() => {
    loadGitConfigSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('removes the stack from the manifest and returns a commit SHA', async () => {
    await seedRepo(repoPath, [
      { path: 'manifest.yaml', content: MANIFEST_WITH_PLEX_AND_TRAEFIK },
      { path: 'plex/docker-compose.yml', content: 'services:\n  plex: {}' },
    ]);

    const writer = createStackRepoWriter();
    const result = await writer.removeStackFromManifest('plex');

    expect(typeof result.commitSha).toBe('string');
    expect(result.commitSha.length).toBeGreaterThan(0);
  });

  it('removes the stack entry and its files from the repo', async () => {
    await seedRepo(repoPath, [
      { path: 'manifest.yaml', content: MANIFEST_WITH_PLEX_AND_TRAEFIK },
      { path: 'plex/docker-compose.yml', content: 'services:\n  plex: {}' },
      { path: 'plex/.env', content: 'FOO=bar' },
    ]);

    const writer = createStackRepoWriter();
    await writer.removeStackFromManifest('plex');

    // Read the updated manifest from the repo via a subsequent commit callback
    let updatedManifest = '';
    await commitFiles(repoPath, (existingFiles) => {
      updatedManifest = existingFiles.get('manifest.yaml') ?? '';
      const plexCompose = existingFiles.get('plex/docker-compose.yml');
      expect(plexCompose).toBeUndefined();
      // Return null to skip an actual commit
      return null;
    });

    expect(updatedManifest).not.toContain('plex:');
    expect(updatedManifest).toContain('traefik:');
  });

  it('is idempotent when the stack is already absent from the manifest', async () => {
    await seedRepo(repoPath, [
      { path: 'manifest.yaml', content: MANIFEST_WITH_PLEX },
    ]);

    const writer = createStackRepoWriter();
    // Remove a stack that is not in the manifest — should not throw
    const result = await writer.removeStackFromManifest('traefik');

    expect(typeof result.commitSha).toBe('string');
  });

  it('throws when manifest.yaml is missing from the repo', async () => {
    await seedRepo(repoPath, [
      { path: 'plex/docker-compose.yml', content: 'services:\n  plex: {}' },
    ]);

    const writer = createStackRepoWriter();
    await expect(writer.removeStackFromManifest('plex')).rejects.toThrow('manifest.yaml not found');
  });
});
