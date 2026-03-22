import { describe, it, expect, mock } from 'bun:test';
import type { HostHandlerDeps, HostRepo } from '../hosts.functions';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';
import {
  handleListHosts,
  handleCheckHostHealth,
  handleRemoveHost,
  handleUpdateAgent,
  handleVerifyHost,
  handleUpdateHost,
} from '../hosts.functions';

const NOW = new Date('2026-03-01T00:00:00Z');

function mockRow(overrides?: Record<string, unknown>) {
  return {
    id: 1, name: 'test-host',
    agent_url: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
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
    update: mock(() => Promise.resolve(mockRow())),
    delete: mock(() => Promise.resolve()),
    updateStatus: mock(() => Promise.resolve()),
    updateAgentVersion: mock(() => Promise.resolve()),
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
      deleteToken: mock(() => Promise.resolve()),
    };
  }

  it('deletes token and record', async () => {
    const deps = removeDeps();
    const result = await handleRemoveHost(deps, { hostId: 1 });
    expect(result.success).toBe(true);
    expect(deps.deleteToken).toHaveBeenCalledWith('test-host');
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('still deletes record when OpenBao token deletion fails', async () => {
    const deps = removeDeps();
    deps.deleteToken = mock(() => Promise.reject(new Error('bao unreachable')));
    const result = await handleRemoveHost(deps, { hostId: 1 });
    expect(result.success).toBe(true);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('throws when host not found', async () => {
    const deps = removeDeps({ findById: mock(() => Promise.resolve(null)) });
    await expect(handleRemoveHost(deps, { hostId: 999 })).rejects.toThrow('not found');
  });

  it('throws when feature flag is off', async () => {
    const deps = { ...removeDeps(), isEnabled: () => false };
    await expect(handleRemoveHost(deps, { hostId: 1 })).rejects.toThrow('not enabled');
  });
});

describe('handleUpdateAgent', () => {
  it('updates status to healthy on success', async () => {
    const repo = mockRepo();
    const checkHealth = mock(() => Promise.resolve({ healthy: true as const, version: '3.0.0', dockerVersion: '24.0' }));
    const result = await handleUpdateAgent({ ...baseDeps(), repo, checkHealth }, { hostId: 1 });
    expect(result.healthy).toBe(true);
    expect(result.version).toBe('3.0.0');
    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
    expect(repo.updateAgentVersion).toHaveBeenCalledWith(1, '3.0.0');
  });

  it('updates status to unhealthy on failure', async () => {
    const repo = mockRepo();
    const checkHealth = mock(() => Promise.resolve({ healthy: false as const, error: 'timeout' }));
    const result = await handleUpdateAgent({ ...baseDeps(), repo, checkHealth }, { hostId: 1 });
    expect(result.healthy).toBe(false);
    expect(result.error).toBe('timeout');
    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'unhealthy');
  });

  it('throws when host not found', async () => {
    const deps = { ...baseDeps({ findById: mock(() => Promise.resolve(null)) }), checkHealth: mock() };
    await expect(handleUpdateAgent(deps, { hostId: 999 })).rejects.toThrow('not found');
  });

  it('throws when feature flag is off', async () => {
    const deps = { ...baseDeps(), isEnabled: () => false, checkHealth: mock() };
    await expect(handleUpdateAgent(deps, { hostId: 1 })).rejects.toThrow('not enabled');
  });
});

describe('handleVerifyHost', () => {
  function verifyDeps(repo?: Partial<HostRepo>) {
    return {
      ...baseDeps(repo),
      storeToken: mock(() => Promise.resolve()),
      checkHealth: mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: true, version: '1.0.0' })),
    };
  }

  it('health checks, creates host, stores token, and returns result', async () => {
    const deps = verifyDeps();
    const result = await handleVerifyHost(deps, {
      name: 'new-host',
      agentUrl: 'http://192.168.1.10:9090',
      agentToken: 'test-token',
      capabilities: { docker: true },
    });
    expect(result.host.name).toBe('test-host'); // from mockRow
    expect(result.host.status).toBe('healthy');
    expect(deps.checkHealth).toHaveBeenCalled();
    expect(deps.repo.create).toHaveBeenCalledWith({
      name: 'new-host',
      agent_url: 'http://192.168.1.10:9090',
      capabilities: { docker: true },
    });
    expect(deps.storeToken).toHaveBeenCalledWith('new-host', 'test-token');
    expect(deps.repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
  });

  it('throws on health check failure without creating DB record', async () => {
    const deps = verifyDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: false, error: 'refused' }));
    await expect(
      handleVerifyHost(deps, { name: 'new', agentUrl: 'http://x:9090', agentToken: 'tok' })
    ).rejects.toThrow(/health check failed/);
    expect(deps.repo.create).not.toHaveBeenCalled();
    expect(deps.storeToken).not.toHaveBeenCalled();
  });

  it('rolls back DB record on OpenBao write failure', async () => {
    const deps = verifyDeps();
    deps.storeToken = mock(() => Promise.reject(new Error('bao unreachable')));
    await expect(
      handleVerifyHost(deps, { name: 'new', agentUrl: 'http://x:9090', agentToken: 'tok' })
    ).rejects.toThrow(/Failed to store agent token in OpenBao/);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('throws when feature flag is off', async () => {
    const deps = { ...verifyDeps(), isEnabled: () => false };
    await expect(
      handleVerifyHost(deps, { name: 'new', agentUrl: 'http://x:9090', agentToken: 'tok' })
    ).rejects.toThrow('not enabled');
  });

  it('passes capabilities to repo.create', async () => {
    const deps = verifyDeps();
    await handleVerifyHost(deps, {
      name: 'zfs-host',
      agentUrl: 'http://x:9090',
      agentToken: 'tok',
      capabilities: { docker: true, zfs: true },
    });
    expect(deps.repo.create).toHaveBeenCalledWith({
      name: 'zfs-host',
      agent_url: 'http://x:9090',
      capabilities: { docker: true, zfs: true },
    });
  });

  it('updates agent version when health check returns one', async () => {
    const deps = verifyDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: true, version: '2.0.0' }));
    await handleVerifyHost(deps, { name: 'new', agentUrl: 'http://x:9090', agentToken: 'tok' });
    expect(deps.repo.updateAgentVersion).toHaveBeenCalledWith(1, '2.0.0');
  });
});

