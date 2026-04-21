import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import type { HostHandlerDeps, HostRepo } from '../handlers';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';
import {
  handleListHosts,
  handleCheckHostHealth,
  handleRemoveHost,
  handleRefreshHostStatus,
  handleVerifyHost,
  handleAddHost,
  handleUpdateHost,
  handleRegisterExistingHost,
  handleUpdateAgent,
} from '../handlers';

const NOW = new Date('2026-03-01T00:00:00Z');

function mockRow(overrides?: Record<string, unknown>) {
  return {
    id: 1, name: 'test-host',
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
    agentVersion: null,
    status: 'pending' as const,
    createdAt: NOW, updatedAt: NOW,
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
    updateAgentUrl: mock(() => Promise.resolve()),
    ...overrides,
  } as HostRepo;
}

function baseDeps(repo?: Partial<HostRepo>): HostHandlerDeps {
  return { repo: mockRepo(repo) };
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

});

describe('handleRefreshHostStatus', () => {
  it('updates status to healthy on success', async () => {
    const repo = mockRepo();
    const checkHealth = mock(() => Promise.resolve({ healthy: true as const, version: '3.0.0', dockerVersion: '24.0' }));
    const result = await handleRefreshHostStatus({ ...baseDeps(), repo, checkHealth }, { hostId: 1 });
    expect(result.healthy).toBe(true);
    expect(result.healthy && result.version).toBe('3.0.0');
    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
    expect(repo.updateAgentVersion).toHaveBeenCalledWith(1, '3.0.0');
  });

  it('updates status to unhealthy on failure', async () => {
    const repo = mockRepo();
    const checkHealth = mock(() => Promise.resolve({ healthy: false as const, error: 'timeout' }));
    const result = await handleRefreshHostStatus({ ...baseDeps(), repo, checkHealth }, { hostId: 1 });
    expect(result.healthy).toBe(false);
    expect(!result.healthy && result.error).toBe('timeout');
    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'unhealthy');
  });

  it('throws when host not found', async () => {
    const deps = { ...baseDeps({ findById: mock(() => Promise.resolve(null)) }), checkHealth: mock() };
    await expect(handleRefreshHostStatus(deps, { hostId: 999 })).rejects.toThrow('not found');
  });

});

describe('handleVerifyHost', () => {
  function verifyDeps(repo?: Partial<HostRepo>) {
    return {
      ...baseDeps(repo),
      storeToken: mock(() => Promise.resolve()),
      checkHealth: mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: true, version: '1.0.0' })),
      verifyToken: mock(() => Promise.resolve()),
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
      agentUrl: 'http://192.168.1.10:9090',
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

  it('throws on token verification failure without creating DB record', async () => {
    const deps = verifyDeps();
    deps.verifyToken = mock(() => Promise.reject(new Error('agent rejected authentication')));
    await expect(
      handleVerifyHost(deps, { name: 'new', agentUrl: 'http://x:9090', agentToken: 'wrong-token' })
    ).rejects.toThrow(/agent rejected authentication/);
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
      agentUrl: 'http://x:9090',
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

describe('handleRegisterExistingHost', () => {
  let setTimeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: TimerHandler) => {
        if (typeof fn === 'function') fn();
        return 0;
      }) as unknown as typeof setTimeout
    );
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  function registerDeps(repo?: Partial<HostRepo>) {
    return {
      ...baseDeps(repo),
      storeToken: mock(() => Promise.resolve()),
      checkHealth: mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: true, version: '1.0.0' })),
    };
  }

  it('creates host, stores token, health checks, and returns healthy host', async () => {
    const deps = registerDeps();
    const result = await handleRegisterExistingHost(deps, {
      name: 'existing-host',
      agentUrl: 'http://192.168.1.20:9090',
      agentToken: 'my-token',
    });

    expect(result.host.name).toBe('test-host'); // from mockRow
    expect(result.host.status).toBe('healthy');
    expect(deps.repo.create).toHaveBeenCalledWith({
      name: 'existing-host',
      agentUrl: 'http://192.168.1.20:9090',
    });
    expect(deps.storeToken).toHaveBeenCalledWith('existing-host', 'my-token');
    expect(deps.repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
    expect(deps.checkHealth).toHaveBeenCalled();
  });

  it('returns unhealthy host when health check fails', async () => {
    const deps = registerDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: false, error: 'refused' }));

    const result = await handleRegisterExistingHost(deps, {
      name: 'existing-host',
      agentUrl: 'http://192.168.1.20:9090',
      agentToken: 'my-token',
    });

    expect(result.host.status).toBe('unhealthy');
    expect(deps.repo.updateStatus).toHaveBeenCalledWith(1, 'unhealthy');
    expect(deps.repo.updateAgentVersion).not.toHaveBeenCalled();
  });

  it('rolls back DB record and throws when token storage fails', async () => {
    const deps = registerDeps();
    deps.storeToken = mock(() => Promise.reject(new Error('bao unreachable')));

    await expect(
      handleRegisterExistingHost(deps, {
        name: 'existing-host',
        agentUrl: 'http://192.168.1.20:9090',
        agentToken: 'my-token',
      })
    ).rejects.toThrow(/Failed to store agent token in OpenBao/);

    expect(deps.repo.delete).toHaveBeenCalledWith(1);
    expect(deps.checkHealth).not.toHaveBeenCalled();
  });

  it('updates agent version when health check returns one', async () => {
    const deps = registerDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: true, version: '2.5.0' }));

    const result = await handleRegisterExistingHost(deps, {
      name: 'existing-host',
      agentUrl: 'http://192.168.1.20:9090',
      agentToken: 'my-token',
    });

    expect(deps.repo.updateAgentVersion).toHaveBeenCalledWith(1, '2.5.0');
    expect(result.host.agentVersion).toBe('2.5.0');
  });
});

