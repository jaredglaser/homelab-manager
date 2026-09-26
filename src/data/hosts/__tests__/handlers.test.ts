import { describe, it, expect, mock } from 'bun:test';
import type { HostHandlerDeps, HostRepo, KeypairsDep } from '../handlers';
import {
  handleListHosts,
  handleCheckHostHealth,
  handleRemoveHost,
  handleVerifyHost,
  handleUpdateHost,
  handleUpdateAgent,
  handleSetAgentAutoUpdate,
} from '../handlers';

const NOW = new Date('2026-03-01T00:00:00Z');

function mockRow(overrides?: Record<string, unknown>) {
  return {
    id: 1, name: 'test-host',
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
    agentVersion: null,
    agentImage: null,
    agentImageTag: null,
    autoUpdate: false,
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
    updateAgentInfo: mock(() => Promise.resolve()),
    updateAutoUpdate: mock(() => Promise.resolve()),
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
    expect(repo.updateAgentInfo).toHaveBeenCalledWith(1, { version: '2.0.0' });
  });

  it('records the reported agent image when the agent answers /info', async () => {
    const repo = mockRepo();
    const deps = {
      ...baseDeps(),
      repo,
      checkHealth: mock(() =>
        Promise.resolve({
          healthy: true as const,
          version: '2.0.0',
          infoSupported: true,
          agentImage: 'ghcr.io/jaredglaser/homelab-manager-agent:dev',
          agentImageTag: 'dev',
        }),
      ),
    };
    const result = await handleCheckHostHealth(deps, { hostId: 1 });
    expect(result).toMatchObject({ agentImageTag: 'dev' });
    expect(repo.updateAgentInfo).toHaveBeenCalledWith(1, {
      version: '2.0.0',
      image: 'ghcr.io/jaredglaser/homelab-manager-agent:dev',
      imageTag: 'dev',
    });
  });

  it('clears a stale image when a reporting agent can no longer determine one', async () => {
    const repo = mockRepo();
    const deps = {
      ...baseDeps(),
      repo,
      checkHealth: mock(() =>
        Promise.resolve({ healthy: true as const, version: '2.0.0', infoSupported: true }),
      ),
    };
    await handleCheckHostHealth(deps, { hostId: 1 });
    expect(repo.updateAgentInfo).toHaveBeenCalledWith(1, { version: '2.0.0', image: null, imageTag: null });
  });

  it('leaves the stored image alone for an agent with no /info endpoint', async () => {
    const repo = mockRepo();
    const deps = {
      ...baseDeps(),
      repo,
      checkHealth: mock(() =>
        Promise.resolve({ healthy: true as const, version: '2.0.0', infoSupported: false }),
      ),
    };
    await handleCheckHostHealth(deps, { hostId: 1 });
    expect(repo.updateAgentInfo).toHaveBeenCalledWith(1, { version: '2.0.0' });
  });

  it('updates status to unhealthy on failure', async () => {
    const repo = mockRepo();
    const deps = { ...baseDeps(), repo, checkHealth: mock(() => Promise.resolve({ healthy: false as const, error: 'refused' })) };
    const result = await handleCheckHostHealth(deps, { hostId: 1 });
    expect(result.healthy).toBe(false);
    expect(repo.updateStatus).toHaveBeenCalledWith(1, 'unhealthy');
    expect(repo.updateAgentInfo).not.toHaveBeenCalled();
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
    expect(deps.repo.updateAgentInfo).not.toHaveBeenCalled();
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

describe('handleUpdateAgent', () => {
  const getSigner = mock(async (_name: string) => mock(async () => 'jwt-token'));

  function updateDeps(repo?: Partial<HostRepo>, checkHealth?: (url: string, hostName: string) => Promise<import('@/lib/hosts/host-utils').HealthCheckOutcome>) {
    return {
      ...baseDeps(repo),
      getSigner,
      checkHealth: checkHealth ?? mock(() => Promise.resolve({ healthy: true as const, version: '1.0.0' })),
    };
  }

  function withFetch(impl: () => Promise<Response>): { restore: () => void; fetchMock: ReturnType<typeof mock> } {
    const fetchMock = mock(impl);
    const original = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return { restore: () => { globalThis.fetch = original; }, fetchMock };
  }

  it('throws when host not found', async () => {
    const deps = updateDeps({ findById: mock(() => Promise.resolve(null)) });
    await expect(handleUpdateAgent(deps, { hostId: 99 })).rejects.toThrow('not found');
  });

  it('fails before update when the agent is unreachable', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('{}', { status: 202 })));
    try {
      const deps = updateDeps(undefined, mock(() => Promise.resolve({ healthy: false as const, error: 'connection refused' })));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toContain('unreachable');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('reports success without polling when no update is available', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ updateAvailable: false }), { status: 200 })));
    try {
      const deps = updateDeps();
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith('http://192.168.1.10:9090/agent/update', expect.objectContaining({ method: 'POST' }));
    } finally {
      restore();
    }
  });

  it('polls until the version changes and records the new version', async () => {
    let polls = 0;
    const repo = mockRepo();
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      const deps = updateDeps(repo, mock(() => {
        polls++;
        return Promise.resolve({ healthy: true as const, version: polls === 1 ? '1.0.0' : '2.0.0' });
      }));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.version).toBe('2.0.0');
      expect(repo.updateStatus).toHaveBeenCalledWith(1, 'healthy');
      expect(repo.updateAgentInfo).toHaveBeenCalledWith(1, { version: '2.0.0' });
    } finally {
      restore();
    }
  });

  it('surfaces a non-202 trigger response as a failure', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ error: 'agent-updater sidecar is not reachable' }), { status: 503 })));
    try {
      const deps = updateDeps();
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toContain('agent-updater');
    } finally {
      restore();
    }
  });

  it('unwraps a JSON error body instead of rendering the raw JSON', async () => {
    const { restore } = withFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ error: 'An update is already in progress' }), { status: 409 }))
    );
    try {
      const deps = updateDeps();
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toBe('An update is already in progress');
    } finally {
      restore();
    }
  });

  it('keeps a plain-text error body as-is', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response('upstream exploded', { status: 500 })));
    try {
      const deps = updateDeps();
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toBe('upstream exploded');
    } finally {
      restore();
    }
  });
});

