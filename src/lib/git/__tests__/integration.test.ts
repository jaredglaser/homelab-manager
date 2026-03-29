import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { initBareRepo, commitFiles, readFileFromRepo, listFilesInRepo, getLog, diffCommits } from '../repo';
import { parseManifest } from '../manifest';
import { identifyChangedStacks, buildDeployRequests } from '../post-receive';
import { saveAndCommitFile, updateManifest } from '../editor-operations';
import { buildFileTree } from '../git-server-functions';

describe('Git management integration', () => {
  let testDir: string;
  let repoPath: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-integration-'));
    repoPath = join(testDir, 'stacks.git');
    await initBareRepo(repoPath);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should support full workflow: init -> add stack -> edit -> detect changes -> deploy request', async () => {
    // 1. Create initial manifest and stack
    const sha1 = await commitFiles(repoPath, {
      files: [
        {
          path: 'manifest.yaml',
          content: 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n',
        },
        {
          path: 'plex/docker-compose.yml',
          content: 'services:\n  plex:\n    image: plexinc/pms-docker:latest\n',
        },
      ],
      message: 'Initial setup',
      author: { name: 'jared', email: 'jared@example.com' },
    });

    // 2. Verify files are readable
    const manifest = await readFileFromRepo(repoPath, 'manifest.yaml');
    const parsed = parseManifest(manifest);
    expect(parsed.stacks.plex.host).toBe('homeserver');

    // 3. List files and build tree
    const files = await listFilesInRepo(repoPath);
    expect(files).toHaveLength(2);
    const tree = buildFileTree(files);
    expect(tree[0].type).toBe('directory'); // plex/
    expect(tree[1].type).toBe('file'); // manifest.yaml

    // 4. Edit compose file via UI
    const editResult = await saveAndCommitFile(repoPath, {
      filePath: 'plex/docker-compose.yml',
      content: 'services:\n  plex:\n    image: plexinc/pms-docker:1.40.0\n',
      author: { name: 'jared', email: 'jared@example.com' },
      message: 'Update plex to 1.40.0',
    });

    // 5. Verify log
    const log = await getLog(repoPath, 10);
    expect(log).toHaveLength(2);
    expect(log[0].message).toBe('Update plex to 1.40.0');

    // 6. Diff and detect changes
    const changedFiles = await diffCommits(repoPath, sha1, editResult.commitSha);
    expect(changedFiles).toEqual(['plex/docker-compose.yml']);

    const changedStacks = identifyChangedStacks(changedFiles);
    expect(changedStacks).toEqual(['plex']);

    // 7. Build deploy requests
    const requests = await buildDeployRequests(repoPath, sha1, editResult.commitSha);
    expect(requests).toHaveLength(1);
    expect(requests[0].stack).toBe('plex');
    expect(requests[0].host).toBe('homeserver');
    expect(requests[0].autoApproved).toBe(true);
    expect(requests[0].action).toBe('deploy');

    // 8. Add a new stack via manifest update
    await updateManifest(repoPath, {
      stackName: 'traefik',
      host: 'homeserver',
      autoDeploy: false,
      author: { name: 'jared', email: 'jared@example.com' },
    });

    const updatedManifest = await readFileFromRepo(repoPath, 'manifest.yaml');
    const updatedParsed = parseManifest(updatedManifest);
    expect(updatedParsed.stacks.traefik).toBeDefined();
    expect(updatedParsed.stacks.traefik.autoDeploy).toBe(false);

    // 9. Final log should have 3 commits
    const finalLog = await getLog(repoPath, 10);
    expect(finalLog).toHaveLength(3);
  });
});