describe('handleAddHost', () => {
  let setTimeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: TimerHandler) => {
        if (typeof fn === 'function') fn();
        return 0;
      }) as unknown as typeof setTimeout
    );
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

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
    expect(deps.repo.create).toHaveBeenCalledWith({
      name: 'new',
      agentUrl: '',
    });
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
    ).rejects.toThrow(/Failed to finalize host after provisioning/);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
    expect(deps.removeAgent).toHaveBeenCalled();
  });

  it('rolls back on updateAgentUrl failure', async () => {
    const deps = addDeps({
      updateAgentUrl: mock(() => Promise.reject(new Error('DB write failed'))),
    });
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/Failed to finalize host after provisioning/);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
    expect(deps.removeAgent).toHaveBeenCalled();
  });

  it('rolls back when finalization DB updates fail after health check', async () => {
    const deps = addDeps({
      updateStatus: mock(() => Promise.reject(new Error('DB down'))),
    });
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/Agent is healthy but failed to finalize host record/);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
    expect(deps.deleteToken).toHaveBeenCalledWith('new');
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

  it('deletes host record and re-throws when provision throws', async () => {
    const deps = addDeps();
    const provisionError = new Error('provision failed');
    deps.provision = mock(() => Promise.reject(provisionError));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow('provision failed');
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('swallows deleteToken error during health check failure rollback', async () => {
    const deps = addDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: false, error: 'refused' }));
    deps.deleteToken = mock(() => Promise.reject(new Error('bao down')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/health check failed/);
    // deleteToken threw but the error was caught; the rollback error is the one that propagates
    expect(deps.deleteToken).toHaveBeenCalledWith('new');
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });
});

