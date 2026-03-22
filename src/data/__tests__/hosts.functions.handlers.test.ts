import { describe, it, expect, mock } from 'bun:test';
import type { HostHandlerDeps, HostRepo } from '../hosts.functions';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';
import {
  handleListHosts,
  handleCheckHostHealth,
  handleRemoveHost,
  handleUpdateAgent,
  handleAddHost,
} from '../hosts.functions';

const NOW = new Date('2026-03-01T00:00:00Z');

function mockRow(overrides?: Record<string, unknown>) {
  return {
    id: 1, name: 'test-host',
    agent_url: 'http://192.168.1.10:9090',
    socket_proxy_url: 'tcp://192.168.1.10:2375',
    agent_version: null, agent_token_hash: 'hash', agent_token: 'token',
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
  it('removes container and deletes record', async () => {
    const repo = mockRepo();
    const removeAgent = mock(() => Promise.resolve());
    const result = await handleRemoveHost({ ...baseDeps(), repo, removeAgent }, { hostId: 1 });
    expect(result.success).toBe(true);
    expect(result.containerRemoved).toBe(true);
    expect(removeAgent).toHaveBeenCalled();
    expect(repo.delete).toHaveBeenCalledWith(1);
  });

  it('still deletes record when container removal fails', async () => {
    const repo = mockRepo();
    const removeAgent = mock(() => Promise.reject(new Error('not found')));
    const result = await handleRemoveHost({ ...baseDeps(), repo, removeAgent }, { hostId: 1 });
    expect(result.success).toBe(true);
    expect(result.containerRemoved).toBe(false);
    expect(result.warning).toContain('manual cleanup');
    expect(repo.delete).toHaveBeenCalledWith(1);
  });

  it('throws when host not found', async () => {
    const deps = { ...baseDeps({ findById: mock(() => Promise.resolve(null)) }), removeAgent: mock() };
    await expect(handleRemoveHost(deps, { hostId: 999 })).rejects.toThrow('not found');
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

  it('throws when host not found', async () => {
    const updateAgentFn = mock(() => Promise.resolve({ healthy: true }));
    const deps = { ...baseDeps({ findById: mock(() => Promise.resolve(null)) }), updateAgent: updateAgentFn };
    await expect(handleUpdateAgent(deps, { hostId: 999 })).rejects.toThrow('not found');
  });

  it('throws when feature flag is off', async () => {
    const updateAgentFn = mock(() => Promise.resolve({ healthy: true }));
    const deps = { ...baseDeps(), isEnabled: () => false, updateAgent: updateAgentFn };
    await expect(handleUpdateAgent(deps, { hostId: 1 })).rejects.toThrow('not enabled');
  });

  it('returns error result when updateAgent throws', async () => {
    const repo = mockRepo();
    const updateAgentFn = mock(() => Promise.reject(new Error('container crashed')));
    const result = await handleUpdateAgent({ ...baseDeps(), repo, updateAgent: updateAgentFn }, { hostId: 1 });
    expect(result.healthy).toBe(false);
    expect(result.error).toBe('container crashed');
  });

  it('still returns error when updateStatus fails after updateAgent throws', async () => {
    const repo = mockRepo({ updateStatus: mock(() => Promise.reject(new Error('db down'))) });
    const updateAgentFn = mock(() => Promise.reject(new Error('container crashed')));
    const result = await handleUpdateAgent({ ...baseDeps(), repo, updateAgent: updateAgentFn }, { hostId: 1 });
    expect(result.healthy).toBe(false);
    expect(result.error).toBe('container crashed');
  });
});

describe('handleAddHost', () => {
  function addDeps(repo?: Partial<HostRepo>) {
    return {
      ...baseDeps(repo),
      provision: mock(() => Promise.resolve({ agentUrl: 'http://192.168.1.10:9090' })),
      generateToken: () => 'mock-token',
      hashToken: mock(() => Promise.resolve('hashed')),
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
    expect(deps.repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
  });

  it('returns the provisioned agentUrl, not the empty placeholder', async () => {
    const deps = addDeps({ create: mock(() => Promise.resolve(mockRow({ agent_url: '' }))) });
    deps.provision = mock(() => Promise.resolve({ agentUrl: 'http://192.168.1.10:9090' }));
    const result = await handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 });
    expect(result.host.agentUrl).toBe('http://192.168.1.10:9090');
  });

  it('rolls back on provision failure', async () => {
    const deps = addDeps();
    deps.provision = mock(() => Promise.reject(new Error('docker unreachable')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/Failed to provision/);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
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

  it('reports cleanup failure in error message', async () => {
    const deps = addDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: false, error: 'refused' }));
    deps.removeAgent = mock(() => Promise.reject(new Error('cleanup failed')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/manual removal/);
  });

  it('cleans up when retryHealthCheck throws', async () => {
    const deps = addDeps();
    deps.checkHealth = mock(() => Promise.reject(new Error('unexpected error')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow('unexpected error');
    expect(deps.removeAgent).toHaveBeenCalled();
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('cleans up when updateAgentUrl fails after healthy check', async () => {
    const repo = mockRepo({ updateAgentUrl: mock(() => Promise.reject(new Error('db connection lost'))) });
    const deps = addDeps();
    deps.repo = repo;
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/failed to finalize/i);
    expect(deps.removeAgent).toHaveBeenCalled();
    expect(repo.delete).toHaveBeenCalledWith(1);
  });

  it('cleans up when updateStatus fails after healthy check', async () => {
    const repo = mockRepo({ updateStatus: mock(() => Promise.reject(new Error('db timeout'))) });
    const deps = addDeps();
    deps.repo = repo;
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/failed to finalize/i);
    expect(deps.removeAgent).toHaveBeenCalled();
    expect(repo.delete).toHaveBeenCalledWith(1);
  });

  it('still throws original error when bestEffortCleanup also fails', async () => {
    const repo = mockRepo({
      updateAgentUrl: mock(() => Promise.reject(new Error('db connection lost'))),
      delete: mock(() => Promise.reject(new Error('delete also failed'))),
    });
    const deps = addDeps();
    deps.repo = repo;
    deps.removeAgent = mock(() => Promise.reject(new Error('container removal failed')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/failed to finalize/i);
  });

  it('succeeds even when updateAgentVersion fails (metadata-only)', async () => {
    const repo = mockRepo({ updateAgentVersion: mock(() => Promise.reject(new Error('db error'))) });
    const deps = addDeps();
    deps.repo = repo;
    const result = await handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 });
    expect(result.host.status).toBe('healthy');
    expect(deps.removeAgent).not.toHaveBeenCalled();
  });
});
