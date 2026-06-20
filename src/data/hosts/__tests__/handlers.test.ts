import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import type { HostHandlerDeps, HostRepo, KeypairsDep } from '../handlers';
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

function makeKeypairsMock(): KeypairsDep {
  return {
    createForHost: mock(async (_name: string) => ({
      publicJwk: { kty: 'OKP', crv: 'Ed25519', x: 'mock-x' } as import('jose').JWK,
    })),
    deleteForHost: mock(async () => undefined),
  };
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
      keypairs: makeKeypairsMock(),
    };
  }

  it('deletes keypair and record', async () => {
    const deps = removeDeps();
    const result = await handleRemoveHost(deps, { hostId: 1 });
    expect(result.success).toBe(true);
    expect(deps.keypairs.deleteForHost).toHaveBeenCalledWith('test-host');
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('still deletes record when keypair deletion fails', async () => {
    const deps = removeDeps();
    deps.keypairs.deleteForHost = mock(() => Promise.reject(new Error('keypair store unreachable')));
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

  it('passes the host name to checkHealth', async () => {
    let capturedHostName = '';
    const checkHealth = mock((_url: string, hostName: string): Promise<HealthCheckOutcome> => {
      capturedHostName = hostName;
      return Promise.resolve({ healthy: true as const });
    });
    const repo = mockRepo({
      findById: mock(() => Promise.resolve(mockRow({ name: 'my-host', agentUrl: 'http://x:9090' }))),
    });
    await handleRefreshHostStatus({ ...baseDeps(), repo, checkHealth }, { hostId: 1 });
    expect(capturedHostName).toBe('my-host');
  });

});

describe('handleVerifyHost', () => {
  function verifyDeps(repo?: Partial<HostRepo>) {
    return {
      ...baseDeps(repo),
      keypairs: makeKeypairsMock(),
    };
  }

  it('generates keypair and returns public JWK', async () => {
    const deps = verifyDeps();
    const result = await handleVerifyHost(deps, { name: 'newhost', agentUrl: 'http://x:9090' });
    expect(deps.keypairs.createForHost).toHaveBeenCalledWith('newhost');
    expect(result.publicJwk).toBeDefined();
    expect(result.publicJwk?.kty).toBe('OKP');
  });

  it('creates host record with name, url, and capabilities', async () => {
    const deps = verifyDeps();
    await handleVerifyHost(deps, {
      name: 'new-host',
      agentUrl: 'http://192.168.1.10:9090',
      capabilities: { docker: true },
    });
    expect(deps.repo.create).toHaveBeenCalledWith({
      name: 'new-host',
      agentUrl: 'http://192.168.1.10:9090',
      capabilities: { docker: true },
    });
  });

  it('returns pending status', async () => {
    const deps = verifyDeps();
    const result = await handleVerifyHost(deps, { name: 'new-host', agentUrl: 'http://x:9090' });
    expect(result.host.status).toBe('pending');
    expect(deps.repo.updateStatus).not.toHaveBeenCalled();
    expect(deps.repo.updateAgentVersion).not.toHaveBeenCalled();
  });

  it('rolls back DB record on keypair generation failure', async () => {
    const deps = verifyDeps();
    deps.keypairs.createForHost = mock(() => Promise.reject(new Error('keygen failed')));
    await expect(
      handleVerifyHost(deps, { name: 'new', agentUrl: 'http://x:9090' })
    ).rejects.toThrow(/Failed to generate agent keypair/);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('passes capabilities to repo.create', async () => {
    const deps = verifyDeps();
    await handleVerifyHost(deps, {
      name: 'zfs-host',
      agentUrl: 'http://x:9090',
      capabilities: { docker: true, zfs: true },
    });
    expect(deps.repo.create).toHaveBeenCalledWith({
      name: 'zfs-host',
      agentUrl: 'http://x:9090',
      capabilities: { docker: true, zfs: true },
    });
  });

  it('trims the host name before create and keypair generation', async () => {
    const deps = verifyDeps();
    await handleVerifyHost(deps, { name: '  padded-host  ', agentUrl: 'http://x:9090' });
    expect(deps.repo.create).toHaveBeenCalledWith({
      name: 'padded-host',
      agentUrl: 'http://x:9090',
      capabilities: undefined,
    });
    expect(deps.keypairs.createForHost).toHaveBeenCalledWith('padded-host');
  });
});

describe('handleRegisterExistingHost', () => {
  function registerDeps(repo?: Partial<HostRepo>) {
    return {
      ...baseDeps(repo),
      keypairs: makeKeypairsMock(),
    };
  }

  it('creates host, generates keypair, and returns pending host with public JWK', async () => {
    const deps = registerDeps();
    const result = await handleRegisterExistingHost(deps, {
      name: 'existing-host',
      agentUrl: 'http://192.168.1.20:9090',
    });

    expect(result.host.name).toBe('test-host'); // from mockRow
    expect(result.host.status).toBe('pending');
    expect(result.publicJwk).toBeDefined();
    expect(result.publicJwk?.kty).toBe('OKP');
    expect(deps.repo.create).toHaveBeenCalledWith({
      name: 'existing-host',
      agentUrl: 'http://192.168.1.20:9090',
    });
    expect(deps.keypairs.createForHost).toHaveBeenCalledWith('existing-host');
    expect(deps.repo.updateStatus).not.toHaveBeenCalled();
  });

  it('rolls back DB record and throws when keypair generation fails', async () => {
    const deps = registerDeps();
    deps.keypairs.createForHost = mock(() => Promise.reject(new Error('keygen failed')));

    await expect(
      handleRegisterExistingHost(deps, {
        name: 'existing-host',
        agentUrl: 'http://192.168.1.20:9090',
      })
    ).rejects.toThrow(/Failed to generate agent keypair/);

    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('trims the host name before create and keypair generation', async () => {
    const deps = registerDeps();
    await handleRegisterExistingHost(deps, { name: '  padded-host  ', agentUrl: 'http://x:9090' });
    expect(deps.repo.create).toHaveBeenCalledWith({
      name: 'padded-host',
      agentUrl: 'http://x:9090',
    });
    expect(deps.keypairs.createForHost).toHaveBeenCalledWith('padded-host');
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
      keypairs: makeKeypairsMock(),
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
    expect(deps.keypairs.createForHost).toHaveBeenCalledWith('new');
    expect(deps.repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
  });

  it('returns public JWK on success', async () => {
    const deps = addDeps();
    const result = await handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 });
    expect(result.publicJwk).toBeDefined();
    expect(result.publicJwk?.kty).toBe('OKP');
  });

  it('provisions with publicJwkJson instead of agentToken', async () => {
    const deps = addDeps();
    await handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 });
    const provisionCall = (deps.provision as ReturnType<typeof mock>).mock.calls[0];
    expect(provisionCall[1]).toHaveProperty('publicJwkJson');
    expect(provisionCall[1]).toHaveProperty('hostName', 'new');
    expect(provisionCall[1]).not.toHaveProperty('agentToken');
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

  it('deletes keypair on health check failure rollback', async () => {
    const deps = addDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: false, error: 'refused' }));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/health check failed/);
    expect(deps.keypairs.deleteForHost).toHaveBeenCalledWith('new');
  });

  it('reports cleanup failure in error message', async () => {
    const deps = addDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: false, error: 'refused' }));
    deps.removeAgent = mock(() => Promise.reject(new Error('cleanup failed')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/manual removal/);
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
    expect(deps.keypairs.deleteForHost).toHaveBeenCalledWith('new');
    expect(deps.removeAgent).toHaveBeenCalled();
  });

  it('reports container cleanup failure in rollback error message', async () => {
    const deps = addDeps({
      updateAgentUrl: mock(() => Promise.reject(new Error('DB write failed'))),
    });
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
    // keypair was created before provision, so it should be deleted on provision failure
    expect(deps.keypairs.deleteForHost).toHaveBeenCalledWith('new');
  });

  it('deletes host record and re-throws when keypair generation fails before provision', async () => {
    const deps = addDeps();
    deps.keypairs.createForHost = mock(() => Promise.reject(new Error('keygen failed')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow('keygen failed');
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
    // provision should not have been called since keypair generation failed
    expect(deps.provision).not.toHaveBeenCalled();
  });

  it('swallows deleteForHost error during health check failure rollback', async () => {
    const deps = addDeps();
    deps.checkHealth = mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: false, error: 'refused' }));
    deps.keypairs.deleteForHost = mock(() => Promise.reject(new Error('keypair store down')));
    await expect(
      handleAddHost(deps, { name: 'new', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 })
    ).rejects.toThrow(/health check failed/);
    // deleteForHost threw but error was swallowed; rollback error is the one that propagates
    expect(deps.keypairs.deleteForHost).toHaveBeenCalledWith('new');
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('trims the host name before create, keypair, and provision', async () => {
    const deps = addDeps();
    await handleAddHost(deps, { name: '  padded-host  ', socketProxyUrl: 'tcp://x:2375', agentPort: 9090 });
    expect(deps.repo.create).toHaveBeenCalledWith({ name: 'padded-host', agentUrl: '' });
    expect(deps.keypairs.createForHost).toHaveBeenCalledWith('padded-host');
    const provisionCall = (deps.provision as ReturnType<typeof mock>).mock.calls[0];
    expect(provisionCall[1]).toHaveProperty('hostName', 'padded-host');
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
    getSigner?: ReturnType<typeof mock>;
    checkHealth?: ReturnType<typeof mock>;
  }) {
    return {
      ...baseDeps(repo),
      getSigner: overrides?.getSigner ?? mock(async () => async () => 'mock-jwt'),
      checkHealth: overrides?.checkHealth ?? mock((): Promise<HealthCheckOutcome> => Promise.resolve({ healthy: true, version: '1.0.0' })),
    };
  }

  it('records current version, mints JWT, triggers update, polls for version change', async () => {
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

  it('returns unhealthy with keypair suggestions when getSigner throws', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const deps = updateDeps(undefined, {
      getSigner: mock(() => Promise.reject(new Error('master key missing'))),
    });

    const result = await handleUpdateAgent(deps, { hostId: 1 });

    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.error).toContain('keypair');
      expect(result.suggestions).toBeDefined();
      expect(result.suggestions!.some(s => s.toLowerCase().includes('master key'))).toBe(true);
    }
    fetchSpy.mockRestore();
  });

  it('uses Bearer JWT when triggering agent update', async () => {
    let callCount = 0;
    const checkHealth = mock((): Promise<HealthCheckOutcome> => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ healthy: true, version: '1.0.0' });
      return Promise.resolve({ healthy: true, version: '2.0.0' });
    });
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const deps = updateDeps(undefined, { checkHealth });

    await handleUpdateAgent(deps, { hostId: 1 });

    const fetchCall = fetchSpy.mock.calls[0];
    expect(fetchCall[1]?.headers).toMatchObject({ Authorization: 'Bearer mock-jwt' });
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

  it('returns unhealthy with "latest version" message when version never changes but agent stays healthy', async () => {
    const checkHealth = mock((): Promise<HealthCheckOutcome> =>
      Promise.resolve({ healthy: true, version: '1.0.0' }),
    );
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const deps = updateDeps(undefined, { checkHealth });

    const result = await handleUpdateAgent(deps, { hostId: 1 });

    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.error).toContain('latest version already');
    }
    fetchSpy.mockRestore();
  });

  it('returns unhealthy with suggestions when POST to agent update endpoint throws', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    const deps = updateDeps();

    const result = await handleUpdateAgent(deps, { hostId: 1 });

    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.error).toContain('ECONNREFUSED');
      expect(result.suggestions).toBeDefined();
    }
    fetchSpy.mockRestore();
  });

  it('does not treat undefined version as a version change during polling', async () => {
    let callCount = 0;
    const checkHealth = mock((): Promise<HealthCheckOutcome> => {
      callCount++;
      if (callCount === 1) return Promise.resolve({ healthy: true, version: '1.0.0' });
      // /info fails transiently on first poll; should not exit the loop
      if (callCount === 2) return Promise.resolve({ healthy: true, version: undefined });
      return Promise.resolve({ healthy: true, version: '2.0.0' });
    });
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 202 }));
    const deps = updateDeps(undefined, { checkHealth });

    const result = await handleUpdateAgent(deps, { hostId: 1 });

    expect(result.healthy).toBe(true);
    if (result.healthy) expect(result.version).toBe('2.0.0');
    fetchSpy.mockRestore();
  });

  it('returns unhealthy when agent update endpoint returns a redirect (3xx)', async () => {
    const fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(null, { status: 301, headers: { Location: 'http://169.254.169.254/metadata' } })
    );
    const deps = updateDeps();

    const result = await handleUpdateAgent(deps, { hostId: 1 });

    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.error).toContain('redirect');
      expect(result.suggestions).toBeDefined();
    }
    expect(fetchSpy.mock.calls[0][1]?.redirect).toBe('manual');
    fetchSpy.mockRestore();
  });
});