describe('handleUpdateAgent', () => {
  let setTimeoutSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      ((fn: TimerHandler) => {
        if (typeof fn === 'function') fn();
        return 0;
      }) as unknown as typeof setTimeout
    );
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  function updateDeps(repo?: Partial<HostRepo>, overrides?: {
    getToken?: ReturnType<typeof mock>;
    checkHealth?: ReturnType<typeof mock>;
  }) {
    return {
      ...baseDeps(repo),
      getToken: overrides?.getToken ?? mock(() => Promise.resolve('mock-token')),
      checkHealth: overrides?.checkHealth ?? mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: true, version: '1.0.0' })),
    };
  }

  it('records current version, fetches token, triggers update, polls for version change', async () => {
    let callCount = 0;
    const checkHealth = mock((): Promise<HealthCheckOutcome> => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ healthy: true, version: '1.0.0' });
      return Promise.resolve({ healthy: true, version: '2.0.0' });
    });
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const repo = mockRepo();
    const deps = updateDeps(undefined, { checkHealth });
    deps.repo = repo;

    const result = await handleUpdateAgent(deps, { hostId: 1 });

    expect(result.healthy).toBe(true);
    if (result.healthy) expect(result.version).toBe('2.0.0');
    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
    expect(repo.updateAgentVersion).toHaveBeenCalledWith(1, '2.0.0');
    fetchSpy.mockRestore();
  });

  it('returns unhealthy with OpenBao suggestions when getToken throws', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const deps = updateDeps(undefined, {
      getToken: mock(() => Promise.reject(new Error('bao unreachable'))),
    });

    const result = await handleUpdateAgent(deps, { hostId: 1 });

    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.error).toContain('token');
      expect(result.suggestions).toBeDefined();
      expect(result.suggestions!.some(s => s.toLowerCase().includes('openbao'))).toBe(true);
    }
    fetchSpy.mockRestore();
  });

  it('returns unhealthy with agent-unreachable suggestions when update POST returns non-202', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Docker not enabled', { status: 503 })
    );
    const deps = updateDeps();

    const result = await handleUpdateAgent(deps, { hostId: 1 });

    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.suggestions).toBeDefined();
    }
    fetchSpy.mockRestore();
  });

  it('returns unhealthy with container-restart suggestions when version never changes', async () => {
    let callCount = 0;
    const checkHealth = mock((): Promise<HealthCheckOutcome> => {
      callCount++;
      // Pre-check succeeds, but polling calls find agent is down (never restarted)
      if (callCount === 1) return Promise.resolve({ healthy: true, version: '1.0.0' });
      return Promise.resolve({ healthy: false, error: 'refused' });
    });
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const deps = updateDeps(undefined, { checkHealth });

    const result = await handleUpdateAgent(deps, { hostId: 1 });

    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.error).toContain('did not restart');
      expect(result.suggestions).toBeDefined();
    }
    fetchSpy.mockRestore();
  });

  it('returns unhealthy when pre-update health check fails', async () => {
    const checkHealth = mock((): Promise<HealthCheckOutcome> =>
      Promise.resolve({ healthy: false, error: 'refused' })
    );
    const deps = updateDeps(undefined, { checkHealth });

    const result = await handleUpdateAgent(deps, { hostId: 1 });

    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.error).toContain('unreachable before update');
    }
  });

  it('updates DB status and agent version on success', async () => {
    let callCount = 0;
    const checkHealth = mock((): Promise<HealthCheckOutcome> => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ healthy: true, version: '1.0.0' });
      return Promise.resolve({ healthy: true, version: '2.0.0' });
    });
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const repo = mockRepo();
    const deps = updateDeps(undefined, { checkHealth });
    deps.repo = repo;

    await handleUpdateAgent(deps, { hostId: 1 });

    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
    expect(repo.updateAgentVersion).toHaveBeenCalledWith(1, '2.0.0');
    fetchSpy.mockRestore();
  });
});

describe('handleUpdateHost', () => {
  it('updates the host and returns mapped HostListItem', async () => {
    const updatedRow = mockRow({ name: 'renamed', agentUrl: 'http://new-url:9090' });
    const repo = mockRepo({ update: mock(() => Promise.resolve(updatedRow)) });
    const deps = baseDeps();
    deps.repo = repo;

    const result = await handleUpdateHost(deps, { hostId: 1, name: 'renamed', agentUrl: 'http://new-url:9090' });

    expect(result.name).toBe('renamed');
    expect(result.agentUrl).toBe('http://new-url:9090');
    expect(repo.update).toHaveBeenCalledWith(1, { name: 'renamed', agentUrl: 'http://new-url:9090' });
  });

  it('throws when host not found', async () => {
    const deps = baseDeps({ findById: mock(() => Promise.resolve(null)) });
    await expect(handleUpdateHost(deps, { hostId: 999 })).rejects.toThrow('not found');
  });

  it('passes only provided fields to repo.update', async () => {
    const repo = mockRepo();
    const deps = baseDeps();
    deps.repo = repo;

    await handleUpdateHost(deps, { hostId: 1, name: 'only-name' });

    expect(repo.update).toHaveBeenCalledWith(1, { name: 'only-name' });
  });
});
