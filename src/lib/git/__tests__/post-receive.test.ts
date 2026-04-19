import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { initBareRepo, commitFiles } from '../repo';
import {
  identifyChangedStacks,
  buildDeployRequests,
} from '../post-receive';

describe('identifyChangedStacks', () => {
  it('should extract stack names from changed file paths', () => {
    const changedFiles = [
      'plex/docker-compose.yml',
      'traefik/docker-compose.yml',
    ];
    const stacks = identifyChangedStacks(changedFiles);
    expect(stacks).toEqual(['plex', 'traefik']);
  });

  it('should deduplicate when multiple files in same stack change', () => {
    const changedFiles = [
      'plex/docker-compose.yml',
      'plex/.env',
      'plex/config/settings.json',
    ];
    const stacks = identifyChangedStacks(changedFiles);
    expect(stacks).toEqual(['plex']);
  });

  it('should ignore root-level files (manifest.yaml)', () => {
    const changedFiles = ['manifest.yaml', 'plex/docker-compose.yml'];
    const stacks = identifyChangedStacks(changedFiles);
    expect(stacks).toEqual(['plex']);
  });

  it('should return empty array for no stack changes', () => {
    const changedFiles = ['manifest.yaml', 'README.md'];
    const stacks = identifyChangedStacks(changedFiles);
    expect(stacks).toEqual([]);
  });

  it('should sort stack names', () => {
    const changedFiles = [
      'traefik/docker-compose.yml',
      'pihole/docker-compose.yml',
      'plex/docker-compose.yml',
    ];
    const stacks = identifyChangedStacks(changedFiles);
    expect(stacks).toEqual(['pihole', 'plex', 'traefik']);
  });
});

describe('buildDeployRequests', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-deploy-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should build deploy requests for autoDeploy stacks', async () => {
    const sha1 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n  traefik:\n    host: homeserver\n    autoDeploy: false\n' },
        { path: 'plex/docker-compose.yml', content: 'services:\n  plex:\n    image: plex:v1\n' },
        { path: 'traefik/docker-compose.yml', content: 'services:\n  traefik:\n    image: traefik:v1\n' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const sha2 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'plex/docker-compose.yml', content: 'services:\n  plex:\n    image: plex:v2\n' },
        { path: 'traefik/docker-compose.yml', content: 'services:\n  traefik:\n    image: traefik:v2\n' },
      ],
      message: 'update both stacks',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const requests = await buildDeployRequests(repoPath, sha1, sha2);

    const plexReq = requests.find((r) => r.stack === 'plex');
    const traefikReq = requests.find((r) => r.stack === 'traefik');

    expect(plexReq).toBeDefined();
    expect(plexReq!.autoApproved).toBe(true);
    expect(plexReq!.host).toBe('homeserver');
    expect(plexReq!.commitSha).toBe(sha2);
    expect(plexReq!.action).toBe('deploy');

    expect(traefikReq).toBeDefined();
    expect(traefikReq!.autoApproved).toBe(false);
  });

  it('should skip stacks not in manifest', async () => {
    const sha1 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
        { path: 'unknown/docker-compose.yml', content: 'services: {}' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const sha2 = await commitFiles(repoPath, () => ({
      files: [{ path: 'unknown/docker-compose.yml', content: 'services: {updated: true}' }],
      message: 'update unknown',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const requests = await buildDeployRequests(repoPath, sha1, sha2);
    expect(requests).toHaveLength(0);
  });

  it('should include compose path in deploy request', async () => {
    const sha1 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'v1' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const sha2 = await commitFiles(repoPath, () => ({
      files: [{ path: 'plex/docker-compose.yml', content: 'v2' }],
      message: 'update',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const requests = await buildDeployRequests(repoPath, sha1, sha2);
    expect(requests[0].composePath).toBe('plex/docker-compose.yml');
  });
});
