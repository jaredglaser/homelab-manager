import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  extractVariableNames,
  toStackDeployRecord,
  manifestEntryToSummary,
  manifestEntryToDetail,
  handleTriggerDeploy,
} from '@/lib/stacks/stack-mappers';
import type { DeployDeps } from '@/lib/stacks/stack-mappers';
import type { DeployRecord, DeployRequest } from '@/lib/deploy/types';
import type { DeployPipeline } from '@/lib/deploy/pipeline';
import { SAFE_PATH_SEGMENT_PATTERN } from '@/lib/stacks/stack-service';
import * as gitConfig from '@/lib/config/git-config';
import * as pipelineFactory from '@/lib/deploy/pipeline-factory';
import { initBareRepo, commitFiles } from '@/lib/git/repo';
import { composePath } from '@/lib/stacks/stack-repo-layout';
import { getTestTmpDir } from '@/lib/test/tmp-dir';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';

describe('extractVariableNames', () => {
  test('extracts simple variable references', () => {
    expect(extractVariableNames('image: ${APP_IMAGE}')).toEqual(['APP_IMAGE']);
  });

  test('extracts variables with defaults', () => {
    expect(extractVariableNames('port: ${PORT:-8080}')).toEqual(['PORT']);
  });

  test('deduplicates', () => {
    expect(extractVariableNames('${VAR}\n${VAR}')).toEqual(['VAR']);
  });

  test('sorts alphabetically', () => {
    expect(extractVariableNames('${ZEBRA}\n${ALPHA}')).toEqual(['ALPHA', 'ZEBRA']);
  });

  test('returns empty for no variables', () => {
    expect(extractVariableNames('image: nginx:latest')).toEqual([]);
  });

  test('ignores $VAR without braces', () => {
    expect(extractVariableNames('$NO_BRACES')).toEqual([]);
  });

  test('handles underscore-prefixed names', () => {
    expect(extractVariableNames('${_PRIVATE}')).toEqual(['_PRIVATE']);
  });

  test('returns empty for empty string', () => {
    expect(extractVariableNames('')).toEqual([]);
  });
});

describe('toStackDeployRecord', () => {
  const record: DeployRecord = {
    id: 42,
    stack: 'plex',
    host: 'homeserver',
    commitSha: 'abc123',
    composeHash: 'hash1',
    envHash: 'hash2',
    status: 'succeeded',
    trigger: 'ui',
    action: 'deploy',
    forceRecreate: false,
    logs: 'deploy ok',
    createdAt: new Date('2026-03-01T12:00:00Z'),
    postSuccess: null,
  };

  test('converts Date to ISO string', () => {
    const result = toStackDeployRecord(record);
    expect(result.createdAt).toBe('2026-03-01T12:00:00.000Z');
  });

  test('preserves all fields', () => {
    const result = toStackDeployRecord(record);
    expect(result.id).toBe(42);
    expect(result.stack).toBe('plex');
    expect(result.host).toBe('homeserver');
    expect(result.commitSha).toBe('abc123');
    expect(result.envHash).toBe('hash2');
    expect(result.status).toBe('succeeded');
    expect(result.trigger).toBe('ui');
    expect(result.logs).toBe('deploy ok');
  });

  test('handles null logs', () => {
    const result = toStackDeployRecord({ ...record, logs: null });
    expect(result.logs).toBeNull();
  });
});

describe('manifestEntryToSummary', () => {
  test('maps auto deploy entry', () => {
    const result = manifestEntryToSummary('plex', { host: 'homeserver', autoDeploy: true });
    expect(result.name).toBe('plex');
    expect(result.host).toBe('homeserver');
    expect(result.deployMode).toBe('auto');
    expect(result.syncStatus).toBe('unknown');
    expect(result.lastDeployAt).toBeNull();
    expect(result.lastDeployStatus).toBeNull();
    expect(result.containerCount).toBe(0);
    expect(result.icon).toBeNull();
  });

  test('maps manual deploy entry', () => {
    const result = manifestEntryToSummary('traefik', { host: 'gateway', autoDeploy: false });
    expect(result.deployMode).toBe('manual');
  });
});

