import { describe, it, expect, mock } from 'bun:test';
import type { HostHandlerDeps, HostRepo } from '../handlers';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';
import {
  handleListHosts,
  handleCheckHostHealth,
  handleRemoveHost,
  handleUpdateAgent,
  handleAddHost,
} from '../handlers';

const NOW = new Date('2026-03-01T00:00:00Z');

function mockRow(overrides?: Record<string, unknown>) {
  return {
    id: 1, name: 'test-host',
    agent_url: 'http://192.168.1.10:9090',
    socket_proxy_url: 'tcp://192.168.1.10:2375',
    agent_version: null,
    status: 'pending' as const,
    created_at: NOW, updated_at: NOW,
    ...overrides,
  };
}

function mockRepo(overrides?: Partial<HostRepo>): HostRepo {
  return {
    findById: mock(() => Promise.resolve(mockRow())),
    findAll: mock(() => Promise.resolve([mockRow()])),
    create: mock(() => Promise.resolve(mockRow())),
    delete: mock(() => Promise.resolve()),
    updateStatus: mock(() => Promise.resolve()),
    updateAgentVersion: mock(() => Promise.resolve()),
    updateAgentUrl: mock(() => Promise.resolve()),
    ...overrides,
  };
}

function baseDeps(repo?: Partial<HostRepo>): HostHandlerDeps {
  return { repo: mockRepo(repo), isEnabled: () => true };
}

describe('handleListHosts', () => {
  it('returns mapped host list', async () => {
    const deps = baseDeps({ findAll: mock(() => Promise.resolve([mockRow({ status: 'healthy' })])) });
    const result = await handleListHosts(deps);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('test-host');
    expect(result[0].status).toBe('healthy');
  });

  it('returns empty when no hosts', async () => {
    const deps = baseDeps({ findAll: mock(() => Promise.resolve([])) });
    expect(await handleListHosts(deps)).toEqual([]);
  });

  it('throws when feature flag is off', async () => {
    const deps = { ...baseDeps(), isEnabled: () => false };
    await expect(handleListHosts(deps)).rejects.toThrow('not enabled');
  });
});

describe('handleCheckHostHealth', () => {
  it('updates status to healthy on success', async () => {
    const repo = mockRepo();
    const deps = { ...baseDeps(), repo, checkHealth: mock(() => Promise.resolve({ healthy: true as const, version: '2.0.0', dockerVersion: '24.0' })) };
    const result = await handleCheckHostHealth(deps, { hostId: 1 });
    expect(result.healthy).toBe(true);
    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
    expect(repo.updateAgentVersion).toHaveBeenCalledWith(1, '2.0.0');
  });

  it('updates status to unhealthy on failure', async () => {
    const repo = mockRepo();
    const deps = { ...baseDeps(), repo, checkHealth: mock(() => Promise.resolve({ healthy: false as const, error: 'refused' })) };
    const result = await handleCheckHostHealth(deps, { hostId: 1 });
    expect(result.healthy).toBe(false);
    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'unhealthy');
    expect(repo.updateAgentVersion).not.toHaveBeenCalled();
  });

  it('throws when host not found', async () => {
    const deps = { ...baseDeps({ findById: mock(() => Promise.resolve(null)) }), checkHealth: mock() };
    await expect(handleCheckHostHealth(deps, { hostId: 999 })).rejects.toThrow('Host with id 999 not found');
  });
});

