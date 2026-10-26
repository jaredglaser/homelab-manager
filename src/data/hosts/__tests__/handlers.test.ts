import { describe, it, expect, mock } from 'bun:test';
import { mockSetTimeout } from '@/lib/test/mock-timers';
import { getAgentImage } from '@/lib/hosts/host-utils';
import type { HostHandlerDeps, HostRepo, KeypairsDep } from '../handlers';
import {
  handleListHosts,
  handleCheckHostHealth,
  handleRemoveHost,
  handleVerifyHost,
  handleUpdateHost,
  handleGetHostPublicJwk,
  handleRotateHostKeypair,
  handleRotateHostTls,
  handleUpdateAgent,
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
    agentImageDigest: null,
    agentOutOfDate: false,
    status: 'pending' as const,
    createdAt: NOW, updatedAt: NOW,
    lastSweptAt: null,
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
    getPublicJwkForHost: mock(async (_name: string) => ({
      kty: 'OKP', crv: 'Ed25519', x: 'mock-x',
    } as import('jose').JWK)),
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

  it('provisions TLS and stores the https agent URL on success', async () => {
    const repo = mockRepo({
      update: mock(() => Promise.resolve(mockRow({ agentUrl: 'https://x:9090' }))),
    });
    const deps = {
      ...baseDeps(repo),
      keypairs: makeKeypairsMock(),
      provisionTls: mock(async () => ({ agentUrl: 'https://x:9090' })),
    };
    const result = await handleVerifyHost(deps, { name: 'tlshost', agentUrl: 'http://x:9090' });
    expect(deps.provisionTls).toHaveBeenCalledWith('tlshost', 'http://x:9090');
    expect(repo.update).toHaveBeenCalledWith(1, { agentUrl: 'https://x:9090' });
    expect(result.host.agentUrl).toBe('https://x:9090');
  });

  it('leaves the host pending with the actionable provisioning error on failure', async () => {
    const repo = mockRepo();
    const deps = {
      ...baseDeps(repo),
      keypairs: makeKeypairsMock(),
      provisionTls: mock(async () => {
        throw new Error('TLS provisioning failed: the agent did not become healthy over HTTPS (unreachable). Fix the agent, then re-run TLS provisioning from the Managed Hosts card.');
      }),
    };
    await expect(
      handleVerifyHost(deps, { name: 'tlshost', agentUrl: 'http://x:9090' }),
    ).rejects.toThrow(/TLS provisioning failed: the agent did not become healthy over HTTPS/);
    expect(repo.delete).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('creates the host record with the original URL before the https rewrite', async () => {
    const repo = mockRepo();
    const deps = {
      ...baseDeps(repo),
      keypairs: makeKeypairsMock(),
      provisionTls: mock(async () => ({ agentUrl: 'https://x:9090' })),
    };
    await handleVerifyHost(deps, { name: 'tlshost', agentUrl: 'http://x:9090' });
    expect(repo.create).toHaveBeenCalledWith({
      name: 'tlshost',
      agentUrl: 'http://x:9090',
      capabilities: undefined,
    });
  });
});

describe('handleRotateHostTls', () => {
  it('re-runs provisioning against the current agent URL and stores the resulting https URL', async () => {
    const repo = mockRepo({
      findById: mock(() => Promise.resolve(mockRow({ id: 7, name: 'rot-host', agentUrl: 'https://old:9090' }))),
      update: mock(() => Promise.resolve(mockRow({ id: 7, agentUrl: 'https://new:9090' }))),
    });
    const provisionTls = mock(async (_hostName: string, _agentUrl: string) => ({ agentUrl: 'https://new:9090' }));
    const result = await handleRotateHostTls({ repo, provisionTls }, { hostId: 7 });
    expect(provisionTls).toHaveBeenCalledWith('rot-host', 'https://old:9090');
    expect(repo.update).toHaveBeenCalledWith(7, { agentUrl: 'https://new:9090' });
    expect(result).toEqual({ hostId: 7, agentUrl: 'https://new:9090' });
  });

  it('propagates the provisioning error without touching the host record', async () => {
    const repo = mockRepo();
    const deps = {
      repo,
      provisionTls: mock(async () => {
        throw new Error('TLS provisioning failed: the agent could not be reached to create its certificate (unreachable). Fix the agent, then re-run TLS provisioning from the Managed Hosts card.');
      }),
    };
    await expect(handleRotateHostTls(deps, { hostId: 1 })).rejects.toThrow(/TLS provisioning failed/);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
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

describe('handleGetHostPublicJwk', () => {
  it('returns the stored public JWK for the host', async () => {
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: 'stored-x' } as import('jose').JWK;
    const deps = {
      ...baseDeps(),
      keypairs: { ...makeKeypairsMock(), getPublicJwkForHost: mock(async () => jwk) },
    };

    const result = await handleGetHostPublicJwk(deps, { hostId: 1 });

    expect(result.publicJwk).toEqual(jwk);
    expect(deps.keypairs.getPublicJwkForHost).toHaveBeenCalledWith('test-host');
  });

  it('throws when host not found', async () => {
    const deps = {
      ...baseDeps({ findById: mock(() => Promise.resolve(null)) }),
      keypairs: makeKeypairsMock(),
    };
    await expect(handleGetHostPublicJwk(deps, { hostId: 999 })).rejects.toThrow('not found');
  });

  it('throws when the host has no keypair', async () => {
    const deps = {
      ...baseDeps(),
      keypairs: { ...makeKeypairsMock(), getPublicJwkForHost: mock(async () => null) },
    };
    await expect(handleGetHostPublicJwk(deps, { hostId: 1 })).rejects.toThrow(/No agent keypair/);
  });
});

describe('handleRotateHostKeypair', () => {
  it('regenerates the keypair via createForHost and returns the new JWK', async () => {
    const newJwk = { kty: 'OKP', crv: 'Ed25519', x: 'new-x' } as import('jose').JWK;
    const keypairs = { ...makeKeypairsMock(), createForHost: mock(async () => ({ publicJwk: newJwk })) };
    const deps = { ...baseDeps(), keypairs };

    const result = await handleRotateHostKeypair(deps, { hostId: 1 });

    expect(result).toEqual({ hostId: 1, publicJwk: newJwk });
    expect(keypairs.createForHost).toHaveBeenCalledWith('test-host');
  });

  it('does not modify the host record', async () => {
    const repo = mockRepo();
    const deps = { ...baseDeps(), repo, keypairs: makeKeypairsMock() };

    await handleRotateHostKeypair(deps, { hostId: 1 });

    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('throws when host not found', async () => {
    const deps = {
      ...baseDeps({ findById: mock(() => Promise.resolve(null)) }),
      keypairs: makeKeypairsMock(),
    };
    await expect(handleRotateHostKeypair(deps, { hostId: 999 })).rejects.toThrow('not found');
  });
});

describe('handleUpdateAgent', () => {
  const getSigner = mock(async (_name: string) => mock(async () => 'jwt-token'));

  const TEST_DIGEST = 'sha256:' + 'b'.repeat(64);
  const TEST_TARGET = `ghcr.io/jaredglaser/homelab-manager-agent@${TEST_DIGEST}`;

  function updateDeps(
    repo?: Partial<HostRepo>,
    checkHealth?: (url: string, hostName: string) => Promise<import('@/lib/hosts/host-utils').HealthCheckOutcome>,
    resolveAgentImageDigest?: (imageRef: string) => Promise<string | null>,
  ) {
    return {
      ...baseDeps(repo),
      getSigner,
      checkHealth: checkHealth ?? mock(() => Promise.resolve({ healthy: true as const, version: '1.0.0' })),
      resolveAgentImageDigest: resolveAgentImageDigest ?? mock(async (_imageRef: string) => TEST_DIGEST),
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

  it('resolves the build-time image to a digest and sends it as the trigger target', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ updateAvailable: false }), { status: 200 })));
    try {
      const resolveAgentImageDigest = mock(async (_imageRef: string) => TEST_DIGEST);
      const deps = updateDeps(undefined, undefined, resolveAgentImageDigest);
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(true);
      expect(resolveAgentImageDigest).toHaveBeenCalledWith(getAgentImage());
      expect(resolveAgentImageDigest).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://192.168.1.10:9090/agent/update',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ targetImage: TEST_TARGET }),
        }),
      );
    } finally {
      restore();
    }
  });

  it('fails without triggering when the registry cannot resolve the digest', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('{}', { status: 202 })));
    try {
      const deps = updateDeps(undefined, undefined, mock(async (_imageRef: string) => null));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) {
        expect(result.error).toBe('Could not resolve the agent image digest from the registry');
        expect(result.suggestions).toContain('Verify ghcr.io/jaredglaser/homelab-manager-agent is reachable and public');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
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

  it('reports a keypair failure with suggestions when the signer throws', async () => {
    const deps = {
      ...updateDeps(),
      getSigner: mock(async () => {
        throw new Error('keyring locked');
      }),
    };
    const result = await handleUpdateAgent(deps, { hostId: 1 });
    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.error).toBe('Could not retrieve agent keypair');
      expect(result.suggestions).toContain('Verify the agent has been enrolled with a generated public JWK');
    }
  });

  it('reports a signing failure with suggestions when the signer call throws', async () => {
    const signingSigner = mock(async () => {
      throw new Error('key encoding failed');
    });
    const deps = {
      ...updateDeps(),
      getSigner: mock(async () => signingSigner),
    };
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('{}', { status: 202 })));
    try {
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) {
        expect(result.error).toBe('Could not sign the agent request token');
        expect(result.suggestions).toContain('Verify the agent has been enrolled with a generated public JWK');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('reports a network failure when the trigger request throws', async () => {
    const { restore } = withFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    try {
      const deps = updateDeps();
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toBe('ECONNREFUSED');
    } finally {
      restore();
    }
  });

  it('reports an unexpected redirect from the agent URL', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response(null, { status: 302 })));
    try {
      const deps = updateDeps();
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toBe('Agent URL returned an unexpected redirect');
    } finally {
      restore();
    }
  });

  it('requires an observed restart before accepting a version when /info is unsupported', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      const deps = updateDeps(undefined, mock(() => Promise.resolve({ healthy: true as const, version: undefined, infoSupported: false })));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toBe('The agent stayed reachable throughout the update window, so its restart could not be confirmed');
    } finally {
      timers.restore();
      restore();
    }
  });

  it('accepts the version after an observed restart when /info is unsupported', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      let calls = 0;
      const deps = updateDeps(undefined, mock(() => {
        calls += 1;
        // Pre-check succeeds without a version. Poll two observes the restart, then the agent is back.
        return Promise.resolve(calls === 1
          ? { healthy: true as const, version: undefined, infoSupported: false }
          : calls === 2
            ? ({ healthy: false as const, error: 'restarting' })
            : { healthy: true as const, version: '9.9.9', infoSupported: false }
        );
      }));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(true);
      if (result.healthy) expect(result.version).toBe('9.9.9');
    } finally {
      timers.restore();
      restore();
    }
  });

  it('reports success when the version is unchanged after the trigger', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      const deps = updateDeps(undefined, mock(() => Promise.resolve({ healthy: true as const, version: '1.0.0' })));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(true);
    } finally {
      timers.restore();
      restore();
    }
  });

  it('reports an unreadable version when the agent is healthy but reports none after the trigger', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      let calls = 0;
      const deps = updateDeps(undefined, mock(() => {
        calls += 1;
        // Pre-check succeeds without a version. Every poll stays healthy but versionless.
        return Promise.resolve(calls === 1
          ? { healthy: true as const, version: undefined }
          : { healthy: true as const, version: undefined });
      }));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toBe('Agent is reachable but its version could not be read, so the update could not be confirmed');
    } finally {
      timers.restore();
      restore();
    }
  });

  it('reports the agent did not restart when health goes down after the trigger', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      let calls = 0;
      const deps = updateDeps(undefined, mock(() => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({ healthy: true as const, version: '1.0.0' })
          : Promise.resolve({ healthy: false as const, error: 'connection refused during health check' });
      }));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toBe('Agent did not restart after update');
    } finally {
      timers.restore();
      restore();
    }
  });

  it('reports an unconfirmed update when an info-less agent never restarts', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      let calls = 0;
      const deps = updateDeps(undefined, mock(() => {
        calls += 1;
        // The pre-check answers without a version and /info 404s; every poll is healthy with a version.
        return Promise.resolve(
          calls === 1
            ? { healthy: true as const, infoSupported: false }
            : { healthy: true as const, version: '1.0.0', infoSupported: false },
        );
      }));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) {
        expect(result.error).toBe('The agent stayed reachable throughout the update window, so its restart could not be confirmed');
        expect(result.suggestions).toContain('Re-run the update after the current attempt settles');
      }
    } finally {
      timers.restore();
      restore();
    }
  });

  it('surfaces a non-202 trigger response as a failure', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ error: 'Agent updates require Docker capability, which this agent does not have.' }), { status: 503 })));
    try {
      const deps = updateDeps();
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toContain('Docker capability');
    } finally {
      restore();
    }
  });

  it('surfaces a plain-text check-failure body from the trigger endpoint', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response('Update check failed. Verify the agent host can reach the image registry, then retry the update.', { status: 503 })));
    try {
      const deps = updateDeps();
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.error).toBe('Update check failed. Verify the agent host can reach the image registry, then retry the update.');
    } finally {
      restore();
    }
  });

});