describe('manifestEntryToDetail', () => {
  test('maps entry with compose content', () => {
    const compose = 'services:\n  app:\n    image: ${APP_IMAGE}\n    ports:\n      - "${PORT:-8080}:80"';
    const result = manifestEntryToDetail('myapp', { host: 'server1', autoDeploy: false }, compose);
    expect(result.name).toBe('myapp');
    expect(result.host).toBe('server1');
    expect(result.composeContent).toBe(compose);
    expect(result.variableNames).toEqual(['APP_IMAGE', 'PORT']);
    expect(result.deployMode).toBe('manual');
  });

  test('maps entry with empty compose', () => {
    const result = manifestEntryToDetail('empty', { host: 'server1', autoDeploy: true }, '');
    expect(result.composeContent).toBe('');
    expect(result.variableNames).toEqual([]);
    expect(result.deployMode).toBe('auto');
  });
});

describe('handleTriggerDeploy', () => {
  function mockDeps(overrides?: Partial<DeployDeps>): DeployDeps {
    return {
      readCompose: mock(() => Promise.resolve('services:\n  app:\n    image: nginx')),
      getCommitSha: mock(() => Promise.resolve('abc123')),
      buildRequest: mock((input) => ({
        stack: input.stack,
        host: input.host,
        composeContent: input.composeContent,
        commitSha: input.commitSha,
        action: input.action as 'deploy',
        trigger: 'ui' as const,
        autoApproved: true,
        envContent: '',
      })),
      executePipeline: mock(() => Promise.resolve({ deployId: 42, status: 'succeeded' as const, logs: 'deployed ok' })),
      ...overrides,
    };
  }

  test('reads compose, gets SHA, builds request, executes pipeline', async () => {
    const deps = mockDeps();
    const result = await handleTriggerDeploy(deps, { stack: 'myapp', host: 'server1', action: 'deploy' });
    expect(result.deployId).toBe(42);
    expect(result.status).toBe('succeeded');
    expect(result.logs).toBe('deployed ok');
    expect(deps.readCompose).toHaveBeenCalledWith('myapp');
    expect(deps.getCommitSha).toHaveBeenCalledTimes(1);
    expect(deps.buildRequest).toHaveBeenCalledTimes(1);
    expect(deps.executePipeline).toHaveBeenCalledTimes(1);
  });

  test('throws when compose missing for deploy action', async () => {
    const deps = mockDeps({
      readCompose: mock(() => Promise.reject(new Error('not found'))),
    });
    await expect(
      handleTriggerDeploy(deps, { stack: 'missing', host: 'server1', action: 'deploy' })
    ).rejects.toThrow(/No compose file found/);
  });

  test('throws when compose missing for update action', async () => {
    const deps = mockDeps({
      readCompose: mock(() => Promise.reject(new Error('not found'))),
    });
    await expect(
      handleTriggerDeploy(deps, { stack: 'missing', host: 'server1', action: 'update' })
    ).rejects.toThrow(/No compose file found/);
  });

  test('allows missing compose for teardown action', async () => {
    const deps = mockDeps({
      readCompose: mock(() => Promise.reject(new Error('not found'))),
    });
    const result = await handleTriggerDeploy(deps, { stack: 'myapp', host: 'server1', action: 'teardown' });
    expect(result.deployId).toBe(42);
  });

  test('throws when pipeline returns no deployId', async () => {
    const deps = mockDeps({
      executePipeline: mock(() => Promise.resolve({ status: 'failed' as const, logs: 'no active host' })),
    });
    await expect(
      handleTriggerDeploy(deps, { stack: 'myapp', host: 'server1', action: 'deploy' })
    ).rejects.toThrow(/Deploy could not be started: no active host/);
  });

  test('passes compose content and commit SHA to buildRequest', async () => {
    const deps = mockDeps({
      readCompose: mock(() => Promise.resolve('custom compose')),
      getCommitSha: mock(() => Promise.resolve('def456')),
    });
    await handleTriggerDeploy(deps, { stack: 'myapp', host: 'server1', action: 'deploy' });
    const call = (deps.buildRequest as ReturnType<typeof mock>).mock.calls[0] as [{ composeContent: string; commitSha: string }];
    expect(call[0].composeContent).toBe('custom compose');
    expect(call[0].commitSha).toBe('def456');
  });
});