describe('handleRemoveHost', () => {
  function removeDeps(repo?: Partial<HostRepo>) {
    return {
      ...baseDeps(repo),
      removeAgent: mock(() => Promise.resolve()),
      deleteToken: mock(() => Promise.resolve()),
    };
  }

  it('removes container and deletes record', async () => {
    const deps = removeDeps();
    const result = await handleRemoveHost(deps, { hostId: 1 });
    expect(result.success).toBe(true);
    expect(result.containerRemoved).toBe(true);
    expect(deps.removeAgent).toHaveBeenCalled();
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('still deletes record when container removal fails', async () => {
    const deps = removeDeps();
    deps.removeAgent = mock(() => Promise.reject(new Error('not found')));
    const result = await handleRemoveHost(deps, { hostId: 1 });
    expect(result.success).toBe(true);
    expect(result.containerRemoved).toBe(false);
    expect(result.warning).toContain('manual cleanup');
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('throws when host not found', async () => {
    const deps = removeDeps({ findById: mock(() => Promise.resolve(null)) });
    await expect(handleRemoveHost(deps, { hostId: 999 })).rejects.toThrow('not found');
  });

  it('deletes token from OpenBao', async () => {
    const deps = removeDeps();
    await handleRemoveHost(deps, { hostId: 1 });
    expect(deps.deleteToken).toHaveBeenCalledWith('test-host');
  });

  it('still deletes record when OpenBao token deletion fails', async () => {
    const deps = removeDeps();
    deps.deleteToken = mock(() => Promise.reject(new Error('bao unreachable')));
    const result = await handleRemoveHost(deps, { hostId: 1 });
    expect(result.success).toBe(true);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });
});

describe('handleUpdateAgent', () => {
  it('updates status to healthy on success', async () => {
    const repo = mockRepo();
    const updateAgentFn = mock(() => Promise.resolve({ healthy: true, version: '3.0.0' }));
    const result = await handleUpdateAgent({ ...baseDeps(), repo, updateAgent: updateAgentFn }, { hostId: 1 });
    expect(result.healthy).toBe(true);
    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
    expect(repo.updateAgentVersion).toHaveBeenCalledWith(1, '3.0.0');
  });

  it('updates status to unhealthy on failure', async () => {
    const repo = mockRepo();
    const updateAgentFn = mock(() => Promise.resolve({ healthy: false, error: 'pull failed' }));
    const result = await handleUpdateAgent({ ...baseDeps(), repo, updateAgent: updateAgentFn }, { hostId: 1 });
    expect(result.healthy).toBe(false);
    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'unhealthy');
  });
});

describe('handleAddHost', () => {
  function addDeps(repo?: Partial<HostRepo>) {
    return {
      ...baseDeps(repo),
      provision: mock(() => Promise.resolve({ agentUrl: 'http://192.168.1.10:9090' })),
      generateToken: () => 'mock-token',
      storeToken: mock(() => Promise.resolve()),
      deleteToken: mock(() => Promise.resolve()),
      checkHealth: mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: true, version: '1.0.0' })),
      removeAgent: mock(() => Promise.resolve()),
    };
  }

  it('provisions and creates host on success', async () => {
    const deps = addDeps();
    const result = await handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 });
    expect(result.host.name).toBe('test-host');
    expect(deps.provision).toHaveBeenCalled();
    expect(deps.repo.create).toHaveBeenCalled();
    expect(deps.storeToken).toHaveBeenCalledWith('new', 'mock-token');
    expect(deps.repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
  });

  it('persists the resolved agent URL after provisioning', async () => {
    const deps = addDeps();
    await handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 });
    expect(deps.repo.updateAgentUrl).toHaveBeenCalledWith(1, 'http://192.168.1.10:9090');
  });

  it('rolls back on health check failure', async () => {
    const deps = addDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: false, error: 'refused' }));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/health check failed/);
    expect(deps.removeAgent).toHaveBeenCalled();
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('deletes token from OpenBao on health check failure rollback', async () => {
    const deps = addDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: false, error: 'refused' }));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/health check failed/);
    expect(deps.deleteToken).toHaveBeenCalledWith('new');
  });

  it('reports cleanup failure in error message', async () => {
    const deps = addDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: false, error: 'refused' }));
    deps.removeAgent = mock(() => Promise.reject(new Error('cleanup failed')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/manual removal/);
  });

  it('rolls back on OpenBao write failure', async () => {
    const deps = addDeps();
    deps.storeToken = mock(() => Promise.reject(new Error('bao unreachable')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/Failed to store agent token in OpenBao/);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
    expect(deps.removeAgent).toHaveBeenCalled();
  });

  it('reports container cleanup failure in OpenBao write rollback', async () => {
    const deps = addDeps();
    deps.storeToken = mock(() => Promise.reject(new Error('bao unreachable')));
    deps.removeAgent = mock(() => Promise.reject(new Error('docker down')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/manual removal/);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });
});
