import { describe, it, expect, mock, beforeEach } from 'bun:test';

const mockGetStackSummaries = mock(() => Promise.resolve([
  { name: 'nginx', status: 'running', host: 'server1', lastDeployed: '2026-01-01T00:00:00Z' },
]));
const mockGetStackDetailByName = mock(() => Promise.resolve({
  name: 'nginx',
  composeContent: 'version: "3"',
  variables: {},
}));
const mockTriggerStackDeploy = mock(() => Promise.resolve({ deployId: 42 }));
const mockGetStackDeployHistory = mock(() => Promise.resolve([
  { id: 1, stack: 'nginx', action: 'deploy', status: 'success', timestamp: '2026-01-01T00:00:00Z' },
]));
const mockSaveStackComposeFile = mock(() => Promise.resolve({ commitSha: 'abc123' }));
const mockUpdateStackIconSlug = mock(() => Promise.resolve(undefined));
const mockCreateStackInRepo = mock(() => Promise.resolve({ commitSha: 'abc123' }));
const mockDeleteStackFromRepo = mock((): Promise<{ status: 'removed'; commitSha: string } | { status: 'teardown-pending'; deployId: number }> =>
  Promise.resolve({ status: 'removed' as const, commitSha: 'abc123' }),
);
const mockGetManagedHostNames = mock(() => Promise.resolve(['server1']));
const mockResolveDeleteStack = mock(() =>
  Promise.resolve({ status: 'removed' as const, commitSha: 'abc123' }),
);

mock.module('@/lib/stacks/stack-service', () => ({
  getStackSummaries: mockGetStackSummaries,
  getStackDetailByName: mockGetStackDetailByName,
  triggerStackDeploy: mockTriggerStackDeploy,
  getStackDeployHistory: mockGetStackDeployHistory,
  saveStackComposeFile: mockSaveStackComposeFile,
  updateStackIconSlug: mockUpdateStackIconSlug,
  createStackInRepo: mockCreateStackInRepo,
  deleteStackFromRepo: mockDeleteStackFromRepo,
  getManagedHostNames: mockGetManagedHostNames,
  resolveDeleteStack: mockResolveDeleteStack,
}));

/**
 * Server function tests for stack management.
 *
 * Mocks the stack-service module to avoid database/git dependencies.
 * Tests exports and handler delegation to the stack-service layer.
 *
 * Note: createServerFn() handlers run in test context but the wrapper
 * does not return handler results. Input validation (zod schemas) is
 * applied by the framework at the network boundary, not in direct calls.
 * We verify delegation by asserting mock call counts and arguments.
 */
