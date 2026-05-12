import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { DeployPipeline, type StackRepoWriter } from '../pipeline';
import type { DeployRecord, DeployRequest, ManagedHost, SecretResolver } from '@/lib/deploy/types';
import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';
import type { HostRepository } from '@/lib/database/repositories/host-repository';
import type { AgentClient } from '@/lib/clients/agent-client';

const defaultPendingRecord = {
  id: 42,
  stack: 'plex',
  host: 'homeserver',
  commitSha: 'abc123',
  composeHash: '',
  envHash: '',
  status: 'pending' as const,
  trigger: 'git_push' as const,
  action: 'deploy' as const,
  forceRecreate: false,
  logs: null,
  createdAt: new Date(),
  postSuccess: null,
};

function createMockStackRepoWriter(): StackRepoWriter & { removeStackFromManifest: ReturnType<typeof mock> } {
  return {
    removeStackFromManifest: mock().mockResolvedValue({ commitSha: 'commit-xyz' }),
  } as StackRepoWriter & { removeStackFromManifest: ReturnType<typeof mock> };
}

function createMockDeployRepo(overrides: Partial<DeployRepository> = {}): DeployRepository {
  return {
    insertDeploy: mock().mockResolvedValue(1),
    insertDeployIfNoActive: mock().mockResolvedValue(1),
    updateStatus: mock().mockResolvedValue(undefined),
    claimPending: mock().mockResolvedValue(true),
    getById: mock().mockResolvedValue(defaultPendingRecord),
    getLatestSuccessful: mock().mockResolvedValue(null),
    hasActiveDeployForStack: mock().mockResolvedValue(false),
    deduplicatePending: mock().mockResolvedValue(undefined),
    getDeployHistory: mock().mockResolvedValue([]),
    getPendingDeploys: mock().mockResolvedValue([]),
    getLatestDeployPerStack: mock().mockResolvedValue([]),
    notifyStackChange: mock().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as DeployRepository;
}

function createMockHostsRepo(host: ManagedHost | null = null): HostRepository {
  return {
    findByName: mock().mockResolvedValue(host),
    findAll: mock().mockResolvedValue(host ? [host] : []),
    create: mock().mockResolvedValue(host),
    updateStatus: mock().mockResolvedValue(undefined),
    updateAgentVersion: mock().mockResolvedValue(undefined),
  } as unknown as HostRepository;
}

function createMockAgentClient(success = true): AgentClient {
  return {
    deploy: mock().mockResolvedValue({ success, logs: success ? 'deployed ok' : 'deploy failed' }),
    teardown: mock().mockResolvedValue({ success, logs: 'torn down' }),
    health: mock().mockResolvedValue({ status: 'healthy', version: '0.1.0' }),
  } as unknown as AgentClient;
}

function createMockSecretResolver(): SecretResolver {
  return {
    resolve: mock().mockResolvedValue({}),
  };
}

const testHost: ManagedHost = {
  id: 1,
  name: 'homeserver',
  agentUrl: 'http://agent:9090',
  capabilities: { docker: true },
  agentVersion: '0.1.0',
  status: 'healthy',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const testRequest: DeployRequest = {
  stack: 'plex',
  host: 'homeserver',
  composeContent: 'version: "3"\nservices:\n  plex:\n    image: plexinc/pms-docker',
  commitSha: 'abc123',
  envContent: '',
  action: 'deploy',
  trigger: 'git_push',
  autoApproved: true,
};

describe('DeployPipeline', () => {
  let deployRepo: ReturnType<typeof createMockDeployRepo>;
  let hostsRepo: ReturnType<typeof createMockHostsRepo>;
  let agentClientFactory: ReturnType<typeof mock>;
  let secretResolver: SecretResolver;
  let pipeline: DeployPipeline;

  beforeEach(() => {
    deployRepo = createMockDeployRepo();
    hostsRepo = createMockHostsRepo(testHost);
    const mockAgent = createMockAgentClient(true);
    agentClientFactory = mock().mockReturnValue(mockAgent);
    secretResolver = createMockSecretResolver();
    pipeline = new DeployPipeline({
      deployRepo: deployRepo as unknown as DeployRepository,
      hostsRepo: hostsRepo as unknown as HostRepository,
      agentClientFactory,
      secretResolver,
      tokenResolver: async () => async () => 'mock-jwt',
      stackRepoWriter: createMockStackRepoWriter(),
    });
  });

  describe('execute', () => {
    it('runs the full pipeline for a deploy action', async () => {
      const result = await pipeline.execute(testRequest);

      expect(result.status).toBe('succeeded');
      expect(result.logs).toBe('deployed ok');
      expect(deployRepo.insertDeployIfNoActive).toHaveBeenCalledTimes(1);
      expect(deployRepo.updateStatus).toHaveBeenCalledTimes(2); // in_progress + succeeded
    });

    it('returns no_change when compose and env are unchanged', async () => {
      const previousDeploy: DeployRecord = {
        id: 1,
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'prev',
        composeHash: '',
        envHash: '',
        status: 'succeeded',
        trigger: 'git_push',
        action: 'deploy',
        forceRecreate: false,
        logs: null,
        createdAt: new Date(),
        postSuccess: null,
      };
      // We need the hashes to match -- compute from the same content
      const { computeHash } = await import('../change-detection');
      previousDeploy.composeHash = computeHash(testRequest.composeContent);
      previousDeploy.envHash = computeHash(testRequest.envContent);

      deployRepo = createMockDeployRepo({
        getLatestSuccessful: mock().mockResolvedValue(previousDeploy) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('no_change');
    });

    it('fails validation when host is not found', async () => {
      hostsRepo = createMockHostsRepo(null);
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      await expect(pipeline.execute(testRequest)).rejects.toThrow('not found in managed_hosts');
    });

    it('rejects deploy when another deploy is active for the stack', async () => {
      deployRepo = createMockDeployRepo({
        insertDeployIfNoActive: mock().mockResolvedValue(null) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('active deploy');
    });

    it('creates a pending record for non-auto-approved requests', async () => {
      const manualRequest = { ...testRequest, autoApproved: false };
      const result = await pipeline.execute(manualRequest);

      expect(result.status).toBe('pending');
      expect(deployRepo.insertDeployIfNoActive).toHaveBeenCalledTimes(1);
      // Should NOT have dispatched to agent
      expect(agentClientFactory).not.toHaveBeenCalled();
    });

    it('records failure when agent dispatch fails', async () => {
      const failAgent = createMockAgentClient(false);
      agentClientFactory = mock().mockReturnValue(failAgent);
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('failed');
    });

    it('handles teardown action', async () => {
      const teardownRequest = { ...testRequest, action: 'teardown' as const };
      const result = await pipeline.execute(teardownRequest);

      expect(result.status).toBe('succeeded');
      const agent = agentClientFactory.mock.results[0].value;
      expect(agent.teardown).toHaveBeenCalled();
    });

    it('resolves secrets and builds env content', async () => {
      const composeWithVars = 'services:\n  app:\n    environment:\n      - TOKEN=${API_TOKEN}';
      const requestWithVars = { ...testRequest, composeContent: composeWithVars };

      const resolver: SecretResolver = {
        resolve: mock().mockResolvedValue({ API_TOKEN: 'secret-value' }),
      };
      const mockAgent = createMockAgentClient(true);
      const capturedFactory = mock().mockReturnValue(mockAgent);
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory: capturedFactory,
        secretResolver: resolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.execute(requestWithVars);
      expect(result.status).toBe('succeeded');
      expect(resolver.resolve).toHaveBeenCalledWith('plex', ['API_TOKEN']);
      // Verify the resolved secret was passed to the agent deploy call
      const deployCall = (mockAgent.deploy as ReturnType<typeof mock>).mock.calls[0] as [any];
      expect(deployCall[0].envContent).toContain("API_TOKEN='secret-value'");
    });

    it('sanitizes newlines in secret values when building env content', async () => {
      const composeWithVars = 'services:\n  app:\n    environment:\n      - KEY=${PEM_KEY}';
      const requestWithVars = { ...testRequest, composeContent: composeWithVars };

      const resolver: SecretResolver = {
        resolve: mock().mockResolvedValue({ PEM_KEY: 'line1\nline2\rline3' }),
      };
      const mockAgent = createMockAgentClient(true);
      const capturedFactory = mock().mockReturnValue(mockAgent);
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory: capturedFactory,
        secretResolver: resolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      await pipeline.execute(requestWithVars);
      const deployCall = (mockAgent.deploy as ReturnType<typeof mock>).mock.calls[0] as [any];
      expect(deployCall[0].envContent).toBe("PEM_KEY='line1line2line3'");
    });

    it('strips outer quotes from existing env values even when followed by CR', async () => {
      // FOO="bar"\r (windows line ending or stray CR after a quoted value).
      // The quote check must ignore trailing CR/LF so the outer quotes get stripped,
      // otherwise we'd end up with FOO='"bar"' (double-quoted) in the rendered env.
      // Compose must reference a variable so the pipeline routes through buildEnvContent.
      const composeWithVars = 'services:\n  app:\n    environment:\n      - TOKEN=${API_TOKEN}';
      const requestWithEnv = {
        ...testRequest,
        composeContent: composeWithVars,
        envContent: 'FOO="bar"\r\nBAZ=qux',
      };
      const resolver: SecretResolver = {
        resolve: mock().mockResolvedValue({ API_TOKEN: 'tok' }),
      };
      const mockAgent = createMockAgentClient(true);
      const capturedFactory = mock().mockReturnValue(mockAgent);
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory: capturedFactory,
        secretResolver: resolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      await pipeline.execute(requestWithEnv);
      const deployCall = (mockAgent.deploy as ReturnType<typeof mock>).mock.calls[0] as [any];
      expect(deployCall[0].envContent).toContain("FOO='bar'");
      expect(deployCall[0].envContent).not.toContain('FOO=\'"bar"\'');
      expect(deployCall[0].envContent).toContain("BAZ='qux'");
    });

    it('deduplicates pending deploys for the same stack', async () => {
      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('succeeded');
      expect(deployRepo.deduplicatePending).toHaveBeenCalled();
    });

    it('continues when deduplicatePending fails', async () => {
      deployRepo = createMockDeployRepo({
        deduplicatePending: mock().mockRejectedValue(new Error('db timeout')) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('succeeded');
    });

    it('catches dispatch errors and records failure', async () => {
      agentClientFactory = mock().mockReturnValue({
        deploy: mock().mockRejectedValue(new Error('connection refused')),
        teardown: mock(),
        health: mock(),
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toBe('connection refused');
      expect(deployRepo.updateStatus).toHaveBeenCalledWith(1, 'failed', 'connection refused');
    });

    it('handles non-Error throw in dispatch', async () => {
      agentClientFactory = mock().mockReturnValue({
        deploy: mock().mockRejectedValue('string error'),
        teardown: mock(),
        health: mock(),
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toBe('string error');
    });

    it('continues and returns correct result when notifyStackChange rejects', async () => {
      deployRepo = createMockDeployRepo({
        notifyStackChange: mock().mockRejectedValue(new Error('pg notify failed')) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('succeeded');
      expect(result.logs).toBe('deployed ok');
    });

    it('skips detectChanges and proceeds when trigger is manual_rollback', async () => {
      const rollbackRequest: DeployRequest = {
        ...testRequest,
        trigger: 'manual_rollback',
      };
      // getLatestSuccessful would reveal a matching previous deploy, but detectChanges
      // should never be called for manual_rollback triggers
      const { computeHash } = await import('../change-detection');
      deployRepo = createMockDeployRepo({
        getLatestSuccessful: mock().mockResolvedValue({
          id: 99,
          stack: 'plex',
          host: 'homeserver',
          commitSha: 'prev',
          composeHash: computeHash(testRequest.composeContent),
          envHash: computeHash(testRequest.envContent),
          status: 'succeeded' as const,
          trigger: 'git_push' as const,
          action: 'deploy' as const,
          forceRecreate: false,
          logs: null,
          createdAt: new Date(),
          postSuccess: null,
        }) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.execute(rollbackRequest);
      // Change detection is bypassed: deploy should proceed even though hashes match
      expect(result.status).toBe('succeeded');
      expect(deployRepo.getLatestSuccessful).not.toHaveBeenCalled();
    });
  });

  describe('postSuccess hook', () => {
    it('invokes removeStackFromManifest after a successful teardown', async () => {
      const writer = createMockStackRepoWriter();
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: writer,
      });

      const teardownRequest: DeployRequest = {
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'abc123',
        action: 'teardown',
        trigger: 'ui',
        autoApproved: true,
        postSuccess: 'removeFromManifest',
      };

      const result = await pipeline.execute(teardownRequest);
      expect(result.status).toBe('succeeded');
      expect(writer.removeStackFromManifest).toHaveBeenCalledTimes(1);
      expect(writer.removeStackFromManifest).toHaveBeenCalledWith('plex');
    });

    it('invokes removeStackFromManifest on the no_change path', async () => {
      // Previous deploy hashes match the request, so deploy becomes no_change.
      const { computeHash } = await import('../change-detection');
      const composeContent = 'version: "3"\nservices:\n  plex:\n    image: plexinc/pms-docker';
      deployRepo = createMockDeployRepo({
        getLatestSuccessful: mock().mockResolvedValue({
          id: 99,
          stack: 'plex',
          host: 'homeserver',
          commitSha: 'prev',
          composeHash: computeHash(composeContent),
          envHash: computeHash(''),
          status: 'succeeded' as const,
          trigger: 'git_push' as const,
          action: 'deploy' as const,
          forceRecreate: false,
          logs: null,
          createdAt: new Date(),
          postSuccess: null,
        }) as any,
      });
      const writer = createMockStackRepoWriter();
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: writer,
      });

      const req: DeployRequest = {
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'abc123',
        composeContent,
        envContent: '',
        action: 'deploy',
        trigger: 'git_push',
        autoApproved: true,
        postSuccess: 'removeFromManifest',
      };

      const result = await pipeline.execute(req);
      expect(result.status).toBe('no_change');
      expect(writer.removeStackFromManifest).toHaveBeenCalledTimes(1);
    });

    it('returns failed and records status when manifest delete throws', async () => {
      const writer = {
        removeStackFromManifest: mock().mockRejectedValue(new Error('git corrupted')),
      } as StackRepoWriter & { removeStackFromManifest: ReturnType<typeof mock> };
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: writer,
      });

      const teardownRequest: DeployRequest = {
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'abc123',
        action: 'teardown',
        trigger: 'ui',
        autoApproved: true,
        postSuccess: 'removeFromManifest',
      };

      const result = await pipeline.execute(teardownRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toBe('git corrupted');
      expect(deployRepo.updateStatus).toHaveBeenCalledWith(
        1,
        'failed',
        expect.stringContaining('manifest delete failed'),
      );
    });

    it('does NOT invoke removeStackFromManifest when deploy fails', async () => {
      const failAgent = createMockAgentClient(false);
      agentClientFactory = mock().mockReturnValue(failAgent);
      const writer = createMockStackRepoWriter();
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: writer,
      });

      const teardownRequest: DeployRequest = {
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'abc123',
        action: 'teardown',
        trigger: 'ui',
        autoApproved: true,
        postSuccess: 'removeFromManifest',
      };

      const result = await pipeline.execute(teardownRequest);
      expect(result.status).toBe('failed');
      expect(writer.removeStackFromManifest).not.toHaveBeenCalled();
    });

    it('does NOT invoke removeStackFromManifest when postSuccess is absent', async () => {
      const writer = createMockStackRepoWriter();
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: writer,
      });

      const teardownRequest: DeployRequest = {
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'abc123',
        action: 'teardown',
        trigger: 'ui',
        autoApproved: true,
      };

      const result = await pipeline.execute(teardownRequest);
      expect(result.status).toBe('succeeded');
      expect(writer.removeStackFromManifest).not.toHaveBeenCalled();
    });
  });

  describe('resumePending', () => {
    it('marks deploy as in_progress and dispatches to agent', async () => {
      const result = await pipeline.resumePending(42, testHost, testRequest);

      expect(result.status).toBe('succeeded');
      expect(deployRepo.claimPending).toHaveBeenCalledWith(42);
      expect(agentClientFactory).toHaveBeenCalled();
    });

    it('rejects resume when claimPending returns false (already claimed or not found)', async () => {
      deployRepo = createMockDeployRepo({
        claimPending: mock().mockResolvedValue(false) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.resumePending(42, testHost, testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('not in pending state');
      expect(deployRepo.updateStatus).not.toHaveBeenCalled();
    });

    it('handles secret resolution failure during resume', async () => {
      const failResolver: SecretResolver = {
        resolve: mock().mockRejectedValue(new Error('vault unreachable')),
      };
      const composeWithVars = 'services:\n  app:\n    environment:\n      - TOKEN=${API_TOKEN}';
      const requestWithVars = { ...testRequest, composeContent: composeWithVars };
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver: failResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.resumePending(42, testHost, requestWithVars);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('Secret resolution failed');
      expect(deployRepo.updateStatus).toHaveBeenCalledWith(42, 'failed', expect.stringContaining('vault unreachable'));
    });

    it('records failure when agent dispatch fails during resume', async () => {
      agentClientFactory = mock().mockReturnValue({
        deploy: mock().mockRejectedValue(new Error('agent down')),
        teardown: mock(),
        health: mock(),
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.resumePending(42, testHost, testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toBe('agent down');
    });
  });
});
