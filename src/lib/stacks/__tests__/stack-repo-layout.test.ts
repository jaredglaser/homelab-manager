import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { initBareRepo, commitFiles } from '@/lib/git/repo';
import {
  MANIFEST,
  composePath,
  stackFiles,
  serializeManifest,
  removeStackFromManifest,
} from '@/lib/stacks/stack-repo-layout';

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

describe('composePath', () => {
  it('builds the compose file path for a stack', () => {
    expect(composePath('plex')).toBe('plex/docker-compose.yml');
  });
});

describe('stackFiles', () => {
  it('returns only paths under the stack directory', () => {
    const paths = ['plex/docker-compose.yml', 'plex/.env', 'traefik/docker-compose.yml', MANIFEST];
    expect(stackFiles(paths, 'plex')).toEqual(['plex/docker-compose.yml', 'plex/.env']);
  });

  it('returns an empty array when the stack has no files', () => {
    expect(stackFiles(['traefik/docker-compose.yml', MANIFEST], 'plex')).toEqual([]);
  });

  it('does not match a stack name that is a prefix of another stack name', () => {
    // "plex" must not match files under "plex-backup/", only "plex/".
    expect(stackFiles(['plex-backup/docker-compose.yml'], 'plex')).toEqual([]);
  });
});

describe('serializeManifest', () => {
  it('sorts keys and produces stable YAML', () => {
    const yamlContent = serializeManifest({
      stacks: {
        traefik: { host: 'homeserver', autoDeploy: false },
        plex: { host: 'homeserver', autoDeploy: true },
      },
    });

    expect(yamlContent).toBe(MANIFEST_WITH_PLEX_AND_TRAEFIK);
  });
});

describe('removeStackFromManifest', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'stack-repo-layout-'));
    repoPath = join(testDir, 'stacks.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('removes the stack from the manifest and returns a commit SHA', async () => {
    await seedRepo(repoPath, [
      { path: MANIFEST, content: MANIFEST_WITH_PLEX_AND_TRAEFIK },
      { path: 'plex/docker-compose.yml', content: 'services:\n  plex: {}' },
    ]);

    const commitSha = await commitFiles(repoPath, removeStackFromManifest('plex'));

    expect(typeof commitSha).toBe('string');
    expect(commitSha.length).toBeGreaterThan(0);
  });

  it('removes the stack entry and its files from the repo', async () => {
    await seedRepo(repoPath, [
      { path: MANIFEST, content: MANIFEST_WITH_PLEX_AND_TRAEFIK },
      { path: 'plex/docker-compose.yml', content: 'services:\n  plex: {}' },
      { path: 'plex/.env', content: 'FOO=bar' },
    ]);

    await commitFiles(repoPath, removeStackFromManifest('plex'));

    // Read the updated manifest from the repo via a subsequent commit callback.
    let updatedManifest = '';
    await commitFiles(repoPath, (existingFiles) => {
      updatedManifest = existingFiles.get(MANIFEST) ?? '';
      expect(existingFiles.get('plex/docker-compose.yml')).toBeUndefined();
      expect(existingFiles.get('plex/.env')).toBeUndefined();
      // Return null to skip an actual commit.
      return null;
    });

    expect(updatedManifest).not.toContain('plex:');
    expect(updatedManifest).toContain('traefik:');
  });

  it('is idempotent when the stack is already absent from the manifest', async () => {
    await seedRepo(repoPath, [{ path: MANIFEST, content: MANIFEST_WITH_PLEX }]);

    // Remove a stack that is not in the manifest: should not throw.
    const commitSha = await commitFiles(repoPath, removeStackFromManifest('traefik'));

    expect(typeof commitSha).toBe('string');
  });

  it('throws when the manifest is missing from the repo', async () => {
    await seedRepo(repoPath, [
      { path: 'plex/docker-compose.yml', content: 'services:\n  plex: {}' },
    ]);

    await expect(commitFiles(repoPath, removeStackFromManifest('plex'))).rejects.toThrow(
      'manifest.yaml not found',
    );
  });
});
