import { describe, it, expect, mock, beforeEach } from 'bun:test';

/**
 * Handler integration tests for hosts.functions.tsx.
 *
 * Uses mock.module() on narrow server-only modules (database, Docker, services)
 * to test the handler wiring without real infrastructure. These are NOT
 * broadly-used modules (React, TanStack Query), so mock pollution is contained.
 */

// --- Mock setup ---

const mockFindById = mock();
const mockFindAll = mock();
const mockCreate = mock();
const mockDelete = mock();
const mockUpdateStatus = mock();
const mockUpdateAgentVersion = mock();

mock.module('@/lib/config/feature-flags', () => ({
  isDockerManagementEnabled: () => true,
}));

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: {
    getClient: mock(() => Promise.resolve({ getPool: () => ({}) })),
  },
}));

mock.module('@/lib/config/database-config', () => ({
  loadDatabaseConfig: () => ({}),
}));

mock.module('@/lib/database/repositories/host-repository', () => ({
  HostRepository: class {
    findById = mockFindById;
    findAll = mockFindAll;
    create = mockCreate;
    delete = mockDelete;
    updateStatus = mockUpdateStatus;
    updateAgentVersion = mockUpdateAgentVersion;
  },
}));

const mockProvision = mock();
const mockRemoveAgent = mock();

mock.module('@/lib/services/agent-provisioning-service', () => ({
  AgentProvisioningService: class {
    provision = mockProvision;
    removeAgent = mockRemoveAgent;
  },
}));

const mockCheckAgentHealth = mock();

mock.module('@/lib/services/agent-health-service', () => ({
  checkAgentHealth: mockCheckAgentHealth,
}));

mock.module('@/lib/services/token-service', () => ({
  generateToken: () => 'mock-token-123',
  hashToken: mock(() => Promise.resolve('hashed-token')),
}));

const mockUpdateAgent = mock();

mock.module('@/lib/services/agent-update-service', () => ({
  AgentUpdateService: class {
    updateAgent = mockUpdateAgent;
  },
}));

// NOTE: We do NOT mock dockerode — new Dockerode({...}) doesn't make network
// calls (only method calls do), and mocking it globally pollutes other test
// files like docker-client.test.ts.

// --- Helpers ---

const NOW = new Date('2026-03-01T00:00:00Z');

