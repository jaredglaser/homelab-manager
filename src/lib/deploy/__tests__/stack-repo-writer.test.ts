import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { initBareRepo, commitFiles } from '@/lib/git/repo';
import * as gitConfig from '@/lib/config/git-config';
import { createStackRepoWriter } from '@/lib/deploy/stack-repo-writer';

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

  it('removes the stack from the manifest at the configured repo and returns a commit SHA', async () => {
    await seedRepo(repoPath, [
      { path: 'manifest.yaml', content: MANIFEST_WITH_PLEX },
      { path: 'plex/docker-compose.yml', content: 'services:\n  plex: {}' },
    ]);

    const writer = createStackRepoWriter();
    const result = await writer.removeStackFromManifest('plex');

    expect(typeof result.commitSha).toBe('string');
    expect(result.commitSha.length).toBeGreaterThan(0);
    expect(loadGitConfigSpy).toHaveBeenCalled();
  });

  it('propagates the underlying error when the manifest is missing', async () => {
    await seedRepo(repoPath, [
      { path: 'plex/docker-compose.yml', content: 'services:\n  plex: {}' },
    ]);

    const writer = createStackRepoWriter();
    await expect(writer.removeStackFromManifest('plex')).rejects.toThrow('manifest.yaml not found');
  });
});
