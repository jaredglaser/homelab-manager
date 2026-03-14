import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initBareRepo, commitFiles } from '../repo';
import { processPostReceive } from '../post-receive-handler';

describe('processPostReceive', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(tmpdir(), 'git-handler-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should return deploy requests for changed stacks', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n' },
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

    const requests = await processPostReceive(repoPath, sha1, sha2);
    expect(requests).toHaveLength(1);
    expect(requests[0].stack).toBe('plex');
    expect(requests[0].autoApproved).toBe(true);
  });

  it('should handle manifest-only changes gracefully', async () => {
    const sha1 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: true\n' },
        { path: 'plex/docker-compose.yml', content: 'v1' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    });

    const sha2 = await commitFiles(repoPath, {
      files: [
        { path: 'manifest.yaml', content: 'stacks:\n  plex:\n    host: homeserver\n    auto_deploy: false\n' },
      ],
      message: 'update manifest only',
      author: { name: 'test', email: 'test@test.com' },
    });

    const requests = await processPostReceive(repoPath, sha1, sha2);
    expect(requests).toHaveLength(0);
  });
});
