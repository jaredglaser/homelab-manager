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

mock.module('@/lib/stacks/stack-service', () => ({
  getStackSummaries: mockGetStackSummaries,
  getStackDetailByName: mockGetStackDetailByName,
  triggerStackDeploy: mockTriggerStackDeploy,
  getStackDeployHistory: mockGetStackDeployHistory,
  saveStackComposeFile: mockSaveStackComposeFile,
  updateStackIconSlug: mockUpdateStackIconSlug,
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
      const mod = await import('../stacks.functions');
      expect(mod.listStacks).toBeDefined();
      expect(typeof mod.listStacks).toBe('function');
    });

    it('exports getStackDetail server function', async () => {
      const mod = await import('../stacks.functions');
      expect(mod.getStackDetail).toBeDefined();
      expect(typeof mod.getStackDetail).toBe('function');
    });

    it('exports triggerDeploy server function', async () => {
      const mod = await import('../stacks.functions');
      expect(mod.triggerDeploy).toBeDefined();
      expect(typeof mod.triggerDeploy).toBe('function');
    });

    it('exports getDeployHistory server function', async () => {
      const mod = await import('../stacks.functions');
      expect(mod.getDeployHistory).toBeDefined();
      expect(typeof mod.getDeployHistory).toBe('function');
    });

    it('exports saveComposeFile server function', async () => {
      const mod = await import('../stacks.functions');
      expect(mod.saveComposeFile).toBeDefined();
      expect(typeof mod.saveComposeFile).toBe('function');
    });

    it('exports updateStackIcon server function', async () => {
      const mod = await import('../stacks.functions');
      expect(mod.updateStackIcon).toBeDefined();
      expect(typeof mod.updateStackIcon).toBe('function');
    });
  });

  describe('listStacks', () => {
    it('delegates to getStackSummaries', async () => {
      const { listStacks } = await import('../stacks.functions');
      await listStacks({});
      expect(mockGetStackSummaries).toHaveBeenCalledTimes(1);
    });
  });

  describe('getStackDetail', () => {
    it('delegates to getStackDetailByName with stackName', async () => {
      const { getStackDetail } = await import('../stacks.functions');
      await getStackDetail({ data: { stackName: 'nginx' } });
      expect(mockGetStackDetailByName).toHaveBeenCalledTimes(1);
      expect(mockGetStackDetailByName).toHaveBeenCalledWith('nginx');
    });

    it('passes through different stack names', async () => {
      const { getStackDetail } = await import('../stacks.functions');
      await getStackDetail({ data: { stackName: 'redis' } });
      expect(mockGetStackDetailByName).toHaveBeenCalledWith('redis');
    });
  });

  describe('triggerDeploy', () => {
    it('requires admin or operator role (rejects unauthenticated calls)', async () => {
      const { triggerDeploy } = await import('../stacks.functions');
      await expect(
        triggerDeploy({ data: { stack: 'nginx', host: 'server1', action: 'deploy' } }),
      ).rejects.toThrow('Insufficient permissions');
    });

    it('requires admin or operator role for teardown', async () => {
      const { triggerDeploy } = await import('../stacks.functions');
      await expect(
        triggerDeploy({ data: { stack: 'nginx', host: 'server1', action: 'teardown' } }),
      ).rejects.toThrow('Insufficient permissions');
    });

    it('requires admin or operator role for restart', async () => {
      const { triggerDeploy } = await import('../stacks.functions');
      await expect(
        triggerDeploy({ data: { stack: 'nginx', host: 'server1', action: 'restart' } }),
      ).rejects.toThrow('Insufficient permissions');
    });
  });

  describe('getDeployHistory', () => {
    it('delegates to getStackDeployHistory with stackName and limit', async () => {
      const { getDeployHistory } = await import('../stacks.functions');
      await getDeployHistory({ data: { stackName: 'nginx', limit: 50 } });
      expect(mockGetStackDeployHistory).toHaveBeenCalledTimes(1);
      expect(mockGetStackDeployHistory).toHaveBeenCalledWith('nginx', 50);
    });

    it('passes through stackName correctly', async () => {
      const { getDeployHistory } = await import('../stacks.functions');
      await getDeployHistory({ data: { stackName: 'postgres', limit: 10 } });
      expect(mockGetStackDeployHistory).toHaveBeenCalledWith('postgres', 10);
    });
  });

  describe('saveComposeFile', () => {
    it('requires admin or operator role (rejects unauthenticated calls)', async () => {
      const { saveComposeFile } = await import('../stacks.functions');
      await expect(
        saveComposeFile({ data: { stackName: 'nginx', content: 'version: "3.8"' } }),
      ).rejects.toThrow('Insufficient permissions');
    });

    it('requires admin or operator role for empty content', async () => {
      const { saveComposeFile } = await import('../stacks.functions');
      await expect(
        saveComposeFile({ data: { stackName: 'nginx', content: '' } }),
      ).rejects.toThrow('Insufficient permissions');
    });
  });

  describe('updateStackIcon', () => {
    it('requires admin or operator role (rejects unauthenticated calls)', async () => {
      const { updateStackIcon } = await import('../stacks.functions');
      await expect(
        updateStackIcon({ data: { stackName: 'nginx', iconSlug: 'nginx' } }),
      ).rejects.toThrow('Insufficient permissions');
    });

    it('requires admin or operator role for different icon slugs', async () => {
      const { updateStackIcon } = await import('../stacks.functions');
      await expect(
        updateStackIcon({ data: { stackName: 'redis', iconSlug: 'redis-stack' } }),
      ).rejects.toThrow('Insufficient permissions');
    });
  });

  describe('service error propagation', () => {
    it('listStacks propagates service errors', async () => {
      mockGetStackSummaries.mockImplementationOnce(() =>
        Promise.reject(new Error('Database connection failed'))
      );
      const { listStacks } = await import('../stacks.functions');
      await expect(listStacks({})).rejects.toThrow('Database connection failed');
    });

    it('getStackDetail propagates service errors', async () => {
      mockGetStackDetailByName.mockImplementationOnce(() =>
        Promise.reject(new Error('Git repo not found'))
      );
      const { getStackDetail } = await import('../stacks.functions');
      await expect(
        getStackDetail({ data: { stackName: 'missing' } })
      ).rejects.toThrow('Git repo not found');
    });

    it('triggerDeploy is auth-gated (ForbiddenError before service layer)', async () => {
      const { triggerDeploy } = await import('../stacks.functions');
      await expect(
        triggerDeploy({ data: { stack: 'nginx', host: 'server1', action: 'deploy' } })
      ).rejects.toThrow('Insufficient permissions');
      expect(mockTriggerStackDeploy).not.toHaveBeenCalled();
    });

    it('saveComposeFile is auth-gated (ForbiddenError before service layer)', async () => {
      const { saveComposeFile } = await import('../stacks.functions');
      await expect(
        saveComposeFile({ data: { stackName: 'nginx', content: 'bad' } })
      ).rejects.toThrow('Insufficient permissions');
      expect(mockSaveStackComposeFile).not.toHaveBeenCalled();
    });

    it('updateStackIcon is auth-gated (ForbiddenError before service layer)', async () => {
      const { updateStackIcon } = await import('../stacks.functions');
      await expect(
        updateStackIcon({ data: { stackName: 'nginx', iconSlug: 'bad' } })
      ).rejects.toThrow('Insufficient permissions');
      expect(mockUpdateStackIconSlug).not.toHaveBeenCalled();
    });

    it('getDeployHistory propagates service errors', async () => {
      mockGetStackDeployHistory.mockImplementationOnce(() =>
        Promise.reject(new Error('Query timeout'))
      );
      const { getDeployHistory } = await import('../stacks.functions');
      await expect(
        getDeployHistory({ data: { stackName: 'nginx', limit: 10 } })
      ).rejects.toThrow('Query timeout');
    });
  });
});
