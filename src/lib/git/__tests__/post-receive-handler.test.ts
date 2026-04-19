import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { initBareRepo, commitFiles } from '../repo';
import { processPostReceive } from '../post-receive-handler';
import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';

describe('processPostReceive', () => {
  let testDir: string;
  let repoPath: string;
  let infoSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-handler-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should log deploy requests for changed stacks and resolve without error', async () => {
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
      message: 'update plex',
      author: { name: 'test', email: 'test@test.com' },
    }));

    // processPostReceive catches all pipeline errors internally, so it should always resolve
    await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PostReceive] Deploy request: deploy plex on homeserver (auto=true)'),
    );
  });

  it('should handle manifest-only changes gracefully without logging deploy requests', async () => {
    const sha1 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'v1' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const sha2 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: false\n' },
      ],
      message: 'update manifest only',
      author: { name: 'test', email: 'test@test.com' },
    }));

    await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

    // No deploy requests should be generated for manifest-only changes
    const deployCalls = infoSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('[PostReceive] Deploy request:'),
    );
    expect(deployCalls).toHaveLength(0);
  });

  it('should throw when manifest.yaml is missing', async () => {
    const sha1 = await commitFiles(repoPath, () => ({
      files: [{ path: 'plex/docker-compose.yml', content: 'v1' }],
      message: 'initial without manifest',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const sha2 = await commitFiles(repoPath, () => ({
      files: [{ path: 'plex/docker-compose.yml', content: 'v2' }],
      message: 'update plex',
      author: { name: 'test', email: 'test@test.com' },
    }));

    await expect(processPostReceive(repoPath, sha1, sha2)).rejects.toThrow();
  });

  it('should exclude stacks whose compose file is missing from results', async () => {

    // Commit a manifest listing 'plex' with a non-compose file change (so stack is detected as changed)
    const sha1 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
        { path: 'plex/README.md', content: 'v1' },
      ],
      message: 'initial — has README but no docker-compose.yml',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const sha2 = await commitFiles(repoPath, () => ({
      files: [{ path: 'plex/README.md', content: 'v2' }],
      message: 'update README, no compose file',
      author: { name: 'test', email: 'test@test.com' },
    }));

    await processPostReceive(repoPath, sha1, sha2);
    // plex changed but has no docker-compose.yml — should be excluded (logged as error)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PostReceive] Failed to read compose file'),
      expect.anything(),
    );

  });

  it('should insert a failed deploy record when compose file is missing and deployRepo is provided', async () => {

    const insertedDeploys: unknown[] = [];
    const deployRepo = {
      insertDeploy: mock(async (params: unknown) => {
        insertedDeploys.push(params);
        return 1;
      }),
    } as unknown as DeployRepository;

    const sha1 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
        { path: 'plex/README.md', content: 'v1' },
      ],
      message: 'initial without compose',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const sha2 = await commitFiles(repoPath, () => ({
      files: [{ path: 'plex/README.md', content: 'v2' }],
      message: 'update plex README, no compose',
      author: { name: 'test', email: 'test@test.com' },
    }));

    await processPostReceive(repoPath, sha1, sha2, deployRepo);
    expect(insertedDeploys).toHaveLength(1);
    expect((insertedDeploys[0] as Record<string, unknown>).stack).toBe('plex');
    expect((insertedDeploys[0] as Record<string, unknown>).status).toBe('failed');
    expect((insertedDeploys[0] as Record<string, unknown>).trigger).toBe('git_push');

  });

  it('should log full error object (not just message) when compose read fails', async () => {

    const sha1 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
        { path: 'plex/README.md', content: 'v1' },
      ],
      message: 'initial without compose',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const sha2 = await commitFiles(repoPath, () => ({
      files: [{ path: 'plex/README.md', content: 'v2' }],
      message: 'update plex README, no compose',
      author: { name: 'test', email: 'test@test.com' },
    }));

    await processPostReceive(repoPath, sha1, sha2);

    // The second argument to console.error should be the Error object itself, not a string
    const calls = errorSpy.mock.calls as unknown[][];
    const composeErrorCall = calls.find((call: unknown[]) =>
      typeof call[0] === 'string' && call[0].includes('Failed to read compose file'),
    );
    expect(composeErrorCall).toBeDefined();
    expect(composeErrorCall![1]).toBeInstanceOf(Error);

  });

  it('should not throw when deployRepo.insertDeploy fails', async () => {

    const deployRepo = {
      insertDeploy: mock(async () => { throw new Error('DB unavailable'); }),
    } as unknown as DeployRepository;

    const sha1 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
        { path: 'plex/README.md', content: 'v1' },
      ],
      message: 'initial without compose',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const sha2 = await commitFiles(repoPath, () => ({
      files: [{ path: 'plex/README.md', content: 'v2' }],
      message: 'update plex README, no compose',
      author: { name: 'test', email: 'test@test.com' },
    }));

    // Should resolve (not throw), even though deployRepo.insertDeploy throws
    await processPostReceive(repoPath, sha1, sha2, deployRepo);
    // The DB failure should itself be logged
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Failed to insert failed deploy record'),
      expect.anything(),
    );

  });
});
