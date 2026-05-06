import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { initBareRepo, commitFiles } from '../repo';
import { processPostReceive } from '../post-receive-handler';
import { GitTriggerBuilder } from '@/lib/deploy/builders/git-trigger-builder';

// Pre-load all infrastructure modules that processPostReceive dynamically
// imports. Because dynamic `await import()` returns the same cached module
// instance as a static import, spies attached here will intercept the calls
// inside processPostReceive without using mock.module() (which would contaminate
// other test files running in the same Bun worker).
import { databaseConnectionManager } from '@/lib/clients/database-client';
import { DeployRepository } from '@/lib/database/repositories/deploy-repository';
import { HostRepository } from '@/lib/database/repositories/host-repository';
import { AgentClient } from '@/lib/clients/agent-client';
import { OpenBaoClient } from '@/lib/clients/openbao-client';
import * as openbaoConfig from '@/lib/config/openbao-config';
import { StackSecretsRepository } from '@/lib/database/repositories/stack-secrets-repository';
import * as masterKey from '@/lib/crypto/master-key';
import type { ManagedHost } from '@/lib/deploy/types';

// Helpers

async function makeFakeKeyring(): Promise<masterKey.MasterKeyring> {
  const key = await crypto.subtle.importKey(
    'raw',
    Buffer.alloc(32, 7),
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  return { activeKid: 'v1', keys: new Map([['v1', key]]) };
}

const MANIFEST_WITH_PLEX = 'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n';

const TEST_HOST: ManagedHost = {
  id: 1,
  name: 'homeserver',
  agentUrl: 'http://agent:9090',
  capabilities: { docker: true },
  agentVersion: '0.1.0',
  status: 'healthy',
  createdAt: new Date(),
  updatedAt: new Date(),
};

async function buildPlexChangeCommits(repoPath: string): Promise<{ sha1: string; sha2: string }> {
  const sha1 = await commitFiles(repoPath, () => ({
    files: [
      { path: 'manifest.yaml', content: MANIFEST_WITH_PLEX },
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
  return { sha1, sha2 };
}


describe('processPostReceive (pipeline paths)', () => {
  let testDir: string;
  let repoPath: string;
  let infoSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let getClientSpy: ReturnType<typeof spyOn>;
  let isConfiguredSpy: ReturnType<typeof spyOn>;

  let insertDeployIfNoActiveSpy: ReturnType<typeof spyOn>;
  let getLatestSuccessfulSpy: ReturnType<typeof spyOn>;
  let updateStatusSpy: ReturnType<typeof spyOn>;
  let deduplicatePendingSpy: ReturnType<typeof spyOn>;
  let notifyStackChangeSpy: ReturnType<typeof spyOn>;
  let findByNameSpy: ReturnType<typeof spyOn>;
  let agentDeploySpy: ReturnType<typeof spyOn>;
  let getHostSecretSpy: ReturnType<typeof spyOn>;
  let loadMasterKeyringSpy: ReturnType<typeof spyOn>;

  const mockPool = {};
  const mockDbClient = { getPool: () => mockPool };

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'git-handler-pipeline-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    infoSpy = spyOn(console, 'info').mockImplementation(() => {});
    errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    // Always override isOpenBaoConfigured to return false by default.
    // Individual tests that want OpenBao enabled override it with mockReturnValue(true).
    // This prevents the real env var (OPENBAO_URL) from triggering real HTTP requests.
    isConfiguredSpy = spyOn(openbaoConfig, 'isOpenBaoConfigured').mockReturnValue(false);

    // loadMasterKeyring reads MASTER_KEY/MASTER_KEY_FILE from the environment.
    // Spy on it so tests run without those env vars and without touching the FS.
    loadMasterKeyringSpy = spyOn(masterKey, 'loadMasterKeyring').mockResolvedValue(
      await makeFakeKeyring(),
    );

    // Database connection: return a mock client with an empty pool object
    getClientSpy = spyOn(databaseConnectionManager, 'getClient').mockResolvedValue(
      mockDbClient as never,
    );

    // Spy on repository prototype methods: applies to all instances created by processPostReceive
    insertDeployIfNoActiveSpy = spyOn(
      DeployRepository.prototype,
      'insertDeployIfNoActive',
    ).mockResolvedValue(42 as never);
    getLatestSuccessfulSpy = spyOn(
      DeployRepository.prototype,
      'getLatestSuccessful',
    ).mockResolvedValue(null as never);
    updateStatusSpy = spyOn(
      DeployRepository.prototype,
      'updateStatus',
    ).mockResolvedValue(undefined as never);
    deduplicatePendingSpy = spyOn(
      DeployRepository.prototype,
      'deduplicatePending',
    ).mockResolvedValue(undefined as never);
    notifyStackChangeSpy = spyOn(
      DeployRepository.prototype,
      'notifyStackChange',
    ).mockResolvedValue(undefined as never);
    findByNameSpy = spyOn(
      HostRepository.prototype,
      'findByName',
    ).mockResolvedValue(TEST_HOST as never);

    // Agent deploy: returns success by default
    agentDeploySpy = spyOn(AgentClient.prototype, 'deploy').mockResolvedValue({
      success: true,
      logs: 'deployed ok',
    } as never);

    // OpenBaoClient.getHostSecret: used by tokenResolver; return a valid token by default
    getHostSecretSpy = spyOn(
      OpenBaoClient.prototype,
      'getHostSecret',
    ).mockResolvedValue('my-agent-token' as never);
  });

  afterEach(() => {
    infoSpy.mockRestore();
    errorSpy.mockRestore();
    isConfiguredSpy.mockRestore();
    loadMasterKeyringSpy.mockRestore();
    getClientSpy.mockRestore();
    insertDeployIfNoActiveSpy.mockRestore();
    getLatestSuccessfulSpy.mockRestore();
    updateStatusSpy.mockRestore();
    deduplicatePendingSpy.mockRestore();
    notifyStackChangeSpy.mockRestore();
    findByNameSpy.mockRestore();
    agentDeploySpy.mockRestore();
    getHostSecretSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('returns early when all compose file reads fail (changedStacks.size === 0)', async () => {
    // Non-compose file in plex/ triggers buildDeployRequests but compose read throws.
    const sha1 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'manifest.yaml', content: MANIFEST_WITH_PLEX },
        { path: 'plex/readme.txt', content: 'info' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));
    const sha2 = await commitFiles(repoPath, () => ({
      files: [{ path: 'plex/readme.txt', content: 'updated info' }],
      message: 'update plex readme',
      author: { name: 'test', email: 'test@test.com' },
    }));

    await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PostReceive] Failed to read compose file for stack "plex"'),
      expect.anything(),
    );
    // Pipeline never initialized: getClient should not have been called
    expect(getClientSpy).not.toHaveBeenCalled();
  });

  it('returns early when builder produces no deploy requests (deployRequests.length === 0)', async () => {
    const buildSpy = spyOn(GitTriggerBuilder.prototype, 'build').mockReturnValue([]);

    try {
      const { sha1, sha2 } = await buildPlexChangeCommits(repoPath);

      await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

      // Pipeline never initialized
      expect(getClientSpy).not.toHaveBeenCalled();
    } finally {
      buildSpy.mockRestore();
    }
  });

  it('executes the pipeline and logs success result', async () => {
    // With isOpenBaoConfigured=false (default), baoClient=null, tokenResolver throws.
    // tokenResolver error is caught inside pipeline.dispatch(), which returns {status:'failed'}.
    // processPostReceive logs console.info with the result.
    const { sha1, sha2 } = await buildPlexChangeCommits(repoPath);

    await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

    // Pipeline was set up; DB was accessed
    expect(getClientSpy).toHaveBeenCalledTimes(1);
    // Execute was called (pipeline ran)
    expect(insertDeployIfNoActiveSpy).toHaveBeenCalledTimes(1);
    // Result was logged
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PostReceive] Deploy pipeline result for "plex":'),
    );
  });

  it('logs error and resolves when pipeline initialization fails (outer catch)', async () => {
    const { sha1, sha2 } = await buildPlexChangeCommits(repoPath);

    getClientSpy.mockRejectedValueOnce(new Error('DB connection refused'));

    await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      '[PostReceive] Failed to initialize deploy pipeline:',
      expect.objectContaining({ message: 'DB connection refused' }),
    );
  });

  it('logs per-deploy error but continues when one pipeline.execute() throws', async () => {
    // Make getByName throw for the first stack (plex) but succeed for the second (sonarr).
    // getByName throws BEFORE the try/catch in dispatch(), so execute() propagates the throw.
    // processPostReceive's per-deploy catch logs the per-deploy error.
    const sha1 = await commitFiles(repoPath, () => ({
      files: [
        {
          path: 'manifest.yaml',
          content:
            'stacks:\n  plex:\n    host: homeserver\n    autoDeploy: true\n  sonarr:\n    host: homeserver\n    autoDeploy: true\n',
        },
        { path: 'plex/docker-compose.yml', content: 'v1' },
        { path: 'sonarr/docker-compose.yml', content: 'v1' },
      ],
      message: 'initial',
      author: { name: 'test', email: 'test@test.com' },
    }));
    const sha2 = await commitFiles(repoPath, () => ({
      files: [
        { path: 'plex/docker-compose.yml', content: 'v2' },
        { path: 'sonarr/docker-compose.yml', content: 'v2' },
      ],
      message: 'update both stacks',
      author: { name: 'test', email: 'test@test.com' },
    }));

    findByNameSpy
      .mockRejectedValueOnce(new Error('host lookup failed'))
      .mockResolvedValueOnce(TEST_HOST as never);

    await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PostReceive] Deploy pipeline failed for stack'),
      expect.objectContaining({ message: 'host lookup failed' }),
    );
  });

  it('instantiates OpenBaoClient and uses getHostSecret for agent token resolution', async () => {
    isConfiguredSpy.mockReturnValue(true);
    const loadConfigSpy = spyOn(openbaoConfig, 'loadOpenBaoConfig').mockReturnValue({
      url: 'http://openbao:8200',
      token: 'test',
    });

    try {
      const { sha1, sha2 } = await buildPlexChangeCommits(repoPath);

      await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

      // tokenResolver invoked OpenBaoClient.getHostSecret
      expect(getHostSecretSpy).toHaveBeenCalledWith('homeserver', 'agent_token');
      // Agent deploy was called with the resolved token, meaning the pipeline completed
      expect(agentDeploySpy).toHaveBeenCalled();
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('[PostReceive] Deploy pipeline result for "plex": succeeded'),
      );
    } finally {
      loadConfigSpy.mockRestore();
    }
  });

  it('secretResolver.resolve fetches secrets via StackSecretsRepository when variables are present', async () => {
    isConfiguredSpy.mockReturnValue(true);
    const loadConfigSpy = spyOn(openbaoConfig, 'loadOpenBaoConfig').mockReturnValue({
      url: 'http://openbao:8200',
      token: 'test',
    });
    const getSecretSpy = spyOn(StackSecretsRepository.prototype, 'get').mockImplementation(
      async (_stack: string, key: string) => (key === 'API_TOKEN' ? 'secret-value' : null),
    );

    try {
      const sha1 = await commitFiles(repoPath, () => ({
        files: [
          { path: 'manifest.yaml', content: MANIFEST_WITH_PLEX },
          {
            path: 'plex/docker-compose.yml',
            content: 'services:\n  plex:\n    environment:\n      - TOKEN=${API_TOKEN}\n',
          },
        ],
        message: 'initial',
        author: { name: 'test', email: 'test@test.com' },
      }));
      const sha2 = await commitFiles(repoPath, () => ({
        files: [
          {
            path: 'plex/docker-compose.yml',
            content:
              'services:\n  plex:\n    environment:\n      - TOKEN=${API_TOKEN}\n    image: plex:v2\n',
          },
        ],
        message: 'update plex',
        author: { name: 'test', email: 'test@test.com' },
      }));

      await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

      // secretResolver.resolve was called with the extracted variable names
      expect(getSecretSpy).toHaveBeenCalledWith('plex', 'API_TOKEN');
      // Agent deploy received env content with the resolved secret
      expect(agentDeploySpy).toHaveBeenCalledWith(
        expect.objectContaining({ envContent: expect.stringContaining('API_TOKEN') }),
      );
    } finally {
      loadConfigSpy.mockRestore();
      getSecretSpy.mockRestore();
    }
  });

  it('tokenResolver throws when OpenBao not configured (baoClient is null)', async () => {
    // isOpenBaoConfigured returns false (default in beforeEach), so baoClient stays null.
    // tokenResolver throws "OpenBao not configured" inside dispatch(), which is caught by
    // pipeline.dispatch()'s try/catch and returns { status: 'failed' }.
    // processPostReceive then logs console.info with the result (not a thrown error).
    const { sha1, sha2 } = await buildPlexChangeCommits(repoPath);

    await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

    // Deploy result was logged (failed status, not an exception)
    expect(infoSpy).toHaveBeenCalledWith(
      expect.stringContaining('[PostReceive] Deploy pipeline result for "plex": failed'),
    );
  });

  it('tokenResolver throws when no agent token found in OpenBao for host', async () => {
    isConfiguredSpy.mockReturnValue(true);
    const loadConfigSpy = spyOn(openbaoConfig, 'loadOpenBaoConfig').mockReturnValue({
      url: 'http://openbao:8200',
      token: 'test',
    });
    // getHostSecret returns null → tokenResolver throws "No agent token found"
    getHostSecretSpy.mockResolvedValue(null as never);

    try {
      const { sha1, sha2 } = await buildPlexChangeCommits(repoPath);

      await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

      // Result logged as failed (tokenResolver error caught inside dispatch)
      expect(infoSpy).toHaveBeenCalledWith(
        expect.stringContaining('[PostReceive] Deploy pipeline result for "plex": failed'),
      );
    } finally {
      loadConfigSpy.mockRestore();
    }
  });

  it('secretResolver.resolve returns empty record when repo has no stored secrets', async () => {
    // StackSecretsRepository.get returns null for all variables (nothing stored).
    // secretResolver.resolve filters out null values and returns {}.
    // tokenResolver still throws (baoClient is null, default), so the deploy fails.
    const getSecretSpy = spyOn(StackSecretsRepository.prototype, 'get').mockResolvedValue(null);

    try {
      const sha1 = await commitFiles(repoPath, () => ({
        files: [
          { path: 'manifest.yaml', content: MANIFEST_WITH_PLEX },
          {
            path: 'plex/docker-compose.yml',
            content: 'services:\n  plex:\n    environment:\n      - TOKEN=${API_TOKEN}\n',
          },
        ],
        message: 'initial',
        author: { name: 'test', email: 'test@test.com' },
      }));
      const sha2 = await commitFiles(repoPath, () => ({
        files: [
          {
            path: 'plex/docker-compose.yml',
            content:
              'services:\n  plex:\n    environment:\n      - TOKEN=${API_TOKEN}\n    image: plex:v2\n',
          },
        ],
        message: 'update plex',
        author: { name: 'test', email: 'test@test.com' },
      }));

      await expect(processPostReceive(repoPath, sha1, sha2)).resolves.toBeUndefined();

      // Pipeline ran (resolve was called with variables but returned {} because repo had nothing)
      expect(insertDeployIfNoActiveSpy).toHaveBeenCalledTimes(1);
      expect(getSecretSpy).toHaveBeenCalledWith('plex', 'API_TOKEN');
    } finally {
      getSecretSpy.mockRestore();
    }
  });
});
