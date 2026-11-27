import { describe, it, expect, mock, spyOn } from 'bun:test';
import { agentResponse } from '@/lib/test/agent-response';
import { mockSetTimeout } from '@/lib/test/mock-timers';
import { NOT_ANSWERING_BODY_TIMEOUT_MS } from '@/lib/clients/agent-identity';
import { getAgentImage } from '@/lib/hosts/host-utils';
import type { JWK } from 'jose';
import type { HostHandlerDeps, HostRepo, KeypairsDep } from '../handlers';
import {
  handleListHosts,
  handleCheckHostHealth,
  handleRemoveHost,
  handleCreatePendingHost,
  handleUpdateHost,
  handleGetHostPublicJwk,
  handleRotateHostKeypair,
  handleRotateHostTls,
  handleUpdateAgent,
} from '../handlers';
import { TlsProvisionFailure } from '@/lib/services/agent-provisioning-service';
import { missingAgentKeypairError } from '@/lib/errors/agent-messages';
import { TaggedServerError } from '@/lib/errors/tagged-server-error';
import { updateFailureMessage } from '@/lib/errors/agent-route-failure-copy';
import { hostFailureMessage, type HostFailureCode } from '@/lib/errors/host-failure-copy';

const MOCK_JWK: JWK = { kty: 'OKP', crv: 'Ed25519', x: 'mock-x' };

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
    failure: null,
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
    create: mock((input: { name: string; agentUrl: string }) =>
      Promise.resolve(mockRow({ name: input.name, agentUrl: input.agentUrl }))),
    findByName: mock((_name: string) => Promise.resolve(null)),
    update: mock(() => Promise.resolve(mockRow())),
    delete: mock(() => Promise.resolve()),
    updateHealth: mock(() => Promise.resolve()),
    updateAgentInfo: mock(() => Promise.resolve()),
    ...overrides,
  } as HostRepo;
}