describe('handleUpdateHost', () => {
  it('updates the host and returns mapped HostListItem', async () => {
    const updatedRow = mockRow({ name: 'renamed', agent_url: 'http://new-url:9090' });
    const repo = mockRepo({ update: mock(() => Promise.resolve(updatedRow)) });
    const deps = baseDeps();
    deps.repo = repo;

    const result = await handleUpdateHost(deps, { hostId: 1, name: 'renamed', agentUrl: 'http://new-url:9090' });

    expect(result.name).toBe('renamed');
    expect(result.agentUrl).toBe('http://new-url:9090');
    expect(repo.update).toHaveBeenCalledWith(1, { name: 'renamed', agent_url: 'http://new-url:9090' });
  });

  it('throws when host not found', async () => {
    const deps = baseDeps({ findById: mock(() => Promise.resolve(null)) });
    await expect(handleUpdateHost(deps, { hostId: 999 })).rejects.toThrow('not found');
  });

  it('throws when feature flag is off', async () => {
    const deps = { ...baseDeps(), isEnabled: () => false };
    await expect(handleUpdateHost(deps, { hostId: 1 })).rejects.toThrow('not enabled');
  });

  it('passes only provided fields to repo.update', async () => {
    const repo = mockRepo();
    const deps = baseDeps();
    deps.repo = repo;

    await handleUpdateHost(deps, { hostId: 1, name: 'only-name' });

    expect(repo.update).toHaveBeenCalledWith(1, { name: 'only-name' });
  });
});
