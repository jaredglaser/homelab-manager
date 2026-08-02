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
    enqueueDeploy: mock().mockResolvedValue(true),
    dequeueDeploy: mock().mockResolvedValue(null),
    recordQueuedDeploy: mock().mockResolvedValue(99),
    clearQueuedDeploy: mock().mockResolvedValue(undefined),
    failQueuedDeploy: mock().mockResolvedValue(99),
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
    updateAgentInfo: mock().mockResolvedValue(undefined),
  } as unknown as HostRepository;
}

function createMockAgentClient(success = true): AgentClient {
  return {
    deploy: mock().mockResolvedValue({ success, logs: success ? 'deployed ok' : 'deploy failed' }),
    teardown: mock().mockResolvedValue({ success, logs: 'torn down' }),
    update: mock().mockResolvedValue({ success, logs: success ? 'updated ok' : 'update failed' }),
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
  agentImage: null,
  agentImageTag: null,
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
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 1,
        status: 'succeeded',
        action: 'deploy',
        trigger: 'git_push',
      });
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
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 1,
        status: 'no_change',
        action: 'deploy',
        trigger: 'git_push',
      });
      expect(agentClientFactory).not.toHaveBeenCalled();
    });

    it('dispatches an unchanged git_push deploy when forceRecreate is set', async () => {
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

      const forcedGitPushRequest: DeployRequest = { ...testRequest, forceRecreate: true };
      const result = await pipeline.execute(forcedGitPushRequest);

      expect(result.status).toBe('succeeded');
      expect(agentClientFactory).toHaveBeenCalled();
    });

    it('dispatches and records succeeded with populated hashes when content is unchanged but trigger is ui', async () => {
      const previousDeploy: DeployRecord = {
        id: 1,
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'prev',
        composeHash: '',
        envHash: '',
        status: 'succeeded',
        trigger: 'ui',
        action: 'deploy',
        forceRecreate: false,
        logs: null,
        createdAt: new Date(),
        postSuccess: null,
      };
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

      const uiRequest: DeployRequest = { ...testRequest, trigger: 'ui' };
      const result = await pipeline.execute(uiRequest);

      expect(result.status).toBe('succeeded');
      expect(agentClientFactory).toHaveBeenCalled();
      const insertCall = (deployRepo.insertDeployIfNoActive as ReturnType<typeof mock>).mock.calls[0][0];
      expect(insertCall.composeHash).toBe(computeHash(testRequest.composeContent));
      expect(insertCall.envHash).toBe(computeHash(testRequest.envContent));
    });

    it('records failed when an unchanged ui deploy is dispatched to a failing agent', async () => {
      const previousDeploy: DeployRecord = {
        id: 1,
        stack: 'plex',
        host: 'homeserver',
        commitSha: 'prev',
        composeHash: '',
        envHash: '',
        status: 'succeeded',
        trigger: 'ui',
        action: 'deploy',
        forceRecreate: false,
        logs: null,
        createdAt: new Date(),
        postSuccess: null,
      };
      const { computeHash } = await import('../change-detection');
      previousDeploy.composeHash = computeHash(testRequest.composeContent);
      previousDeploy.envHash = computeHash(testRequest.envContent);

      deployRepo = createMockDeployRepo({
        getLatestSuccessful: mock().mockResolvedValue(previousDeploy) as any,
      });
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

      const uiRequest: DeployRequest = { ...testRequest, trigger: 'ui' };
      const result = await pipeline.execute(uiRequest);

      expect(result.status).toBe('failed');
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 1,
        status: 'failed',
        action: 'deploy',
        trigger: 'ui',
        message: 'deploy failed',
      });
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

    it('queues a blocked git push instead of failing', async () => {
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
      expect(result.status).toBe('queued');
      expect(result.logs).toContain('queued commit abc123');
      expect(deployRepo.enqueueDeploy).toHaveBeenCalledWith(testRequest, undefined);
      // No deploy ran: nothing dispatched to the agent
      expect(agentClientFactory).not.toHaveBeenCalled();
    });

    it('records a queued history row so a blocked push is visible', async () => {
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
      expect(result.deployId).toBe(99);
      const recordCall = (deployRepo.recordQueuedDeploy as ReturnType<typeof mock>).mock.calls[0] as [any];
      expect(recordCall[0]).toMatchObject({ stack: 'plex', host: 'homeserver', commitSha: 'abc123', status: 'queued' });
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 99,
        status: 'queued',
        action: 'deploy',
        trigger: 'git_push',
        message: expect.stringContaining('queued commit abc123'),
      });
    });

    it('still reports queued when the history marker cannot be written', async () => {
      deployRepo = createMockDeployRepo({
        insertDeployIfNoActive: mock().mockResolvedValue(null) as any,
        recordQueuedDeploy: mock().mockRejectedValue(new Error('db down')) as any,
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
      expect(result.status).toBe('queued');
      expect(result.deployId).toBeUndefined();
    });

    it('reports no_change when a newer push already won the queue slot', async () => {
      deployRepo = createMockDeployRepo({
        insertDeployIfNoActive: mock().mockResolvedValue(null) as any,
        enqueueDeploy: mock().mockResolvedValue(false) as any,
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
      expect(result.logs).toContain('superseded');
      expect(deployRepo.recordQueuedDeploy).not.toHaveBeenCalled();
    });

    it('rejects a blocked UI deploy with an immediate failed response', async () => {
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

      const uiRequest: DeployRequest = { ...testRequest, trigger: 'ui' };
      const result = await pipeline.execute(uiRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('active deploy');
      expect(deployRepo.enqueueDeploy).not.toHaveBeenCalled();
    });

    it('returns failed when queueing a blocked git push fails', async () => {
      deployRepo = createMockDeployRepo({
        insertDeployIfNoActive: mock().mockResolvedValue(null) as any,
        enqueueDeploy: mock().mockRejectedValue(new Error('db down')) as any,
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
      expect(result.logs).toContain('queueing failed');
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
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 1,
        status: 'failed',
        action: 'deploy',
        trigger: 'git_push',
        message: 'deploy failed',
      });
    });

    it('handles teardown action', async () => {
      const teardownRequest = { ...testRequest, action: 'teardown' as const };
      const result = await pipeline.execute(teardownRequest);

      expect(result.status).toBe('succeeded');
      const agent = agentClientFactory.mock.results[0].value;
      expect(agent.teardown).toHaveBeenCalled();
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 1,
        status: 'succeeded',
        action: 'teardown',
        trigger: 'git_push',
      });
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

    it('drains the queued push after a successful deploy', async () => {
      const queuedRequest: DeployRequest = { ...testRequest, commitSha: 'def456' };
      deployRepo = createMockDeployRepo({
        dequeueDeploy: mock()
          .mockResolvedValueOnce({ request: queuedRequest, queuedAt: new Date('2026-06-01') })
          .mockResolvedValue(null) as any,
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
      // The queued request went through a full second pipeline run
      expect(deployRepo.insertDeployIfNoActive).toHaveBeenCalledTimes(2);
      const secondInsert = (deployRepo.insertDeployIfNoActive as ReturnType<typeof mock>).mock.calls[1] as [any];
      expect(secondInsert[0].commitSha).toBe('def456');
    });

    it('drains the queued push after a failed deploy', async () => {
      const failAgent = createMockAgentClient(false);
      agentClientFactory = mock().mockReturnValue(failAgent);
      const queuedRequest: DeployRequest = { ...testRequest, commitSha: 'def456' };
      deployRepo = createMockDeployRepo({
        dequeueDeploy: mock()
          .mockResolvedValueOnce({ request: queuedRequest, queuedAt: new Date('2026-06-01') })
          .mockResolvedValue(null) as any,
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
      expect(deployRepo.insertDeployIfNoActive).toHaveBeenCalledTimes(2);
    });

    it('drains the queued push when agent dispatch throws', async () => {
      agentClientFactory = mock().mockReturnValue({
        deploy: mock().mockRejectedValue(new Error('connection refused')),
        teardown: mock(),
        health: mock(),
      });
      const queuedRequest: DeployRequest = { ...testRequest, commitSha: 'def456' };
      deployRepo = createMockDeployRepo({
        dequeueDeploy: mock()
          .mockResolvedValueOnce({ request: queuedRequest, queuedAt: new Date('2026-06-01') })
          .mockResolvedValue(null) as any,
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
      expect(deployRepo.insertDeployIfNoActive).toHaveBeenCalledTimes(2);
    });

    it('re-enqueues a drained request with its original timestamp when it loses the insert race', async () => {
      const queuedAt = new Date('2026-06-01T00:00:00Z');
      const queuedRequest: DeployRequest = { ...testRequest, commitSha: 'def456' };
      deployRepo = createMockDeployRepo({
        // First insert: original deploy proceeds. Second insert: the drained
        // request hits the active-deploy index (a concurrent push won the race).
        insertDeployIfNoActive: mock()
          .mockResolvedValueOnce(1)
          .mockResolvedValueOnce(null) as any,
        dequeueDeploy: mock()
          .mockResolvedValueOnce({ request: queuedRequest, queuedAt })
          .mockResolvedValue(null) as any,
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
      // Original queuedAt is preserved so an even newer queued push cannot be replaced
      expect(deployRepo.enqueueDeploy).toHaveBeenCalledWith(queuedRequest, queuedAt);
    });

    it('discards a queued request that a newer commit already superseded', async () => {
      const queuedAt = new Date('2026-06-01T00:00:00Z');
      const queuedRequest: DeployRequest = { ...testRequest, commitSha: 'old111' };
      const supersedingDeploy: DeployRecord = {
        ...defaultPendingRecord,
        id: 7,
        commitSha: 'new999',
        composeHash: 'other-compose-hash',
        envHash: 'other-env-hash',
        status: 'succeeded',
        createdAt: new Date('2026-06-01T00:05:00Z'),
      };
      deployRepo = createMockDeployRepo({
        getLatestSuccessful: mock().mockResolvedValue(supersedingDeploy) as any,
        dequeueDeploy: mock()
          .mockResolvedValueOnce({ request: queuedRequest, queuedAt })
          .mockResolvedValue(null) as any,
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
      // The stale commit never reached a second pipeline run, so it cannot revert the stack
      expect(deployRepo.insertDeployIfNoActive).toHaveBeenCalledTimes(1);
      expect(deployRepo.failQueuedDeploy).toHaveBeenCalledWith(
        'plex',
        'homeserver',
        expect.stringContaining('old111'),
      );
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 99,
        status: 'failed',
        action: 'deploy',
        trigger: 'git_push',
        message: expect.stringContaining('new999'),
      });
    });

    it('discards a queued request whose commit is already the deployed one', async () => {
      const queuedRequest: DeployRequest = { ...testRequest, commitSha: 'abc123' };
      deployRepo = createMockDeployRepo({
        getLatestSuccessful: mock().mockResolvedValue({
          ...defaultPendingRecord,
          composeHash: 'other-compose-hash',
          envHash: 'other-env-hash',
          status: 'succeeded',
          createdAt: new Date('2020-01-01T00:00:00Z'),
        }) as any,
        dequeueDeploy: mock()
          .mockResolvedValueOnce({ request: queuedRequest, queuedAt: new Date('2026-06-01T00:00:00Z') })
          .mockResolvedValue(null) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      await pipeline.execute(testRequest);
      expect(deployRepo.insertDeployIfNoActive).toHaveBeenCalledTimes(1);
      expect(deployRepo.failQueuedDeploy).toHaveBeenCalled();
    });

    it('dispatches a queued request that predates the last successful deploy', async () => {
      const queuedRequest: DeployRequest = { ...testRequest, commitSha: 'def456' };
      deployRepo = createMockDeployRepo({
        getLatestSuccessful: mock().mockResolvedValue({
          ...defaultPendingRecord,
          commitSha: 'older000',
          composeHash: 'other-compose-hash',
          envHash: 'other-env-hash',
          status: 'succeeded',
          createdAt: new Date('2026-05-01T00:00:00Z'),
        }) as any,
        dequeueDeploy: mock()
          .mockResolvedValueOnce({ request: queuedRequest, queuedAt: new Date('2026-06-01T00:00:00Z') })
          .mockResolvedValue(null) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      await pipeline.execute(testRequest);
      expect(deployRepo.insertDeployIfNoActive).toHaveBeenCalledTimes(2);
      expect(deployRepo.failQueuedDeploy).not.toHaveBeenCalled();
    });

    it('returns the deploy result even when the drained request throws', async () => {
      const queuedRequest: DeployRequest = { ...testRequest, commitSha: 'def456' };
      deployRepo = createMockDeployRepo({
        dequeueDeploy: mock()
          .mockResolvedValueOnce({ request: queuedRequest, queuedAt: new Date('2026-06-01') })
          .mockResolvedValue(null) as any,
      });
      // Host lookup succeeds for the original deploy, then throws for the
      // drained request so execute rejects inside drainQueue
      hostsRepo = {
        findByName: mock()
          .mockResolvedValueOnce(testHost)
          .mockRejectedValue(new Error('host lookup failed')),
      } as unknown as HostRepository;
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('succeeded');
      expect(result.logs).toBe('deployed ok');
    });

    it('returns the deploy result even when queue drain fails', async () => {
      deployRepo = createMockDeployRepo({
        dequeueDeploy: mock().mockRejectedValue(new Error('db down')) as any,
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
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 1,
        status: 'failed',
        action: 'deploy',
        trigger: 'git_push',
        message: 'connection refused',
      });
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

  describe('update action', () => {
    const testUpdateRequest: DeployRequest = {
      stack: 'plex',
      host: 'homeserver',
      composeContent: 'version: "3"\nservices:\n  plex:\n    image: plexinc/pms-docker:latest',
      commitSha: 'abc123',
      envContent: '',
      action: 'update',
      trigger: 'ui',
      autoApproved: true,
    };

    it('skips change detection and always executes, even when a matching previous deploy exists', async () => {
      const { computeHash } = await import('../change-detection');
      deployRepo = createMockDeployRepo({
        getLatestSuccessful: mock().mockResolvedValue({
          id: 99,
          stack: 'plex',
          host: 'homeserver',
          commitSha: 'prev',
          composeHash: computeHash(testUpdateRequest.composeContent),
          envHash: computeHash(testUpdateRequest.envContent),
          status: 'succeeded' as const,
          trigger: 'ui' as const,
          action: 'update' as const,
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

      const result = await pipeline.execute(testUpdateRequest);
      expect(result.status).toBe('succeeded');
      expect(deployRepo.getLatestSuccessful).not.toHaveBeenCalled();
    });

    it('records composeHash/envHash computed exactly like the deploy path', async () => {
      const { computeHash } = await import('../change-detection');
      const result = await pipeline.execute(testUpdateRequest);
      expect(result.status).toBe('succeeded');

      const insertCall = (deployRepo.insertDeployIfNoActive as ReturnType<typeof mock>).mock.calls[0][0];
      expect(insertCall.composeHash).toBe(computeHash(testUpdateRequest.composeContent));
      expect(insertCall.envHash).toBe(computeHash(testUpdateRequest.envContent));
    });

    it('records composeHash/envHash against the resolved env content, not the raw env', async () => {
      const composeWithVars = 'services:\n  app:\n    environment:\n      - TOKEN=${API_TOKEN}';
      const requestWithVars = { ...testUpdateRequest, composeContent: composeWithVars };
      const resolver: SecretResolver = {
        resolve: mock().mockResolvedValue({ API_TOKEN: 'secret-value' }),
      };
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver: resolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      const { computeHash } = await import('../change-detection');
      const result = await pipeline.execute(requestWithVars);
      expect(result.status).toBe('succeeded');

      const insertCall = (deployRepo.insertDeployIfNoActive as ReturnType<typeof mock>).mock.calls[0][0];
      expect(insertCall.composeHash).toBe(computeHash(composeWithVars));
      expect(insertCall.envHash).toBe(computeHash("API_TOKEN='secret-value'"));
    });

    it('resolves secrets before dispatching to the agent', async () => {
      const composeWithVars = 'services:\n  app:\n    environment:\n      - TOKEN=${API_TOKEN}';
      const requestWithVars = { ...testUpdateRequest, composeContent: composeWithVars };
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

      await pipeline.execute(requestWithVars);
      expect(resolver.resolve).toHaveBeenCalledWith('plex', ['API_TOKEN']);
      const updateCall = (mockAgent.update as ReturnType<typeof mock>).mock.calls[0][0];
      expect(updateCall.envContent).toContain("API_TOKEN='secret-value'");
    });

    it('dispatches agent.update with stack, composeContent, envContent (no forceRecreate)', async () => {
      const mockAgent = createMockAgentClient(true);
      agentClientFactory = mock().mockReturnValue(mockAgent);
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as HostRepository,
        agentClientFactory,
        secretResolver,
        tokenResolver: async () => async () => 'mock-jwt',
        stackRepoWriter: createMockStackRepoWriter(),
      });

      await pipeline.execute(testUpdateRequest);
      expect(mockAgent.update).toHaveBeenCalledWith({
        stack: 'plex',
        composeContent: testUpdateRequest.composeContent,
        envContent: '',
      });
      expect(mockAgent.deploy).not.toHaveBeenCalled();
    });

    it('records forceRecreate:false on the deploy_history row', async () => {
      await pipeline.execute(testUpdateRequest);
      const insertCall = (deployRepo.insertDeployIfNoActive as ReturnType<typeof mock>).mock.calls[0][0];
      expect(insertCall.forceRecreate).toBe(false);
    });

    it('rejects when another deploy is active for the stack', async () => {
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

      const result = await pipeline.execute(testUpdateRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('active deploy');
    });

    it('records failure when the agent update call fails', async () => {
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

      const result = await pipeline.execute(testUpdateRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toBe('update failed');
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 1,
        status: 'failed',
        action: 'update',
        trigger: 'ui',
        message: 'update failed',
      });
    });

    it('records failure when the agent update call throws (e.g. 404 old-agent error)', async () => {
      agentClientFactory = mock().mockReturnValue({
        deploy: mock(),
        teardown: mock(),
        update: mock().mockRejectedValue(new Error('Agent on agent:9090 does not support image updates. Update the agent container and retry.')),
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

      const result = await pipeline.execute(testUpdateRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('does not support image updates');
    });
  });

  describe('dispatch exhaustiveness', () => {
    it('throws for an unknown action reaching dispatch', async () => {
      const bogusRequest = { ...testRequest, action: 'bogus' } as unknown as DeployRequest;
      const result = await pipeline.execute(bogusRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('Unknown deploy action');
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
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 1,
        status: 'failed',
        action: 'teardown',
        trigger: 'ui',
        message: 'git corrupted',
      });
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
      expect(deployRepo.notifyStackChange).toHaveBeenCalledWith('plex', 'homeserver', {
        deployId: 42,
        status: 'failed',
        action: 'deploy',
        trigger: 'git_push',
        message: expect.stringContaining('vault unreachable'),
      });
      expect(deployRepo.dequeueDeploy).toHaveBeenCalledWith('plex', 'homeserver');
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