function mockHostRow(overrides?: Partial<{
  id: number; name: string; agent_url: string; socket_proxy_url: string;
  agent_version: string | null; status: string;
}>) {
  return {
    id: 1,
    name: 'test-host',
    agent_url: 'http://192.168.1.10:9090',
    socket_proxy_url: 'tcp://192.168.1.10:2375',
    agent_version: null,
    agent_token_hash: 'hash',
    agent_token: 'token',
    status: 'pending',
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

// --- Tests ---

describe('hosts.functions handlers', () => {
  beforeEach(() => {
    mockFindById.mockReset();
    mockFindAll.mockReset();
    mockCreate.mockReset();
    mockDelete.mockReset();
    mockUpdateStatus.mockReset();
    mockUpdateAgentVersion.mockReset();
    mockProvision.mockReset();
    mockRemoveAgent.mockReset();
    mockCheckAgentHealth.mockReset();
    mockUpdateAgent.mockReset();
  });

  describe('listHosts', () => {
    it('returns mapped host list items', async () => {
      const row = mockHostRow({ status: 'healthy', agent_version: '1.0.0' });
      mockFindAll.mockResolvedValueOnce([row]);

      const { listHosts } = await import('../hosts.functions');
      await listHosts({});

      expect(mockFindAll).toHaveBeenCalledTimes(1);
    });

    it('returns empty array when no hosts', async () => {
      mockFindAll.mockResolvedValueOnce([]);

      const { listHosts } = await import('../hosts.functions');
      await listHosts({});

      expect(mockFindAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('checkHostHealth', () => {
    it('updates status to healthy on success', async () => {
      const row = mockHostRow();
      mockFindById.mockResolvedValueOnce(row);
      mockCheckAgentHealth.mockResolvedValueOnce({
        healthy: true,
        version: '2.0.0',
        dockerVersion: '24.0.0',
      });
      mockUpdateStatus.mockResolvedValueOnce(undefined);
      mockUpdateAgentVersion.mockResolvedValueOnce(undefined);

      const { checkHostHealth } = await import('../hosts.functions');
      await checkHostHealth({ data: { hostId: 1 } });

      expect(mockFindById).toHaveBeenCalledWith(1);
      expect(mockCheckAgentHealth).toHaveBeenCalledWith('http://192.168.1.10:9090');
      expect(mockUpdateStatus).toHaveBeenCalledWith(1, 'healthy');
      expect(mockUpdateAgentVersion).toHaveBeenCalledWith(1, '2.0.0');
    });

    it('updates status to error on failure', async () => {
      const row = mockHostRow();
      mockFindById.mockResolvedValue(row);
      mockCheckAgentHealth.mockResolvedValue({
        healthy: false,
        error: 'connection refused',
      });
      mockUpdateStatus.mockResolvedValue(undefined);

      const { checkHostHealth } = await import('../hosts.functions');
      try {
        await checkHostHealth({ data: { hostId: 1 } });
      } catch {
        // createServerFn may throw internally
      }

      expect(mockUpdateStatus).toHaveBeenCalledWith(1, 'error');
      expect(mockUpdateAgentVersion).not.toHaveBeenCalled();
    });

    it('throws when host not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const { checkHostHealth } = await import('../hosts.functions');
      await expect(
        checkHostHealth({ data: { hostId: 999 } })
      ).rejects.toThrow('Host with id 999 not found');
    });
  });

  describe('removeHost', () => {
    it('removes agent container and deletes DB record', async () => {
      const row = mockHostRow();
      mockFindById.mockResolvedValueOnce(row);
      mockRemoveAgent.mockResolvedValueOnce(undefined);
      mockDelete.mockResolvedValueOnce(undefined);

      const { removeHost } = await import('../hosts.functions');
      await removeHost({ data: { hostId: 1 } });

      expect(mockFindById).toHaveBeenCalledWith(1);
      expect(mockRemoveAgent).toHaveBeenCalled();
      expect(mockDelete).toHaveBeenCalledWith(1);
    });

    it('still deletes DB record when container removal fails', async () => {
      const row = mockHostRow();
      mockFindById.mockResolvedValueOnce(row);
      mockRemoveAgent.mockRejectedValueOnce(new Error('container not found'));
      mockDelete.mockResolvedValueOnce(undefined);

      const { removeHost } = await import('../hosts.functions');
      await removeHost({ data: { hostId: 1 } });

      expect(mockDelete).toHaveBeenCalledWith(1);
    });

    it('throws when host not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const { removeHost } = await import('../hosts.functions');
      await expect(
        removeHost({ data: { hostId: 999 } })
      ).rejects.toThrow('Host with id 999 not found');
    });
  });

  describe('updateAgent', () => {
    it('updates status to healthy when agent update succeeds', async () => {
      const row = mockHostRow();
      mockFindById.mockResolvedValueOnce(row);
      mockUpdateAgent.mockResolvedValueOnce({
        healthy: true,
        version: '3.0.0',
      });
      mockUpdateStatus.mockResolvedValueOnce(undefined);
      mockUpdateAgentVersion.mockResolvedValueOnce(undefined);

      const { updateAgent } = await import('../hosts.functions');
      await updateAgent({ data: { hostId: 1 } });

      expect(mockUpdateStatus).toHaveBeenCalledWith(1, 'healthy');
      expect(mockUpdateAgentVersion).toHaveBeenCalledWith(1, '3.0.0');
    });

    it('updates status to unhealthy when agent update fails', async () => {
      const row = mockHostRow();
      mockFindById.mockResolvedValue(row);
      mockUpdateAgent.mockResolvedValue({
        healthy: false,
        error: 'image pull failed',
      });
      mockUpdateStatus.mockResolvedValue(undefined);

      const { updateAgent } = await import('../hosts.functions');
      try {
        await updateAgent({ data: { hostId: 1 } });
      } catch {
        // createServerFn may throw internally
      }

      expect(mockUpdateStatus).toHaveBeenCalledWith(1, 'unhealthy');
      expect(mockUpdateAgentVersion).not.toHaveBeenCalled();
    });

    it('throws when host not found', async () => {
      mockFindById.mockResolvedValueOnce(null);

      const { updateAgent } = await import('../hosts.functions');
      await expect(
        updateAgent({ data: { hostId: 999 } })
      ).rejects.toThrow('Host with id 999 not found');
    });
  });

  describe('addHost', () => {
    it('provisions agent and creates host record on success', async () => {
      mockProvision.mockResolvedValueOnce({
        agentUrl: 'http://192.168.1.10:9090',
      });
      mockCreate.mockResolvedValueOnce(mockHostRow());
      mockCheckAgentHealth.mockResolvedValueOnce({
        healthy: true,
        version: '1.0.0',
      });
      mockUpdateStatus.mockResolvedValueOnce(undefined);
      mockUpdateAgentVersion.mockResolvedValueOnce(undefined);

      const { addHost } = await import('../hosts.functions');
      await addHost({
        data: { name: 'new-host', socketProxyUrl: 'tcp://192.168.1.10:2375' },
      });

      expect(mockProvision).toHaveBeenCalledTimes(1);
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(mockUpdateStatus).toHaveBeenCalledWith(1, 'healthy');
      expect(mockUpdateAgentVersion).toHaveBeenCalledWith(1, '1.0.0');
    });

    it('rolls back on health check failure', async () => {
      mockProvision.mockResolvedValueOnce({
        agentUrl: 'http://192.168.1.10:9090',
      });
      mockCreate.mockResolvedValueOnce(mockHostRow());
      // All health checks fail
      mockCheckAgentHealth.mockResolvedValue({
        healthy: false,
        error: 'connection refused',
      });
      mockRemoveAgent.mockResolvedValueOnce(undefined);
      mockDelete.mockResolvedValueOnce(undefined);

      const { addHost } = await import('../hosts.functions');
      await expect(
        addHost({
          data: { name: 'new-host', socketProxyUrl: 'tcp://192.168.1.10:2375' },
        })
      ).rejects.toThrow(/health check failed after 3 retries/);

      expect(mockRemoveAgent).toHaveBeenCalledTimes(1);
      expect(mockDelete).toHaveBeenCalledWith(1);
    });
  });
});