describe('triggerStackDeploy', () => {
  // Real temp repo + spyOn/mockRestore, not mock.module: mock.module() isn't reliably reset across files under --isolate.
  let testDir: string;
  let repoPath: string;
  let loadGitConfigSpy: ReturnType<typeof spyOn>;
  let createDeployPipelineSpy: ReturnType<typeof spyOn>;
  let executeMock: ReturnType<typeof mock>;
  let headSha: string;

  beforeEach(async () => {
    testDir = mkdtempSync(join(getTestTmpDir(), 'trigger-deploy-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    headSha = await commitFiles(repoPath, () => ({
      files: [{ path: composePath('plex'), content: 'services:\n  plex:\n    image: plex' }],
      message: 'add plex compose',
      author: { name: 'test', email: 'test@test.com' },
    }));

    loadGitConfigSpy = spyOn(gitConfig, 'loadGitConfig').mockReturnValue({
      reposDir: testDir,
      repoName: 'test',
      repoPath,
    });
    executeMock = mock(() => Promise.resolve({ deployId: 42, status: 'succeeded' as const, logs: 'deployed ok' }));
    createDeployPipelineSpy = spyOn(pipelineFactory, 'createDeployPipeline').mockResolvedValue({
      pipeline: { execute: (request: DeployRequest) => executeMock(request) } as unknown as DeployPipeline,
      deployRepo: {} as never,
      stackRepoWriter: {} as never,
    });
  });

  afterEach(() => {
    loadGitConfigSpy.mockRestore();
    createDeployPipelineSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  test('builds a ui deploy DeployRequest with HEAD as commitSha', async () => {
    const { triggerStackDeploy: freshTriggerStackDeploy } = await import('@/lib/stacks/stack-service');
    const result = await freshTriggerStackDeploy({ stack: 'plex', host: 'homeserver', action: 'deploy' });

    expect(result.deployId).toBe(42);
    expect(result.status).toBe('succeeded');
    expect(result.logs).toBe('deployed ok');
    expect(executeMock).toHaveBeenCalledWith({
      stack: 'plex',
      host: 'homeserver',
      commitSha: headSha,
      trigger: 'ui',
      autoApproved: true,
      action: 'deploy',
      composeContent: 'services:\n  plex:\n    image: plex',
      envContent: '',
      forceRecreate: false,
    });
  });

  test('builds a ui teardown DeployRequest with postSuccess re-attached in the same assembly', async () => {
    const { triggerStackDeploy: freshTriggerStackDeploy } = await import('@/lib/stacks/stack-service');
    await freshTriggerStackDeploy({
      stack: 'plex',
      host: 'homeserver',
      action: 'teardown',
      postSuccess: 'removeFromManifest',
    });

    expect(executeMock).toHaveBeenCalledWith({
      stack: 'plex',
      host: 'homeserver',
      commitSha: headSha,
      trigger: 'ui',
      autoApproved: true,
      postSuccess: 'removeFromManifest',
      action: 'teardown',
    });
  });

  test('builds a ui update DeployRequest with HEAD as commitSha', async () => {
    const { triggerStackDeploy: freshTriggerStackDeploy } = await import('@/lib/stacks/stack-service');
    const result = await freshTriggerStackDeploy({ stack: 'plex', host: 'homeserver', action: 'update' });

    expect(result.deployId).toBe(42);
    expect(result.status).toBe('succeeded');
    expect(result.logs).toBe('deployed ok');
    expect(executeMock).toHaveBeenCalledWith({
      stack: 'plex',
      host: 'homeserver',
      commitSha: headSha,
      trigger: 'ui',
      autoApproved: true,
      action: 'update',
      composeContent: 'services:\n  plex:\n    image: plex',
      envContent: '',
    });
  });

  test('builds a manual_rollback DeployRequest reading compose from the historical commitSha', async () => {
    const rollbackSha = await commitFiles(repoPath, () => ({
      files: [{ path: composePath('plex'), content: 'services:\n  plex:\n    image: plex:old' }],
      message: 'roll back candidate',
      author: { name: 'test', email: 'test@test.com' },
    }));

    const { triggerStackDeploy: freshTriggerStackDeploy } = await import('@/lib/stacks/stack-service');
    await freshTriggerStackDeploy({ stack: 'plex', host: 'homeserver', action: 'deploy', commitSha: rollbackSha });

    expect(executeMock).toHaveBeenCalledWith({
      stack: 'plex',
      host: 'homeserver',
      composeContent: 'services:\n  plex:\n    image: plex:old',
      commitSha: rollbackSha,
      envContent: '',
      action: 'deploy',
      trigger: 'manual_rollback',
      autoApproved: true,
      forceRecreate: true,
    });
  });
});

describe('SAFE_PATH_SEGMENT_PATTERN (createStackInRepo validation)', () => {
  test('accepts valid stack names with letters and numbers', () => {
    expect(SAFE_PATH_SEGMENT_PATTERN.test('mystack')).toBe(true);
    expect(SAFE_PATH_SEGMENT_PATTERN.test('stack123')).toBe(true);
    expect(SAFE_PATH_SEGMENT_PATTERN.test('MyStack')).toBe(true);
  });

  test('accepts stack names with hyphens and underscores', () => {
    expect(SAFE_PATH_SEGMENT_PATTERN.test('my-stack')).toBe(true);
    expect(SAFE_PATH_SEGMENT_PATTERN.test('my_stack')).toBe(true);
    expect(SAFE_PATH_SEGMENT_PATTERN.test('my-stack_v2')).toBe(true);
  });

  test('rejects path traversal: ../evil', () => {
    expect(SAFE_PATH_SEGMENT_PATTERN.test('../evil')).toBe(false);
  });

  test('rejects names with forward slashes: foo/bar', () => {
    expect(SAFE_PATH_SEGMENT_PATTERN.test('foo/bar')).toBe(false);
  });

  test('rejects names with spaces: foo bar', () => {
    expect(SAFE_PATH_SEGMENT_PATTERN.test('foo bar')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(SAFE_PATH_SEGMENT_PATTERN.test('')).toBe(false);
  });

  test('rejects names with dots', () => {
    expect(SAFE_PATH_SEGMENT_PATTERN.test('stack.v2')).toBe(false);
  });

  test('rejects names with special characters', () => {
    expect(SAFE_PATH_SEGMENT_PATTERN.test('stack$name')).toBe(false);
    expect(SAFE_PATH_SEGMENT_PATTERN.test('stack@host')).toBe(false);
  });
});



describe('controlStackForHost', () => {
  const mockStart = mock(() => Promise.resolve({ success: true, logs: '' }));
  const mockStop = mock(() => Promise.resolve({ success: true, logs: '' }));
  const mockRestart = mock(() => Promise.resolve({ success: true, logs: '' }));

  mock.module('@/lib/clients/database-client', () => ({
    databaseConnectionManager: {
      getClient: mock(() => Promise.resolve({ getPool: () => ({}) })),
    },
  }));

  mock.module('@/lib/config/database-config', () => ({
    loadDatabaseConfig: mock(() => ({})),
  }));

  mock.module('@/lib/database/repositories/host-repository', () => ({
    HostRepository: class {
      findByName = mock(() => Promise.resolve({ name: 'server1', agentUrl: 'http://agent:3001' }));
    },
  }));

  mock.module('@/lib/clients/agent-client', () => ({
    AgentClient: class {
      start = mockStart;
      stop = mockStop;
      restart = mockRestart;
    },
  }));

  mock.module('@/lib/database/repositories/agent-keypairs-repository', () => ({
    AgentKeypairsRepository: class {
      getPrivateKeyForHost = mock(() => Promise.resolve({ kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'd' }));
    },
  }));

  mock.module('@/lib/crypto/agent-jwt', () => ({
    signAgentJwt: mock(() => Promise.resolve('mock-jwt')),
  }));

  mock.module('@/lib/crypto/master-key', () => ({
    loadMasterKeyring: mock(() => Promise.resolve({})),
  }));

  // Re-establish the working host-repository mock before each test, because
  // some tests override it to return null and mock.module replacements persist
  // across tests within the same file execution.
  beforeEach(() => {
    mockStart.mockClear();
    mockStop.mockClear();
    mockRestart.mockClear();
    mock.module('@/lib/database/repositories/host-repository', () => ({
      HostRepository: class {
        findByName = mock(() => Promise.resolve({ name: 'server1', agentUrl: 'http://agent:3001' }));
      },
    }));
    mock.module('@/lib/database/repositories/agent-keypairs-repository', () => ({
      AgentKeypairsRepository: class {
        getPrivateKeyForHost = mock(() => Promise.resolve({ kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'd' }));
      },
    }));
  });

  test('calls agent.start for start action', async () => {
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    const req = { stack: 'myapp', scope: 'stack' as const };
    await controlStackForHost('server1', 'start', req);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith(req);
  });

  test('calls agent.stop for stop action', async () => {
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    const req = { stack: 'myapp', scope: 'stack' as const };
    await controlStackForHost('server1', 'stop', req);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledWith(req);
  });

  test('calls agent.restart for restart action', async () => {
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    const req = { stack: 'myapp', scope: 'stack' as const };
    await controlStackForHost('server1', 'restart', req);
    expect(mockRestart).toHaveBeenCalledTimes(1);
    expect(mockRestart).toHaveBeenCalledWith(req);
  });

  test('calls agent.start for service-scope start action', async () => {
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    const req = { stack: 'myapp', scope: 'service' as const, service: 'web' };
    await controlStackForHost('server1', 'start', req);
    expect(mockStart).toHaveBeenCalledTimes(1);
    expect(mockStart).toHaveBeenCalledWith(req);
  });

  test('calls agent.stop for service-scope stop action', async () => {
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    const req = { stack: 'myapp', scope: 'service' as const, service: 'web' };
    await controlStackForHost('server1', 'stop', req);
    expect(mockStop).toHaveBeenCalledTimes(1);
    expect(mockStop).toHaveBeenCalledWith(req);
  });

  test('calls agent.restart for service-scope restart action', async () => {
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    const req = { stack: 'myapp', scope: 'service' as const, service: 'web' };
    await controlStackForHost('server1', 'restart', req);
    expect(mockRestart).toHaveBeenCalledTimes(1);
    expect(mockRestart).toHaveBeenCalledWith(req);
  });

  test('throws when host is not found', async () => {
    mock.module('@/lib/database/repositories/host-repository', () => ({
      HostRepository: class {
        findByName = mock(() => Promise.resolve(null));
      },
    }));
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    await expect(
      controlStackForHost('unknown-host', 'start', { stack: 'myapp', scope: 'stack' })
    ).rejects.toThrow(/not found in managed_hosts/);
  });

  test('throws when agent keypair is missing', async () => {
    mock.module('@/lib/database/repositories/agent-keypairs-repository', () => ({
      AgentKeypairsRepository: class {
        getPrivateKeyForHost = mock(() => Promise.resolve(null));
      },
    }));
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    await expect(
      controlStackForHost('server1', 'start', { stack: 'myapp', scope: 'stack' })
    ).rejects.toThrow(/No agent keypair/);
  });

  test('throws when agent returns success: false', async () => {
    mockStart.mockResolvedValueOnce({ success: false, logs: 'container failed to start' });
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    await expect(
      controlStackForHost('server1', 'start', { stack: 'myapp', scope: 'stack' })
    ).rejects.toThrow(/docker compose start failed/);
  });

  test('rethrows when the agent call itself fails', async () => {
    mockStop.mockRejectedValueOnce(new Error('agent unreachable'));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    await expect(
      controlStackForHost('server1', 'stop', { stack: 'myapp', scope: 'stack' })
    ).rejects.toThrow('agent unreachable');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  test('throws on an action outside the start/stop/restart set', async () => {
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const { controlStackForHost } = await import('@/lib/stacks/stack-service');
    await expect(
      controlStackForHost('server1', 'pause' as never, { stack: 'myapp', scope: 'stack' })
    ).rejects.toThrow(/Unknown action: pause/);
    errorSpy.mockRestore();
  });
});

describe('resolveDeleteStack', () => {
  test('teardown branch: calls triggerDeploy with postSuccess=removeFromManifest and returns teardown-pending', async () => {
    const { resolveDeleteStack } = await import('../delete-stack-resolver');
    const triggerDeploy = mock().mockResolvedValue({ deployId: 123 });
    const commitRemove = mock();
    const result = await resolveDeleteStack('plex', 'homeserver', true, {
      triggerDeploy: triggerDeploy as unknown as (
        params: { stack: string; host: string; action: 'teardown'; postSuccess: 'removeFromManifest' },
      ) => Promise<{ deployId: number }>,
      commitRemoveFromManifest: commitRemove as unknown as (stack: string) => Promise<{ commitSha: string }>,
    });
    expect(triggerDeploy).toHaveBeenCalledWith({
      stack: 'plex',
      host: 'homeserver',
      action: 'teardown',
      postSuccess: 'removeFromManifest',
    });
    expect(commitRemove).not.toHaveBeenCalled();
    expect(result).toEqual({ status: 'teardown-pending', deployId: 123 });
  });

  test('unmanage branch: commits manifest removal and returns removed', async () => {
    const { resolveDeleteStack } = await import('../delete-stack-resolver');
    const triggerDeploy = mock();
    const commitRemove = mock().mockResolvedValue({ commitSha: 'sha-xyz' });
    const result = await resolveDeleteStack('plex', 'homeserver', false, {
      triggerDeploy: triggerDeploy as unknown as (
        params: { stack: string; host: string; action: 'teardown'; postSuccess: 'removeFromManifest' },
      ) => Promise<{ deployId: number }>,
      commitRemoveFromManifest: commitRemove as unknown as (stack: string) => Promise<{ commitSha: string }>,
    });
    expect(triggerDeploy).not.toHaveBeenCalled();
    expect(commitRemove).toHaveBeenCalledWith('plex');
    expect(result).toEqual({ status: 'removed', commitSha: 'sha-xyz' });
  });
});

describe('resumePendingDeploy / rejectPendingDeploy', () => {
  let testDir: string;
  let repoPath: string;
  let loadGitConfigSpy: ReturnType<typeof spyOn>;
  let createDeployPipelineSpy: ReturnType<typeof spyOn>;
  let commitSha: string;
  let pendingRecord: DeployRecord;
  let mockResumePending: ReturnType<typeof mock>;

  const mockGetById = mock(() => Promise.resolve(pendingRecord));
  const mockFindByName = mock(() => Promise.resolve({ name: 'homeserver', agentUrl: 'http://agent:9090' }));
  const mockRejectPending = mock(() => Promise.resolve(true));
  const mockNotifyStackChange = mock(() => Promise.resolve(undefined));

  beforeEach(async () => {
    // Re-registered every test (not just once at collection time): mock.module
    // replacements for these paths persist across describes in this file, so
    // each block must reassert its own before importing stack-service fresh.
    mock.module('@/lib/clients/database-client', () => ({
      databaseConnectionManager: {
        getClient: mock(() => Promise.resolve({ getPool: () => ({}) })),
      },
    }));
    mock.module('@/lib/config/database-config', () => ({
      loadDatabaseConfig: mock(() => ({})),
    }));
    mock.module('@/lib/database/repositories/deploy-repository', () => ({
      DeployRepository: class {
        getById = mockGetById;
        rejectPending = mockRejectPending;
        notifyStackChange = mockNotifyStackChange;
      },
    }));
    mock.module('@/lib/database/repositories/host-repository', () => ({
      HostRepository: class {
        findByName = mockFindByName;
      },
    }));

    testDir = mkdtempSync(join(getTestTmpDir(), 'resume-reject-deploy-'));
    repoPath = join(testDir, 'test.git');
    await initBareRepo(repoPath);
    commitSha = await commitFiles(repoPath, () => ({
      files: [{ path: composePath('plex'), content: 'services:\n  plex:\n    image: plex' }],
      message: 'add plex compose',
      author: { name: 'test', email: 'test@test.com' },
    }));

    loadGitConfigSpy = spyOn(gitConfig, 'loadGitConfig').mockReturnValue({
      reposDir: testDir,
      repoName: 'test',
      repoPath,
    });

    pendingRecord = {
      id: 42,
      stack: 'plex',
      host: 'homeserver',
      commitSha,
      composeHash: '',
      envHash: '',
      status: 'pending',
      trigger: 'git_push',
      action: 'deploy',
      forceRecreate: false,
      logs: null,
      createdAt: new Date(),
      postSuccess: null,
    };

    mockResumePending = mock(() => Promise.resolve({ status: 'succeeded' as const, logs: 'ok', deployId: 42 }));
    createDeployPipelineSpy = spyOn(pipelineFactory, 'createDeployPipeline').mockResolvedValue({
      pipeline: { resumePending: (id: number, host: unknown, req: unknown) => mockResumePending(id, host, req) } as unknown as DeployPipeline,
      deployRepo: {} as never,
      stackRepoWriter: {} as never,
    });

    mockGetById.mockClear();
    mockFindByName.mockClear();
    mockRejectPending.mockClear();
    mockNotifyStackChange.mockClear();
  });

  afterEach(() => {
    loadGitConfigSpy.mockRestore();
    createDeployPipelineSpy.mockRestore();
    rmSync(testDir, { recursive: true, force: true });
  });

  test('resumePendingDeploy returns succeeded status without throwing', async () => {
    const { resumePendingDeploy } = await import('@/lib/stacks/stack-service');
    const result = await resumePendingDeploy(42);
    expect(result).toEqual({ deployId: 42, status: 'succeeded', logs: 'ok' });
  });

  test('resumePendingDeploy builds an update request reading compose at the recorded commitSha', async () => {
    pendingRecord = { ...pendingRecord, action: 'update' };
    const { resumePendingDeploy } = await import('@/lib/stacks/stack-service');
    await resumePendingDeploy(42);

    expect(mockResumePending).toHaveBeenCalledTimes(1);
    const [, , request] = mockResumePending.mock.calls[0] as [number, unknown, DeployRequest];
    expect(request).toEqual({
      stack: 'plex',
      host: 'homeserver',
      commitSha,
      trigger: 'git_push',
      autoApproved: true,
      postSuccess: undefined,
      action: 'update',
      composeContent: 'services:\n  plex:\n    image: plex',
      envContent: '',
    });
  });

  test('resumePendingDeploy returns failed status instead of throwing', async () => {
    mockResumePending.mockImplementationOnce(() =>
      Promise.resolve({ status: 'failed' as const, logs: 'agent down', deployId: 42 }),
    );
    const { resumePendingDeploy } = await import('@/lib/stacks/stack-service');
    const result = await resumePendingDeploy(42);
    expect(result).toEqual({ deployId: 42, status: 'failed', logs: 'agent down' });
  });

  test('rejectPendingDeploy passes a failed outcome with action/trigger/message to notifyStackChange', async () => {
    const { rejectPendingDeploy } = await import('@/lib/stacks/stack-service');
    const result = await rejectPendingDeploy(42);
    expect(result).toEqual({ deployId: 42 });
    expect(mockNotifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
      deployId: 42,
      status: 'failed',
      action: 'deploy',
      trigger: 'git_push',
      message: 'Manually rejected',
    });
  });

  test('resumePendingDeploy builds a teardown request with no compose content', async () => {
    pendingRecord = { ...pendingRecord, action: 'teardown', postSuccess: 'removeFromManifest' };
    const { resumePendingDeploy } = await import('@/lib/stacks/stack-service');
    await resumePendingDeploy(42);

    const [, , request] = mockResumePending.mock.calls[0] as [number, unknown, DeployRequest];
    expect(request).toEqual({
      stack: 'plex',
      host: 'homeserver',
      commitSha,
      trigger: 'git_push',
      autoApproved: true,
      postSuccess: 'removeFromManifest',
      action: 'teardown',
    });
  });

  test('resumePendingDeploy proceeds with empty compose when the file is absent at that commit', async () => {
    pendingRecord = { ...pendingRecord, stack: 'sonarr' };
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const { resumePendingDeploy } = await import('@/lib/stacks/stack-service');
    await resumePendingDeploy(42);

    const [, , request] = mockResumePending.mock.calls[0] as [number, unknown, DeployRequest];
    expect(request).toMatchObject({ action: 'deploy', composeContent: '' });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('resumePendingDeploy throws when the deploy is no longer pending', async () => {
    pendingRecord = { ...pendingRecord, status: 'succeeded' };
    const { resumePendingDeploy } = await import('@/lib/stacks/stack-service');
    await expect(resumePendingDeploy(42)).rejects.toThrow(/not pending \(status: succeeded\)/);
  });

  test('rejectPendingDeploy throws when the deploy is no longer pending', async () => {
    pendingRecord = { ...pendingRecord, status: 'failed' };
    const { rejectPendingDeploy } = await import('@/lib/stacks/stack-service');
    await expect(rejectPendingDeploy(42)).rejects.toThrow(/not pending \(status: failed\)/);
  });

  test('rejectPendingDeploy throws when another client already claimed the deploy', async () => {
    mockRejectPending.mockImplementationOnce(() => Promise.resolve(false));
    const { rejectPendingDeploy } = await import('@/lib/stacks/stack-service');
    await expect(rejectPendingDeploy(42)).rejects.toThrow(/no longer pending/);
    expect(mockNotifyStackChange).not.toHaveBeenCalled();
  });

  test('rejectPendingDeploy still succeeds when the change notification fails', async () => {
    mockNotifyStackChange.mockImplementationOnce(() => Promise.reject(new Error('NOTIFY failed')));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const { rejectPendingDeploy } = await import('@/lib/stacks/stack-service');
    expect(await rejectPendingDeploy(42)).toEqual({ deployId: 42 });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