describe('handleSetAgentAutoUpdate', () => {
  it('persists the setting and propagates to a docker-capable host', async () => {
    // Second findById (after the write) reflects the persisted value.
    const repo = mockRepo({ findById: mock(() => Promise.resolve(mockRow({ autoUpdate: true }))) });
    const propagate = mock(async (_host: unknown, _enabled: boolean) => ({ applied: true }));
    const result = await handleSetAgentAutoUpdate({ repo, propagatePolicy: propagate }, { hostId: 1, autoUpdate: true });

    expect(repo.updateAutoUpdate).toHaveBeenCalledWith(1, true);
    expect(propagate).toHaveBeenCalledTimes(1);
    expect(result.host.autoUpdate).toBe(true);
    expect(result.propagation.applied).toBe(true);
  });

  it('skips propagation for hosts without Docker capability but still persists', async () => {
    const repo = mockRepo({ findById: mock(() => Promise.resolve(mockRow({ capabilities: { docker: false } }))) });
    const propagate = mock(async () => ({ applied: true }));
    const result = await handleSetAgentAutoUpdate({ repo, propagatePolicy: propagate }, { hostId: 1, autoUpdate: true });

    expect(result.propagation.applied).toBe(false);
    expect(result.propagation.warning).toContain('no Docker capability');
    expect(repo.updateAutoUpdate).toHaveBeenCalledWith(1, true);
    expect(propagate).not.toHaveBeenCalled();
  });

  it('keeps the stored setting and reports a warning when propagation fails', async () => {
    const repo = mockRepo();
    const propagate = mock(async () => ({ applied: false, warning: 'agent unreachable' }));
    const result = await handleSetAgentAutoUpdate({ repo, propagatePolicy: propagate }, { hostId: 1, autoUpdate: false });

    expect(repo.updateAutoUpdate).toHaveBeenCalledWith(1, false);
    expect(result.propagation.applied).toBe(false);
    expect(result.propagation.warning).toBe('agent unreachable');
    expect(result.host.autoUpdate).toBe(false);
  });

  it('throws when host not found', async () => {
    const repo = mockRepo({ findById: mock(() => Promise.resolve(null)) });
    await expect(handleSetAgentAutoUpdate({ repo }, { hostId: 99, autoUpdate: true })).rejects.toThrow('not found');
  });
});