describe('stacks.functions module', () => {
  beforeEach(() => {
    mockGetStackSummaries.mockClear();
    mockGetStackDetailByName.mockClear();
    mockTriggerStackDeploy.mockClear();
    mockGetStackDeployHistory.mockClear();
    mockSaveStackComposeFile.mockClear();
    mockUpdateStackIconSlug.mockClear();
  });

  describe('exports', () => {
    it('exports listStacks server function', async () => {
      const mod = await import('../functions');
      expect(mod.listStacks).toBeDefined();
      expect(typeof mod.listStacks).toBe('function');
    });

    it('exports getStackDetail server function', async () => {
      const mod = await import('../functions');
      expect(mod.getStackDetail).toBeDefined();
      expect(typeof mod.getStackDetail).toBe('function');
    });

    it('exports triggerDeploy server function', async () => {
      const mod = await import('../functions');
      expect(mod.triggerDeploy).toBeDefined();
      expect(typeof mod.triggerDeploy).toBe('function');
    });

    it('exports getDeployHistory server function', async () => {
      const mod = await import('../functions');
      expect(mod.getDeployHistory).toBeDefined();
      expect(typeof mod.getDeployHistory).toBe('function');
    });

    it('exports saveComposeFile server function', async () => {
      const mod = await import('../functions');
      expect(mod.saveComposeFile).toBeDefined();
      expect(typeof mod.saveComposeFile).toBe('function');
    });

    it('exports updateStackIcon server function', async () => {
      const mod = await import('../functions');
      expect(mod.updateStackIcon).toBeDefined();
      expect(typeof mod.updateStackIcon).toBe('function');
    });
  });

  describe('listStacks', () => {
    it('delegates to getStackSummaries', async () => {
      const { listStacks } = await import('../functions');
      await listStacks({});
      expect(mockGetStackSummaries).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStackDetail', () => {
    it('delegates to getStackDetailByName with stackName', async () => {
      const { getStackDetail } = await import('../functions');
      await getStackDetail({ data: { stackName: 'nginx' } });
      expect(mockGetStackDetailByName).toHaveBeenCalledTimes(1);
      expect(mockGetStackDetailByName).toHaveBeenCalledWith('nginx');
    });

    it('passes through different stack names', async () => {
      const { getStackDetail } = await import('../functions');
      await getStackDetail({ data: { stackName: 'redis' } });
      expect(mockGetStackDetailByName).toHaveBeenCalledWith('redis');
    });
  });

  describe('triggerDeploy', () => {
    it('delegates to triggerStackDeploy with deploy action', async () => {
      const { triggerDeploy } = await import('../functions');
      await triggerDeploy({
        data: { stack: 'nginx', host: 'server1', action: 'deploy' },
      });
      expect(mockTriggerStackDeploy).toHaveBeenCalledTimes(1);
      expect(mockTriggerStackDeploy).toHaveBeenCalledWith({
        stack: 'nginx',
        host: 'server1',
        action: 'deploy',
      });
    });

    it('delegates with teardown action', async () => {
      const { triggerDeploy } = await import('../functions');
      await triggerDeploy({
        data: { stack: 'nginx', host: 'server1', action: 'teardown' },
      });
      expect(mockTriggerStackDeploy).toHaveBeenCalledWith({
        stack: 'nginx',
        host: 'server1',
        action: 'teardown',
      });
    });

    it('delegates with restart action', async () => {
      const { triggerDeploy } = await import('../functions');
      await triggerDeploy({
        data: { stack: 'nginx', host: 'server1', action: 'restart' },
      });
      expect(mockTriggerStackDeploy).toHaveBeenCalledWith({
        stack: 'nginx',
        host: 'server1',
        action: 'restart',
      });
    });
  });

  describe('getDeployHistory', () => {
    it('delegates to getStackDeployHistory with stackName and limit', async () => {
      const { getDeployHistory } = await import('../functions');
      await getDeployHistory({ data: { stackName: 'nginx', limit: 50 } });
      expect(mockGetStackDeployHistory).toHaveBeenCalledTimes(1);
      expect(mockGetStackDeployHistory).toHaveBeenCalledWith('nginx', 50);
    });

    it('passes through stackName correctly', async () => {
      const { getDeployHistory } = await import('../functions');
      await getDeployHistory({ data: { stackName: 'postgres', limit: 10 } });
      expect(mockGetStackDeployHistory).toHaveBeenCalledWith('postgres', 10);
    });
  });

  describe('saveComposeFile', () => {
    it('delegates to saveStackComposeFile with stackName and content', async () => {
      const { saveComposeFile } = await import('../functions');
      await saveComposeFile({
        data: { stackName: 'nginx', content: 'version: "3.8"' },
      });
      expect(mockSaveStackComposeFile).toHaveBeenCalledTimes(1);
      expect(mockSaveStackComposeFile).toHaveBeenCalledWith('nginx', 'version: "3.8"');
    });

    it('handles empty content string', async () => {
      const { saveComposeFile } = await import('../functions');
      await saveComposeFile({ data: { stackName: 'nginx', content: '' } });
      expect(mockSaveStackComposeFile).toHaveBeenCalledWith('nginx', '');
    });
  });

  describe('updateStackIcon', () => {
    it('delegates to updateStackIconSlug with stackName and iconSlug', async () => {
      const { updateStackIcon } = await import('../functions');
      await updateStackIcon({ data: { stackName: 'nginx', iconSlug: 'nginx' } });
      expect(mockUpdateStackIconSlug).toHaveBeenCalledTimes(1);
      expect(mockUpdateStackIconSlug).toHaveBeenCalledWith('nginx', 'nginx');
    });

    it('passes through different icon slugs', async () => {
      const { updateStackIcon } = await import('../functions');
      await updateStackIcon({ data: { stackName: 'redis', iconSlug: 'redis-stack' } });
      expect(mockUpdateStackIconSlug).toHaveBeenCalledWith('redis', 'redis-stack');
    });
  });

  describe('deleteStack', () => {
    it('delegates to deleteStackFromRepo with teardown=true and returns teardown-pending', async () => {
      mockDeleteStackFromRepo.mockImplementationOnce(() =>
        Promise.resolve({ status: 'teardown-pending' as const, deployId: 42 }),
      );
      const { deleteStack } = await import('../functions');
      await deleteStack({ data: { stackName: 'nginx', teardown: true } });
      expect(mockDeleteStackFromRepo).toHaveBeenCalledWith('nginx', true);
    });
  });

  describe('service error propagation', () => {
    it('listStacks propagates service errors', async () => {
      mockGetStackSummaries.mockImplementationOnce(() =>
        Promise.reject(new Error('Database connection failed'))
      );
      const { listStacks } = await import('../functions');
      await expect(listStacks({})).rejects.toThrow('Database connection failed');
    });

    it('getStackDetail propagates service errors', async () => {
      mockGetStackDetailByName.mockImplementationOnce(() =>
        Promise.reject(new Error('Git repo not found'))
      );
      const { getStackDetail } = await import('../functions');
      await expect(
        getStackDetail({ data: { stackName: 'missing' } })
      ).rejects.toThrow('Git repo not found');
    });

    it('triggerDeploy propagates service errors', async () => {
      mockTriggerStackDeploy.mockImplementationOnce(() =>
        Promise.reject(new Error('Agent unreachable'))
      );
      const { triggerDeploy } = await import('../functions');
      await expect(
        triggerDeploy({ data: { stack: 'nginx', host: 'server1', action: 'deploy' } })
      ).rejects.toThrow('Agent unreachable');
    });

    it('saveComposeFile propagates service errors', async () => {
      mockSaveStackComposeFile.mockImplementationOnce(() =>
        Promise.reject(new Error('Commit failed'))
      );
      const { saveComposeFile } = await import('../functions');
      await expect(
        saveComposeFile({ data: { stackName: 'nginx', content: 'bad' } })
      ).rejects.toThrow('Commit failed');
    });

    it('updateStackIcon propagates service errors', async () => {
      mockUpdateStackIconSlug.mockImplementationOnce(() =>
        Promise.reject(new Error('Entity not found'))
      );
      const { updateStackIcon } = await import('../functions');
      await expect(
        updateStackIcon({ data: { stackName: 'nginx', iconSlug: 'bad' } })
      ).rejects.toThrow('Entity not found');
    });

    it('getDeployHistory propagates service errors', async () => {
      mockGetStackDeployHistory.mockImplementationOnce(() =>
        Promise.reject(new Error('Query timeout'))
      );
      const { getDeployHistory } = await import('../functions');
      await expect(
        getDeployHistory({ data: { stackName: 'nginx', limit: 10 } })
      ).rejects.toThrow('Query timeout');
    });
  });
});