function healthyProbe() {
  return mock(() => Promise.resolve({ healthy: true as const }));
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
    // Default: no keypair enrolled yet, so the create path is exercised.
    getPublicJwkForHost: mock(async (_name: string) => null),
    getOrCreateForHost: mock(() => Promise.resolve(MOCK_JWK)),
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
    expect(repo.updateHealth).toHaveBeenCalledWith(1, { status: 'healthy', failure: null }, 'http://192.168.1.10:9090');
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
    const repo = mockRepo({ findById: mock(() => Promise.resolve(mockRow({ status: 'healthy' }))) });
    const deps = { ...baseDeps(), repo, checkHealth: mock(() => Promise.resolve({ healthy: false as const, reason: 'offline' as const, error: 'refused' })) };
    const result = await handleCheckHostHealth(deps, { hostId: 1 });
    expect(result.healthy).toBe(false);
    if (!result.healthy) expect(result.code).toBe('offline');
    expect(repo.updateHealth).toHaveBeenCalledWith(1, { status: 'unhealthy', failure: { code: 'offline', detail: 'refused' } }, 'http://192.168.1.10:9090');
    expect(repo.updateAgentInfo).not.toHaveBeenCalled();
  });

  it('records the fallback code when the probe failed without naming a reason', async () => {
    const updateHealth = mock(() => Promise.resolve());
    const deps = { ...baseDeps({ updateHealth, findById: mock(() => Promise.resolve(mockRow({ status: 'healthy' }))) }), checkHealth: mock(() => Promise.resolve({ healthy: false as const, error: 'boom' })) };
    const result = await handleCheckHostHealth(deps, { hostId: 1 });
    if (!result.healthy) expect(result.code).toBe('health_check_failed');
    expect(updateHealth).toHaveBeenCalledWith(1, { status: 'unhealthy', failure: { code: 'health_check_failed', detail: 'boom' } }, 'http://192.168.1.10:9090');
  });

  it('keeps a failing pending host pending while recording the cause, so a wizard host stays eligible for enrollment', async () => {
    const updateHealth = mock(() => Promise.resolve());
    const deps = {
      ...baseDeps({ updateHealth }),
      checkHealth: mock(() => Promise.resolve({ healthy: false as const, reason: 'offline' as const, error: 'refused' })),
    };

    await handleCheckHostHealth(deps, { hostId: 1 });

    expect(updateHealth).toHaveBeenCalledWith(
      1,
      { status: 'pending', failure: { code: 'offline', detail: 'refused' } },
      'http://192.168.1.10:9090',
    );
  });

  it('records an awaiting-enrollment probe as that cause', async () => {
    const updateHealth = mock(() => Promise.resolve());
    const deps = { ...baseDeps({ updateHealth, findById: mock(() => Promise.resolve(mockRow({ status: 'healthy' }))) }), checkHealth: mock(() => Promise.resolve({ healthy: false as const, reason: 'awaiting-enrollment' as const, error: 'plain HTTP' })) };
    await handleCheckHostHealth(deps, { hostId: 1 });
    expect(updateHealth).toHaveBeenCalledWith(1, { status: 'unhealthy', failure: { code: 'awaiting-enrollment', detail: 'plain HTTP' } }, 'http://192.168.1.10:9090');
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

  it('rejects an expectStatus removal when the host is no longer pending and deletes nothing', async () => {
    const deps = removeDeps({ findById: mock(() => Promise.resolve(mockRow({ status: 'healthy' }))) });
    await expect(
      handleRemoveHost(deps, { hostId: 1, expectStatus: 'pending' }),
    ).rejects.toThrow('Host test-host is no longer pending');
    expect(deps.keypairs.deleteForHost).not.toHaveBeenCalled();
    expect(deps.repo.delete).not.toHaveBeenCalled();
  });

  it('still deletes a healthy host when no expectStatus is requested', async () => {
    const deps = removeDeps({ findById: mock(() => Promise.resolve(mockRow({ status: 'healthy' }))) });
    const result = await handleRemoveHost(deps, { hostId: 1 });
    expect(result.success).toBe(true);
    expect(deps.keypairs.deleteForHost).toHaveBeenCalledWith('test-host');
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

});

describe('handleCreatePendingHost', () => {
  function createDeps(repo?: Partial<HostRepo>) {
    return { ...baseDeps(repo), keypairs: makeKeypairsMock() };
  }

  it('creates a pending host with an empty agent URL and returns the public JWK', async () => {
    const deps = createDeps();
    const result = await handleCreatePendingHost(deps, { name: 'newhost', capabilities: { docker: true } });
    expect(deps.repo.create).toHaveBeenCalledWith({ name: 'newhost', agentUrl: '', capabilities: { docker: true } });
    expect(deps.keypairs.getOrCreateForHost).toHaveBeenCalledWith('newhost');
    expect(result.publicJwk).toBeDefined();
    expect(result.host.status).toBe('pending');
  });

  it('reuses an existing pending host and its enrolled keypair (get-or-create)', async () => {
    const repo = mockRepo({ findByName: mock((_n: string) => Promise.resolve(mockRow())) });
    const keypairs = {
      ...makeKeypairsMock(),
      getPublicJwkForHost: mock(async (_n: string) =>
        ({ kty: 'OKP', crv: 'Ed25519', x: 'enrolled-x' } as import('jose').JWK)),
    };
    const deps = { ...baseDeps(repo), keypairs };
    const result = await handleCreatePendingHost(deps, { name: 'dev' });
    expect(repo.create).not.toHaveBeenCalled();
    expect(deps.keypairs.createForHost).not.toHaveBeenCalled();
    expect(deps.keypairs.getOrCreateForHost).not.toHaveBeenCalled();
    expect(result.publicJwk?.x).toBe('enrolled-x');
    expect(result.host.status).toBe('pending');
  });

  it('refreshes capabilities on a pending host when they changed', async () => {
    const repo = mockRepo({
      findByName: mock((_n: string) => Promise.resolve(mockRow({ capabilities: { docker: true } }))),
      update: mock(() => Promise.resolve(mockRow({ capabilities: { docker: true, zfs: true } }))),
    });
    const deps = createDeps(repo);
    await handleCreatePendingHost(deps, { name: 'dev', capabilities: { docker: true, zfs: true } });
    expect(repo.update).toHaveBeenCalledWith(1, { capabilities: { docker: true, zfs: true } });
  });

  it('does not update a pending host whose capabilities already match', async () => {
    const repo = mockRepo({
      findByName: mock((_n: string) => Promise.resolve(mockRow({ capabilities: { docker: true } }))),
    });
    const deps = createDeps(repo);
    await handleCreatePendingHost(deps, { name: 'dev', capabilities: { docker: true } });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('does not touch capabilities on a host that is not pending', async () => {
    const repo = mockRepo({
      findByName: mock((_n: string) => Promise.resolve(mockRow({ status: 'healthy' }))),
    });
    const deps = createDeps(repo);
    const result = await handleCreatePendingHost(deps, { name: 'dev', resumeHostId: 1, capabilities: { docker: true, zfs: true } });
    expect(repo.update).not.toHaveBeenCalled();
    expect(result.host.status).toBe('healthy');
  });

  it.each([
    ['no host to resume', undefined],
    ['another host to resume', 2],
  ])('refuses the name of an enrolled host, tagged for the name field, when the wizard has %s', async (_label, resumeHostId) => {
    const repo = mockRepo({
      findByName: mock((_n: string) => Promise.resolve(mockRow({ status: 'healthy' }))),
    });
    const deps = createDeps(repo);
    const attempt = handleCreatePendingHost(deps, { name: 'dev', resumeHostId });
    await expect(attempt).rejects.toBeInstanceOf(TaggedServerError);
    await expect(attempt).rejects.toMatchObject({ code: 'name_taken', field: 'name' });
    expect(repo.create).not.toHaveBeenCalled();
    expect(deps.keypairs.getOrCreateForHost).not.toHaveBeenCalled();
  });

  it('rolls back a newly created record when keypair generation fails', async () => {
    const deps = createDeps();
    deps.keypairs.getOrCreateForHost = mock(() => Promise.reject(new Error('keygen failed')));
    await expect(handleCreatePendingHost(deps, { name: 'new' })).rejects.toThrow(/Failed to generate agent keypair/);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('keeps a pre-existing record when keypair generation fails', async () => {
    const repo = mockRepo({ findByName: mock((_n: string) => Promise.resolve(mockRow())) });
    const deps = createDeps(repo);
    deps.keypairs.getOrCreateForHost = mock(() => Promise.reject(new Error('keygen failed')));
    await expect(handleCreatePendingHost(deps, { name: 'dev' })).rejects.toThrow(/Failed to generate agent keypair/);
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('rolls back a freshly created record when the keypair read fails', async () => {
    const deps = createDeps();
    deps.keypairs.getPublicJwkForHost = mock(() => Promise.reject(new Error('keypair store unreachable')));
    await expect(
      handleCreatePendingHost(deps, { name: 'new' }),
    ).rejects.toThrow(/Failed to generate agent keypair: keypair store unreachable/);
    expect(deps.repo.delete).toHaveBeenCalledWith(1);
  });

  it('trims the host name', async () => {
    const deps = createDeps();
    await handleCreatePendingHost(deps, { name: '  padded  ' });
    expect(deps.repo.create).toHaveBeenCalledWith({ name: 'padded', agentUrl: '', capabilities: { docker: false, zfs: false } });
  });

  it('keeps a pre-existing record when the keypair read fails', async () => {
    const repo = mockRepo({
      findByName: mock((_name: string) => Promise.resolve(mockRow())),
    });
    const deps = {
      ...baseDeps(repo),
      keypairs: {
        ...makeKeypairsMock(),
        getPublicJwkForHost: mock((_name: string) => Promise.reject(new Error('keypair store unreachable'))),
      },
    };
    let message = '';
    try {
      await handleCreatePendingHost(deps, { name: 'tlshost' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/Failed to generate agent keypair/);
    expect(message).not.toContain('cleaned up');
    expect(repo.delete).not.toHaveBeenCalled();
  });
});

describe('handleRotateHostTls', () => {
  it('re-runs provisioning against the current agent URL and stores the resulting https URL', async () => {
    const repo = mockRepo({
      findById: mock(() => Promise.resolve(mockRow({ id: 7, name: 'rot-host', agentUrl: 'https://old:9090', status: 'healthy' }))),
      update: mock(() => Promise.resolve(mockRow({ id: 7, agentUrl: 'https://new:9090' }))),
    });
    const provisionTls = mock(async (_hostName: string, _agentUrl: string) => ({ agentUrl: 'https://new:9090' }));
    const result = await handleRotateHostTls({ repo, provisionTls, checkHealth: healthyProbe() }, { hostId: 7 });
    expect(provisionTls).toHaveBeenCalledWith('rot-host', 'https://old:9090', {
      allowPlaintextEnrollment: false,
    });
    expect(repo.update).toHaveBeenCalledWith(7, { agentUrl: 'https://new:9090' });
    expect(result).toEqual({ ok: true, hostId: 7, agentUrl: 'https://new:9090', enrolledOverPlainHttp: false, fingerprint: '' });
  });

  it('provisions against an explicit agentUrl override and persists only the flipped https URL', async () => {
    const repo = mockRepo({
      findById: mock(() => Promise.resolve(mockRow({ id: 7, name: 'rot-host', agentUrl: 'https://old:9090', status: 'healthy' }))),
      update: mock(() => Promise.resolve(mockRow({ id: 7, agentUrl: 'https://new:9090' }))),
    });
    const provisionTls = mock(async (_hostName: string, _agentUrl: string) => ({ agentUrl: 'https://new:9090' }));
    const result = await handleRotateHostTls({ repo, provisionTls, checkHealth: healthyProbe() }, { hostId: 7, agentUrl: 'http://candidate:9090' });
    expect(provisionTls).toHaveBeenCalledWith('rot-host', 'http://candidate:9090', {
      allowPlaintextEnrollment: false,
    });
    expect(repo.update).toHaveBeenCalledWith(7, { agentUrl: 'https://new:9090' });
    expect(result).toEqual({ ok: true, hostId: 7, agentUrl: 'https://new:9090', enrolledOverPlainHttp: false, fingerprint: '' });
  });

  it('never writes the row when provisioning with an agentUrl override fails', async () => {
    const repo = mockRepo({
      findById: mock(() => Promise.resolve(mockRow({ id: 7, name: 'rot-host', agentUrl: 'https://working:9090' }))),
    });
    const deps = {
      repo,
      checkHealth: healthyProbe(),
      provisionTls: mock(async (_hostName: string, _agentUrl: string) => {
        throw new Error('TLS provisioning failed: the agent could not be reached to create its certificate (unreachable). Fix the agent, then re-run TLS provisioning from the Managed Hosts card.');
      }),
    };
    await expect(handleRotateHostTls(deps, { hostId: 7, agentUrl: 'http://candidate:9090' })).rejects.toThrow(/TLS provisioning failed/);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('propagates an uncoded provisioning error without touching the host record', async () => {
    const repo = mockRepo();
    const deps = {
      repo,
      checkHealth: healthyProbe(),
      provisionTls: mock(async () => {
        throw new Error('TLS provisioning failed: the agent could not be reached to create its certificate (unreachable). Fix the agent, then re-run TLS provisioning from the Managed Hosts card.');
      }),
    };
    await expect(handleRotateHostTls(deps, { hostId: 1 })).rejects.toThrow(/TLS provisioning failed/);
    expect(repo.update).not.toHaveBeenCalled();
    expect(repo.delete).not.toHaveBeenCalled();
  });

  it('returns the failure code as data instead of throwing, so the UI can map it', async () => {
    const repo = mockRepo();
    const deps = {
      repo,
      checkHealth: healthyProbe(),
      provisionTls: mock(async () => {
        throw new TlsProvisionFailure('signature_invalid', 'the agent does not trust this keypair');
      }),
    };
    expect(await handleRotateHostTls(deps, { hostId: 1 })).toEqual({
      ok: false,
      code: 'signature_invalid',
      message: 'the agent does not trust this keypair',
    });
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('re-probes the rotated host and records its verdict, so a cause about the old certificate does not outlive the rotation', async () => {
    let row = mockRow({
      id: 7,
      name: 'rot-host',
      status: 'unhealthy',
      agentUrl: 'https://old:9090',
      failure: { code: 'certificate-rejected', detail: 'self signed certificate' },
    });
    const updateHealth = mock(() => Promise.resolve());
    const repo = mockRepo({
      findById: mock(() => Promise.resolve(row)),
      update: mock((id: number, fields: { agentUrl?: string }) => {
        row = { ...row, id, ...fields };
        return Promise.resolve(row);
      }),
      updateHealth,
    });
    const checkHealth = healthyProbe();
    const provisionTls = mock(() => Promise.resolve({ agentUrl: 'https://new:9090' }));

    await handleRotateHostTls({ repo, provisionTls, checkHealth }, { hostId: 7 });

    expect(checkHealth).toHaveBeenCalledWith('https://new:9090', 'rot-host');
    expect(updateHealth).toHaveBeenCalledWith(7, { status: 'healthy', failure: null }, 'https://new:9090');
  });

  it('does not probe after a failed rotation', async () => {
    const repo = mockRepo({
      findById: mock(() => Promise.resolve(mockRow({ status: 'unhealthy', failure: { code: 'offline', detail: null } }))),
    });
    const checkHealth = healthyProbe();
    await handleRotateHostTls(
      {
        repo,
        checkHealth,
        provisionTls: mock(() => Promise.reject(new TlsProvisionFailure('signature_invalid', 'the agent does not trust this keypair'))),
      },
      { hostId: 1 },
    );
    expect(checkHealth).not.toHaveBeenCalled();
  });

  it('maps a missing keypair to no_keypair rather than a throw', async () => {
    const repo = mockRepo();
    const deps = {
      repo,
      checkHealth: healthyProbe(),
      provisionTls: mock(async () => {
        throw missingAgentKeypairError('test-host');
      }),
    };
    const result = await handleRotateHostTls(deps, { hostId: 1 });
    expect(result).toMatchObject({ ok: false, code: 'no_keypair' });
    expect(repo.update).not.toHaveBeenCalled();
  });
});
describe('handleUpdateHost', () => {
  it('updates agentUrl and returns mapped HostListItem when name is unchanged', async () => {
    const updatedRow = mockRow({ name: 'test-host', agentUrl: 'http://new-url:9090' });
    const repo = mockRepo({ update: mock(() => Promise.resolve(updatedRow)) });
    const deps = baseDeps();
    deps.repo = repo;

    const result = await handleUpdateHost({ ...deps, checkHealth: healthyProbe() }, { hostId: 1, name: 'test-host', agentUrl: 'http://new-url:9090' });

    expect(result.name).toBe('test-host');
    expect(result.agentUrl).toBe('http://new-url:9090');
    expect(repo.update).toHaveBeenCalledWith(1, { agentUrl: 'http://new-url:9090' });
  });

  it('throws when host not found', async () => {
    const deps = baseDeps({ findById: mock(() => Promise.resolve(null)) });
    await expect(handleUpdateHost({ ...deps, checkHealth: healthyProbe() }, { hostId: 999 })).rejects.toThrow('not found');
  });

  it('rejects a changed name and does not write', async () => {
    const repo = mockRepo();
    const deps = baseDeps();
    deps.repo = repo;

    await expect(
      handleUpdateHost({ ...deps, checkHealth: healthyProbe() }, { hostId: 1, name: 'renamed', agentUrl: 'http://new-url:9090' }),
    ).rejects.toThrow(/cannot be changed after enrollment/);
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('treats a whitespace-padded matching name as unchanged', async () => {
    const repo = mockRepo();
    const deps = baseDeps();
    deps.repo = repo;

    await handleUpdateHost({ ...deps, checkHealth: healthyProbe() }, { hostId: 1, name: '  test-host  ', agentUrl: 'http://x:9090' });

    expect(repo.update).toHaveBeenCalledWith(1, { agentUrl: 'http://x:9090' });
  });

  it('updates agentUrl when name is omitted', async () => {
    const repo = mockRepo();
    const deps = baseDeps();
    deps.repo = repo;

    await handleUpdateHost({ ...deps, checkHealth: healthyProbe() }, { hostId: 1, agentUrl: 'http://x:9090' });

    expect(repo.update).toHaveBeenCalledWith(1, { agentUrl: 'http://x:9090' });
  });

  describe('re-probing after the URL changes', () => {
    function staleHost(status: 'unhealthy' | 'pending') {
      let row = mockRow({
        status,
        agentUrl: 'http://old:9090',
        failure: status === 'unhealthy' ? { code: 'unreachable', detail: 'Agent returned status 404' } : null,
      });
      const updateHealth = mock(() => Promise.resolve());
      const repo = mockRepo({
        findById: mock(() => Promise.resolve(row)),
        update: mock((id: number, fields: { agentUrl?: string }) => {
          row = { ...row, id, ...fields };
          return Promise.resolve(row);
        }),
        updateHealth,
      });
      return { repo, updateHealth };
    }

    it('probes the new URL and records its verdict, so the old cause does not outlive the edit', async () => {
      const { repo, updateHealth } = staleHost('unhealthy');
      const checkHealth = healthyProbe();

      await handleUpdateHost({ repo, checkHealth }, { hostId: 1, agentUrl: 'http://new:9090' });

      expect(checkHealth).toHaveBeenCalledWith('http://new:9090', 'test-host');
      expect(updateHealth).toHaveBeenCalledWith(1, { status: 'healthy', failure: null }, 'http://new:9090');
    });

    it('records the new cause when the new URL fails too', async () => {
      const { repo, updateHealth } = staleHost('unhealthy');
      const checkHealth = mock(() =>
        Promise.resolve({ healthy: false as const, reason: 'offline' as const, error: 'refused' }));

      await handleUpdateHost({ repo, checkHealth }, { hostId: 1, agentUrl: 'http://new:9090' });

      expect(updateHealth).toHaveBeenCalledWith(
        1,
        { status: 'unhealthy', failure: { code: 'offline', detail: 'refused' } },
        'http://new:9090',
      );
    });

    it('does not probe when the URL is unchanged', async () => {
      const { repo } = staleHost('unhealthy');
      const checkHealth = healthyProbe();

      await handleUpdateHost({ repo, checkHealth }, { hostId: 1, agentUrl: 'http://old:9090' });

      expect(checkHealth).not.toHaveBeenCalled();
    });

    it('probes a pending host after the edit and keeps it pending when the new URL fails', async () => {
      const { repo, updateHealth } = staleHost('pending');
      const checkHealth = mock(() =>
        Promise.resolve({ healthy: false as const, reason: 'awaiting-enrollment' as const, error: 'plain HTTP' }));

      await handleUpdateHost({ repo, checkHealth }, { hostId: 1, agentUrl: 'http://new:9090' });

      expect(updateHealth).toHaveBeenCalledWith(
        1,
        { status: 'pending', failure: { code: 'awaiting-enrollment', detail: 'plain HTTP' } },
        'http://new:9090',
      );
    });

    it('still saves the edit when the re-check cannot be recorded', async () => {
      const { repo } = staleHost('unhealthy');
      const checkHealth = mock(() => Promise.reject(new Error('probe crashed')));
      const consoleError = spyOn(console, 'error').mockImplementation(() => undefined);

      const result = await handleUpdateHost({ repo, checkHealth }, { hostId: 1, agentUrl: 'http://new:9090' });

      expect(result.agentUrl).toBe('http://new:9090');
      expect(consoleError).toHaveBeenCalled();
      consoleError.mockRestore();
    });
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
    await expect(handleGetHostPublicJwk(deps, { hostId: 1 })).rejects.toThrow(/no keypair for host/);
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
    expect(repo.updateHealth).not.toHaveBeenCalled();
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

  function chunkedStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) controller.close();
        else controller.enqueue(chunks[index++]);
      },
    });
  }

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
        expect(result.code).toBe('image_digest_unresolved');
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('fails before update when the agent is offline', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('{}', { status: 202 })));
    try {
      const deps = updateDeps(undefined, mock(() => Promise.resolve({ healthy: false as const, reason: 'offline' as const, error: 'connection refused' })));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.code).toBe('offline');
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
      expect(repo.updateHealth).toHaveBeenCalledWith(1, { status: 'healthy', failure: null }, 'http://192.168.1.10:9090');
      expect(repo.updateAgentInfo).toHaveBeenCalledWith(1, { version: '2.0.0', imageDigest: TEST_DIGEST, outOfDate: false });
    } finally {
      restore();
    }
  });

  it('reports a keypair failure when the signer throws', async () => {
    const deps = {
      ...updateDeps(),
      getSigner: mock(async () => {
        throw new Error('keyring locked');
      }),
    };
    const result = await handleUpdateAgent(deps, { hostId: 1 });
    expect(result.healthy).toBe(false);
    if (!result.healthy) {
      expect(result.code).toBe('keypair_unavailable');
    }
  });

  it('reports a signing failure when the signer call throws', async () => {
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
        expect(result.code).toBe('token_signing_failed');
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
      if (!result.healthy) expect(result.code).toBe('agent_unreachable');
      if (!result.healthy) expect(result.message).toBe('ECONNREFUSED');
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
      if (!result.healthy) expect(result.code).toBe('unexpected_redirect');
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
      if (!result.healthy) expect(result.code).toBe('restart_unconfirmed');
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

  it('reports an interrupted update when the agent still runs the previous digest', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      const staleDigest = 'sha256:' + 'a'.repeat(64);
      const deps = updateDeps(undefined, mock(() =>
        Promise.resolve({ healthy: true as const, version: '1.0.0', agentImageDigest: staleDigest }),
      ));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) {
        expect(result.code).toBe('update_interrupted');
      }
    } finally {
      timers.restore();
      restore();
    }
  });

  it('records the applied digest when a rebuilt image keeps the version string', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    const repo = mockRepo();
    const { restore } = withFetch(() => Promise.resolve(new Response(JSON.stringify({ started: true }), { status: 202 })));
    try {
      const deps = updateDeps(repo, mock(() =>
        Promise.resolve({ healthy: true as const, version: '1.0.0', agentImageDigest: TEST_DIGEST }),
      ));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(true);
      expect(repo.updateHealth).toHaveBeenCalledWith(1, { status: 'healthy', failure: null }, 'http://192.168.1.10:9090');
      expect(repo.updateAgentInfo).toHaveBeenCalledWith(1, { imageDigest: TEST_DIGEST, outOfDate: false });
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
      if (!result.healthy) expect(result.code).toBe('version_unconfirmed');
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
      if (!result.healthy) expect(result.code).toBe('agent_did_not_restart');
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
        // The pre-check answers without a version and /info 404s. Every poll is healthy with a version.
        return Promise.resolve(
          calls === 1
            ? { healthy: true as const, infoSupported: false }
            : { healthy: true as const, version: '1.0.0', infoSupported: false },
        );
      }));
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) {
        expect(result.code).toBe('restart_unconfirmed');
      }
    } finally {
      timers.restore();
      restore();
    }
  });

  it('surfaces a non-202 trigger response as a failure', async () => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse(JSON.stringify({ error: 'Agent updates require Docker capability, which this agent does not have.' }), { status: 503 })));
    try {
      const deps = updateDeps();
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.code).toBe('agent_reported_error');
      if (!result.healthy) expect(result.message).toContain('Docker capability');
    } finally {
      restore();
    }
  });

  it('promotes the code of a coded refusal and keeps the agent message beside it', async () => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse(JSON.stringify({ error: 'An update is already in progress', code: 'update_in_progress' }), { status: 409 })));
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(result).toEqual({ hostId: 1, healthy: false, code: 'update_in_progress', message: 'An update is already in progress' });
    } finally {
      restore();
    }
  });

  it('logs the code and the agent message of a refusal, which the copy may hide', async () => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse(JSON.stringify({ error: 'agent sentence', code: 'update_target_not_pinned' }), { status: 400 })));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('update_target_not_pinned: agent sentence'));
    } finally {
      errorSpy.mockRestore();
      restore();
    }
  });

  it.each([
    ['a code this manager does not know', { error: 'newer refusal', code: 'update_from_the_future' }],
    ['a code that is not a string', { error: 'newer refusal', code: 409 }],
    ['a code that is null', { error: 'newer refusal', code: null }],
    ['a host failure code outside the update set', { error: 'newer refusal', code: 'offline' }],
    ['a route code /agent/update never sends', { error: 'newer refusal', code: 'stack_not_found' }],
    ['a body with no code, as an agent before codes sends', { error: 'newer refusal' }],
  ])('keeps the generic refusal code for %s', async (_label, payload) => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse(JSON.stringify(payload), { status: 409 })));
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(result).toEqual({ hostId: 1, healthy: false, code: 'agent_reported_error', message: 'newer refusal' });
    } finally {
      restore();
    }
  });

  it.each([['null'], ['"update_in_progress"'], ['[]'], ['42']])('keeps the generic code and shows no message for the non-error JSON body %s', async (body) => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse(body, { status: 500, headers: { 'content-type': 'application/json' } })));
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) {
        expect(result.code).toBe('agent_reported_error');
        expect(result.message).toBe('');
      }
    } finally {
      restore();
    }
  });

  it('drops an HTML body the agent sends instead of showing it', async () => {
    const page = '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>';
    const { restore } = withFetch(() => Promise.resolve(agentResponse(page, { status: 502, headers: { 'content-type': 'text/html' } })));
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(result).toEqual({ hostId: 1, healthy: false, code: 'agent_reported_error', message: '' });
    } finally {
      restore();
    }
  });

  it('bounds a long text body to the detail limit after the prefix, on one line', async () => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse(`${'w'.repeat(1000)}\nsecond`, { status: 502, headers: { 'content-type': 'text/plain' } })));
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(result).toEqual({ hostId: 1, healthy: false, code: 'agent_reported_error', message: `It said: ${'w'.repeat(300)}...` });
    } finally {
      restore();
    }
  });

  it('treats a code with no message as off the error contract, so its code is not trusted', async () => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse(JSON.stringify({ code: 'update_in_progress' }), { status: 409 })));
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(result).toEqual({
        hostId: 1,
        healthy: false,
        code: 'agent_reported_error',
        message: 'It said: {"code":"update_in_progress"}',
      });
    } finally {
      restore();
    }
  });

  it('accepts a text/plain content type in any case', async () => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse('Bad Gateway', { status: 502, headers: { 'content-type': 'Text/Plain; charset=utf-8' } })));
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.message).toBe('It said: Bad Gateway');
    } finally {
      restore();
    }
  });

  it('flattens control characters so a plain-text body cannot forge a log line', async () => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse('first\r\n[hosts] forged line\u0007', { status: 502, headers: { 'content-type': 'text/plain' } })));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      if (!result.healthy) expect(result.message).toBe('It said: first [hosts] forged line');
      const logged = String(errorSpy.mock.calls[0]?.[0]);
      expect(logged).not.toMatch(/\p{Cc}/u);
      expect(logged).toContain('HTTP 502');
    } finally {
      errorSpy.mockRestore();
      restore();
    }
  });

  it('stops reading a refusal body once it is past the read bound and cancels the stream', async () => {
    let cancelled = false;
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1024;
        controller.enqueue(new TextEncoder().encode('y'.repeat(1024)));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { restore } = withFetch(() => Promise.resolve(agentResponse(stream, { status: 502, headers: { 'content-type': 'text/plain' } })));
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(cancelled).toBe(true);
      expect(sent).toBe(1024 * (8192 / 1024 + 1));
      expect(result.healthy).toBe(false);
      expect('message' in result ? result.message.length : Infinity).toBeLessThan(500);
    } finally {
      restore();
    }
  });

  it('keeps the code of a refusal just under the read bound, delivered in small chunks', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify({ error: 'e'.repeat(7500), code: 'update_in_progress' }));
    const pieces: Uint8Array[] = [];
    for (let at = 0; at < encoded.byteLength; at += 1024) pieces.push(encoded.slice(at, at + 1024));
    const { restore } = withFetch(() => Promise.resolve(agentResponse(chunkedStream(pieces), { status: 409 })));
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(result).toEqual({ hostId: 1, healthy: false, code: 'update_in_progress', message: `${'e'.repeat(300)}...` });
    } finally {
      restore();
    }
  });

  it('loses the code of an 8200 byte refusal delivered as 8192 and 8 bytes', async () => {
    const prefix = '{"error":"';
    const suffix = '","code":"update_in_progress"}';
    const encoded = new TextEncoder().encode(`${prefix}${'e'.repeat(8200 - prefix.length - suffix.length)}${suffix}`);
    expect(encoded.byteLength).toBe(8200);
    const { restore } = withFetch(() =>
      Promise.resolve(agentResponse(chunkedStream([encoded.slice(0, 8192), encoded.slice(8192)]), { status: 409 })),
    );
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(result).toEqual({ hostId: 1, healthy: false, code: 'agent_reported_error', message: '' });
    } finally {
      restore();
    }
  });

  it('keeps a multi-byte character that is split across two chunks of a plain-text refusal', async () => {
    const encoded = new TextEncoder().encode('caf\u00e9 is down');
    const { restore } = withFetch(() =>
      Promise.resolve(agentResponse(chunkedStream([encoded.slice(0, 4), encoded.slice(4)]), { status: 502, headers: { 'content-type': 'text/plain' } })),
    );
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect('message' in result ? result.message : '').toBe('It said: caf\u00e9 is down');
    } finally {
      restore();
    }
  });

  it('caps an agent message that runs long', async () => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse(JSON.stringify({ error: 'x'.repeat(5000) }), { status: 500 })));
    try {
      const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.message).toBe(`${'x'.repeat(300)}...`);
    } finally {
      restore();
    }
  });

  it('shows update_in_progress on the retry after an update that ended interrupted', async () => {
    const timers = mockSetTimeout({ fireImmediately: true });
    let calls = 0;
    const { restore } = withFetch(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? agentResponse(JSON.stringify({ started: true }), { status: 202 })
          : agentResponse(JSON.stringify({ error: 'An update is already in progress', code: 'update_in_progress' }), { status: 409 }),
      );
    });
    try {
      const staleDigest = 'sha256:' + 'a'.repeat(64);
      const deps = updateDeps(undefined, mock(() =>
        Promise.resolve({ healthy: true as const, version: '1.0.0', agentImageDigest: staleDigest }),
      ));
      const first = await handleUpdateAgent(deps, { hostId: 1 });
      const second = await handleUpdateAgent(deps, { hostId: 1 });
      expect(first).toMatchObject({ healthy: false, code: 'update_interrupted' });
      expect(second).toMatchObject({ healthy: false, code: 'update_in_progress' });
    } finally {
      timers.restore();
      restore();
    }
  });

  it('surfaces a plain-text check-failure body from the agent as the message of the generic refusal', async () => {
    const { restore } = withFetch(() => Promise.resolve(agentResponse('Update check failed. Verify the agent host can reach the image registry, then retry the update.', { status: 503 })));
    try {
      const deps = updateDeps();
      const result = await handleUpdateAgent(deps, { hostId: 1 });
      expect(result.healthy).toBe(false);
      if (!result.healthy) expect(result.code).toBe('agent_reported_error');
      if (!result.healthy) expect(result.message).toBe('It said: Update check failed. Verify the agent host can reach the image registry, then retry the update.');
      if (!result.healthy) expect(hostFailureMessage(result.code as HostFailureCode, result.message)).toBe('The agent refused the update. Correct the cause on the agent host, then retry the update. It said: Update check failed. Verify the agent host can reach the image registry, then retry the update.');
    } finally {
      restore();
    }
  });

  describe('an answer that does not carry the agent identity header', () => {
    const NOT_ANSWERING_MESSAGE = (status: number) =>
      `Something other than the agent answered (HTTP ${status}). Check that the agent URL points at the agent and that any proxy in front of it is running, then try again.`;

    it('reports a proxy 502 page as something other than the agent, with the status and the pinned copy', async () => {
      const page = '<html><head><title>502 Bad Gateway</title></head><body>nginx</body></html>';
      const { restore } = withFetch(() => Promise.resolve(new Response(page, { status: 502, headers: { 'content-type': 'text/html' } })));
      try {
        const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
        expect(result).toEqual({ hostId: 1, healthy: false, code: 'agent_not_answering', message: 'HTTP 502' });
        if (!result.healthy) expect(updateFailureMessage(result.code, result.message)).toBe(NOT_ANSWERING_MESSAGE(502));
      } finally {
        restore();
      }
    });

    it.each([
      ['a JSON error envelope with an update code', JSON.stringify({ error: 'An update is already in progress', code: 'update_in_progress' }), 409],
      ['a JSON error envelope the agent would send', JSON.stringify({ error: 'Internal server error', code: 'internal_error' }), 500],
      ['a plain-text body', 'Update check failed.', 503],
      ['an empty body', '', 504],
    ])('does not read %s as the agent, whatever its body', async (_label, body, status) => {
      const { restore } = withFetch(() => Promise.resolve(new Response(body, { status })));
      try {
        const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
        expect(result).toEqual({ hostId: 1, healthy: false, code: 'agent_not_answering', message: `HTTP ${status}` });
      } finally {
        restore();
      }
    });

    it('logs a flattened, bounded excerpt of what answered and never puts it in the message', async () => {
      const body = `first\r\n[hosts] forged line\u0007${'z'.repeat(1000)}`;
      const { restore } = withFetch(() => Promise.resolve(new Response(body, { status: 502 })));
      const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
        if (!result.healthy) expect(result.message).toBe('HTTP 502');
        const logged = String(errorSpy.mock.calls[0]?.[0]);
        expect(logged).not.toMatch(/\p{Cc}/u);
        expect(logged).toContain('HTTP 502: first [hosts] forged line');
        expect(logged.length).toBeLessThan(500);
      } finally {
        errorSpy.mockRestore();
        restore();
      }
    });

    it('does not retry the request or poll health after it', async () => {
      const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response('Bad Gateway', { status: 502 })));
      const checkHealth = mock(() => Promise.resolve({ healthy: true as const, version: '1.0.0' }));
      try {
        await handleUpdateAgent(updateDeps(undefined, checkHealth), { hostId: 1 });
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(checkHealth).toHaveBeenCalledTimes(1);
      } finally {
        restore();
      }
    });

    it('stops waiting on a body the proxy holds open after the 502 and still reports it as not the agent', async () => {
      const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
      const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        if (ms !== NOT_ANSWERING_BODY_TIMEOUT_MS) return originalTimeout(ms);
        const bound = new AbortController();
        queueMicrotask(() => bound.abort());
        return bound.signal;
      });
      const held = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('<html>'));
        },
      });
      const { restore } = withFetch(() => Promise.resolve(new Response(held, { status: 502 })));
      const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });

        expect(result).toEqual({ hostId: 1, healthy: false, code: 'agent_not_answering', message: 'HTTP 502' });
        expect(errorSpy.mock.calls.map((call) => String(call[0])).some((line) => line.includes('HTTP 502 (body read timed out): <html>'))).toBe(true);
      } finally {
        errorSpy.mockRestore();
        timeoutSpy.mockRestore();
        restore();
      }
    });

    it('gives the trigger request a deadline and reports an agent that never answers as unreachable', async () => {
      const deadlines: number[] = [];
      const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        deadlines.push(ms);
        return AbortSignal.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      });
      const original = globalThis.fetch;
      globalThis.fetch = ((_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const fail = () => reject(new Error('The operation timed out.'));
          if (init.signal?.aborted) fail();
          else init.signal?.addEventListener('abort', fail);
        })) as unknown as typeof fetch;
      try {
        const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });

        expect(deadlines).toEqual([30_000]);
        expect(result).toEqual({ hostId: 1, healthy: false, code: 'agent_unreachable', message: 'The operation timed out.' });
      } finally {
        globalThis.fetch = original;
        timeoutSpy.mockRestore();
      }
    });

    it.each(['X-Homelab-Agent', 'x-homelab-agent', 'X-HOMELAB-AGENT'])('trusts the header written as %s', async (name) => {
      const { restore } = withFetch(() => Promise.resolve(new Response('Bad Gateway', { status: 502, headers: { [name]: '0.4.0' } })));
      try {
        const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
        expect(result).toMatchObject({ healthy: false, code: 'agent_reported_error' });
      } finally {
        restore();
      }
    });

    it('checks only that the header is there, so an oversized or hostile value is never read or logged', async () => {
      const hostile = `${'v'.repeat(4000)} <script>`;
      const { restore } = withFetch(() => Promise.resolve(new Response('Bad Gateway', { status: 502, headers: { 'X-Homelab-Agent': hostile } })));
      const errorSpy = spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
        expect(result).toMatchObject({ healthy: false, code: 'agent_reported_error' });
        expect(errorSpy.mock.calls.flat().join(' ')).not.toContain('<script>');
      } finally {
        errorSpy.mockRestore();
        restore();
      }
    });

    it('trusts the header even when the body is an HTML page, which is an agent bug and not a proxy', async () => {
      const { restore } = withFetch(() => Promise.resolve(agentResponse('<html>oops</html>', { status: 500, headers: { 'content-type': 'text/html' } })));
      try {
        const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
        expect(result).toEqual({ hostId: 1, healthy: false, code: 'agent_reported_error', message: '' });
      } finally {
        restore();
      }
    });

    it('leaves a redirect to the redirect failure', async () => {
      const { restore } = withFetch(() => Promise.resolve(new Response(null, { status: 302, headers: { location: 'http://elsewhere/' } })));
      try {
        const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
        expect(result).toMatchObject({ healthy: false, code: 'unexpected_redirect' });
      } finally {
        restore();
      }
    });

    it('leaves a network failure as unreachable, since nothing answered', async () => {
      const { restore } = withFetch(() => Promise.reject(new TypeError('connect ECONNREFUSED')));
      try {
        const result = await handleUpdateAgent(updateDeps(), { hostId: 1 });
        expect(result).toMatchObject({ healthy: false, code: 'agent_unreachable', message: 'connect ECONNREFUSED' });
      } finally {
        restore();
      }
    });
  });

});

