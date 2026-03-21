import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, commitFiles } from '../repo';
import { processPostReceive } from '../post-receive-handler';

describe('processPostReceive', () => {
  let testDir: string;
  let repoPath: string;
  let infoSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-handler-'));
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
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
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

    // processPostReceive catches all pipeline errors internally, so it should always resolve
    await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PostReceive] Deploy request: deploy plex on homeserver (auto=true)'),
    );
  });

  it('should handle manifest-only changes gracefully without logging deploy requests', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'v1' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: false\n' },
      ],
      message: 'update manifest only',
      author: { name: 'test', email: 'test@test.com' },
    });

    await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

    // No deploy requests should be generated for manifest-only changes
    const deployCalls = infoSpy.mock.calls.filter(
      (args: unknown[]) => typeof args[0] === 'string' && args[0].includes('[PostReceive] Deploy request:'),
    );
    expect(deployCalls).toHaveLength(0);
  });

  it('should throw when manifest.yaml is missing', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [{ path: 'plex/docker-compose.yml', content: 'v1' }],
      message: 'initial without manifest',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [{ path: 'plex/docker-compose.yml', content: 'v2' }],
      message: 'update plex',
      author: { name: 'test', email: 'test@test.com' },
    });

    await expect(processPostReceive(repoPath, sha1, sha2)).rejects.toThrow();
  });
});
