import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { DeployPipeline } from '../pipeline';
import type { DeployRecord, DeployRequest, ManagedHost, SecretResolver } from '@/lib/deploy/types';
import type { DeployRepository } from '@/lib/database/repositories/deploy-repository';
import type { ManagedHostsRepository } from '@/lib/database/repositories/managed-hosts-repository';
import type { AgentClient } from '@/lib/clients/agent-client';

function createMockDeployRepo(overrides: Partial<DeployRepository> = {}): DeployRepository {
  return {
    insertDeploy: mock().mockResolvedValue(1),
    updateStatus: mock().mockResolvedValue(undefined),
    getLatestSuccessful: mock().mockResolvedValue(null),
    hasActiveDeployForStack: mock().mockResolvedValue(false),
    deduplicatePending: mock().mockResolvedValue(undefined),
    getDeployHistory: mock().mockResolvedValue([]),
    getPendingDeploys: mock().mockResolvedValue([]),
    ...overrides,
  } as unknown as DeployRepository;
}

function createMockHostsRepo(host: ManagedHost | null = null): ManagedHostsRepository {
  return {
    getByName: mock().mockResolvedValue(host),
    getAll: mock().mockResolvedValue(host ? [host] : []),
    insert: mock().mockResolvedValue(1),
    updateStatus: mock().mockResolvedValue(undefined),
    updateAgentVersion: mock().mockResolvedValue(undefined),
  } as unknown as ManagedHostsRepository;
}

function createMockAgentClient(success = true): AgentClient {
  return {
    deploy: mock().mockResolvedValue({ success, logs: success ? 'deployed ok' : 'deploy failed' }),
    teardown: mock().mockResolvedValue({ success, logs: 'torn down' }),
    restart: mock().mockResolvedValue({ success, logs: 'restarted' }),
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
  agentTokenHash: '$2b$hash',
  socketProxyUrl: 'tcp://proxy:2375',
  agentVersion: '0.1.0',
  status: 'healthy',
  createdAt: new Date(),
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
      hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
      agentClientFactory,
      secretResolver,
    });
  });

  describe('execute', () => {
    it('runs the full pipeline for a deploy action', async () => {
      const result = await pipeline.execute(testRequest);

      expect(result.status).toBe('succeeded');
      expect(result.logs).toBe('deployed ok');
      expect(deployRepo.insertDeploy).toHaveBeenCalledTimes(1);
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
        logs: null,
        createdAt: new Date(),
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
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('no_change');
    });

    it('fails validation when host is not found', async () => {
      hostsRepo = createMockHostsRepo(null);
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('not found');
    });

    it('rejects deploy when another deploy is active for the stack', async () => {
      deployRepo = createMockDeployRepo({
        hasActiveDeployForStack: mock().mockResolvedValue(true) as any,
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toContain('active deploy');
    });

    it('creates a pending record for non-auto-approved requests', async () => {
      const manualRequest = { ...testRequest, autoApproved: false };
      const result = await pipeline.execute(manualRequest);

      expect(result.status).toBe('pending');
      expect(deployRepo.insertDeploy).toHaveBeenCalledTimes(1);
      // Should NOT have dispatched to agent
      expect(agentClientFactory).not.toHaveBeenCalled();
    });

    it('records failure when agent dispatch fails', async () => {
      const failAgent = createMockAgentClient(false);
      agentClientFactory = mock().mockReturnValue(failAgent);
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
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

    it('handles restart action', async () => {
      const restartRequest = { ...testRequest, action: 'restart' as const };
      const result = await pipeline.execute(restartRequest);

      expect(result.status).toBe('succeeded');
      const agent = agentClientFactory.mock.results[0].value;
      expect(agent.restart).toHaveBeenCalled();
    });

    it('resolves secrets and builds env content', async () => {
      const composeWithVars = 'services:\n  app:\n    environment:\n      - TOKEN=${API_TOKEN}';
      const requestWithVars = { ...testRequest, composeContent: composeWithVars };

      const resolver: SecretResolver = {
        resolve: mock().mockResolvedValue({ API_TOKEN: 'secret-value' }),
      };
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver: resolver,
      });

      const result = await pipeline.execute(requestWithVars);
      expect(result.status).toBe('succeeded');
      expect(resolver.resolve).toHaveBeenCalledWith('plex', ['API_TOKEN']);
    });

    it('deduplicates pending deploys for the same stack', async () => {
      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('succeeded');
      expect(deployRepo.deduplicatePending).toHaveBeenCalled();
    });

    it('catches dispatch errors and records failure', async () => {
      agentClientFactory = mock().mockReturnValue({
        deploy: mock().mockRejectedValue(new Error('connection refused')),
        teardown: mock(),
        restart: mock(),
        health: mock(),
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
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
        restart: mock(),
        health: mock(),
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
      });

      const result = await pipeline.execute(testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toBe('string error');
    });
  });

  describe('resumePending', () => {
    it('marks deploy as in_progress and dispatches to agent', async () => {
      const result = await pipeline.resumePending(42, testHost, testRequest);

      expect(result.status).toBe('succeeded');
      expect(deployRepo.updateStatus).toHaveBeenCalledWith(42, 'in_progress');
      expect(agentClientFactory).toHaveBeenCalled();
    });

    it('records failure when agent dispatch fails during resume', async () => {
      agentClientFactory = mock().mockReturnValue({
        deploy: mock().mockRejectedValue(new Error('agent down')),
        teardown: mock(),
        restart: mock(),
        health: mock(),
      });
      pipeline = new DeployPipeline({
        deployRepo: deployRepo as unknown as DeployRepository,
        hostsRepo: hostsRepo as unknown as ManagedHostsRepository,
        agentClientFactory,
        secretResolver,
      });

      const result = await pipeline.resumePending(42, testHost, testRequest);
      expect(result.status).toBe('failed');
      expect(result.logs).toBe('agent down');
    });
  });
});