describe('handleUpdateHost', () => {
  it('updates agentUrl and returns mapped HostListItem when name is unchanged', async () => {
    const updatedRow = mockRow({ name: 'test-host', agentUrl: 'http://new-url:9090' });
    const repo = mockRepo({ update: mock(() => Promise.resolve(updatedRow)) });
    const deps = baseDeps();
    deps.repo = repo;

    const result = await handleUpdateHost(deps, { hostId: 1, name: 'test-host', agentUrl: 'http://new-url:9090' });

    expect(result.name).toBe('test-host');
    expect(result.agentUrl).toBe('http://new-url:9090');
    expect(repo.update).toHaveBeenCalledWith(1, { agentUrl: 'http://new-url:9090' });
  });

  it('throws when host not found', async () => {
    const deps = baseDeps({ findById: mock(() => Promise.resolve(null)) });
    await expect(handleUpdateHost(deps, { hostId: 999 })).rejects.toThrow('not found');
  });

  it('rejects a changed name and does not write', async () => {
    const repo = mockRepo();
    const deps = baseDeps();
    deps.repo = repo;

    await expect(
      handleUpdateHost(deps, { hostId: 1, name: 'renamed', agentUrl: 'http://new-url:9090' }),
    ).rejects.toThrow(/cannot be changed after enrollment/);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('treats a whitespace-padded matching name as unchanged', async () => {
    const repo = mockRepo();
    const deps = baseDeps();
    deps.repo = repo;

    await handleUpdateHost(deps, { hostId: 1, name: '  test-host  ', agentUrl: 'http://x:9090' });

    expect(repo.update).toHaveBeenCalledWith(1, { agentUrl: 'http://x:9090' });
  });

  it('updates agentUrl when name is omitted', async () => {
    const repo = mockRepo();
    const deps = baseDeps();
    deps.repo = repo;

    await handleUpdateHost(deps, { hostId: 1, agentUrl: 'http://x:9090' });

    expect(repo.update).toHaveBeenCalledWith(1, { agentUrl: 'http://x:9090' });
  });
});
