import { describe, it, expect, mock } from 'bun:test';
import type { HostRepo, AgentsInventoryDeps } from '../handlers';
import { handleListAgentsInventory } from '../handlers';
import type { ManagedHost, HostStatus, UpdateAgentInfoInput } from '@/lib/database/repositories/host-repository';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';

const NOW = new Date('2026-03-01T00:00:00Z');

function mockRow(overrides?: Partial<ManagedHost>): ManagedHost {
  return {
    id: 1,
    name: 'test-host',
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
    agentVersion: '0.1.0',
    agentImage: null,
    agentImageTag: null,
    status: 'healthy',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ManagedHost;
}

function mockRepo(hosts: ManagedHost[], overrides?: Partial<HostRepo>): HostRepo {
  return {
    findById: mock(() => Promise.resolve(hosts[0] ?? null)),
    findAll: mock(() => Promise.resolve(hosts)),
    create: mock(() => Promise.resolve(hosts[0] ?? mockRow())),
    update: mock(() => Promise.resolve(hosts[0] ?? mockRow())),
    delete: mock(() => Promise.resolve()),
    updateStatus: mock(() => Promise.resolve()),
    updateAgentInfo: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as HostRepo;
}

function healthy(version?: string): HealthCheckOutcome {
  return { healthy: true, ...(version ? { version } : {}) };
}

function offline(error = 'Health check timed out after 5000ms'): HealthCheckOutcome {
  return { healthy: false, reason: 'offline', error };
}

function unreachable(error = 'Agent returned status 500'): HealthCheckOutcome {
  return { healthy: false, reason: 'unreachable', error };
}

function deps(
  hosts: ManagedHost[],
  outcomes: HealthCheckOutcome[],
  repoOverrides?: Partial<HostRepo>,
): AgentsInventoryDeps & { repo: HostRepo } {
  let call = 0;
  return {
    repo: mockRepo(hosts, repoOverrides),
    checkHealth: mock(() => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      return Promise.resolve(outcome);
    }),
  };
}

describe('handleListAgentsInventory', () => {
  it('returns every registered host, none missing, even when probes fail', async () => {
    const hosts = [
      mockRow({ id: 1, name: 'up' }),
      mockRow({ id: 2, name: 'down', status: 'unhealthy' }),
      mockRow({ id: 3, name: 'bad', status: 'error' }),
    ];
    const d = deps(hosts, [healthy('0.2.0'), offline(), unreachable()]);

    const entries = await handleListAgentsInventory(d, NOW);

    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.id)).toEqual([1, 2, 3]);
    expect(entries.map((e) => e.status)).toEqual(['online', 'offline', 'unreachable']);
  });

  it('reports online with live version and no error', async () => {
    const d = deps([mockRow()], [healthy('0.2.0')]);

    const [entry] = await handleListAgentsInventory(d, NOW);

    expect(entry.status).toBe('online');
    expect(entry.version).toBe('0.2.0');
    expect(entry.versionSource).toBe('live');
    expect(entry.lastError).toBeNull();
    expect(entry.checkedAt).toBe(NOW.toISOString());
  });

  it('falls back to the stored version when /info reports none', async () => {
    const d = deps([mockRow({ agentVersion: '0.1.0' })], [healthy()]);

    const [entry] = await handleListAgentsInventory(d, NOW);

    expect(entry.status).toBe('online');
    expect(entry.version).toBe('0.1.0');
    expect(entry.versionSource).toBe('stored');
  });

  it('keeps the stored version for an offline agent and sets lastError', async () => {
    const d = deps([mockRow({ agentVersion: '0.1.0' })], [offline('connection refused')]);

    const [entry] = await handleListAgentsInventory(d, NOW);

    expect(entry.status).toBe('offline');
    expect(entry.version).toBe('0.1.0');
    expect(entry.versionSource).toBe('stored');
    expect(entry.lastError).toBe('connection refused');
  });

  it('reports unknown version when nothing is stored and the agent predates /info', async () => {
    const d = deps([mockRow({ agentVersion: null })], [healthy()]);

    const [entry] = await handleListAgentsInventory(d, NOW);

    expect(entry.version).toBeNull();
    expect(entry.versionSource).toBe('unknown');
  });

  it('marks a pending host unknown on failure and leaves its status pending', async () => {
    const updateStatus = mock(() => Promise.resolve());
    const d = deps([mockRow({ status: 'pending' })], [offline()], { updateStatus });

    const [entry] = await handleListAgentsInventory(d, NOW);

    expect(entry.status).toBe('unknown');
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('persists healthy/unhealthy and agent info for non-pending hosts', async () => {
    const updateStatus = mock((_id: number, _status: HostStatus) => Promise.resolve());
    const updateAgentInfo = mock((_id: number, _fields: UpdateAgentInfoInput) => Promise.resolve());
    const hosts = [
      mockRow({ id: 1, name: 'up' }),
      mockRow({ id: 2, name: 'down' }),
    ];
    const d = deps(hosts, [healthy('0.2.0'), offline()], { updateStatus, updateAgentInfo });

    await handleListAgentsInventory(d, NOW);

    expect(updateStatus.mock.calls).toEqual([[1, 'healthy'], [2, 'unhealthy']]);
    expect(updateAgentInfo.mock.calls.length).toBe(1);
    expect(updateAgentInfo.mock.calls[0]?.[0]).toBe(1);
  });

  it('returns an empty list when no hosts are registered', async () => {
    const d = deps([], []);

    const entries = await handleListAgentsInventory(d, NOW);

    expect(entries).toEqual([]);
    expect(d.checkHealth).not.toHaveBeenCalled();
  });

  it('probes every host even when one probe throws', async () => {
    const hosts = [mockRow({ id: 1, name: 'a' }), mockRow({ id: 2, name: 'b' })];
    const repo = mockRepo(hosts);
    const checkHealth = mock((_url: string, hostName: string) => {
      if (hostName === 'a') return Promise.reject(new Error('boom'));
      return Promise.resolve(healthy('0.2.0'));
    }) as unknown as (url: string, hostName: string) => Promise<HealthCheckOutcome>;
    const d = { repo, checkHealth };

    const entries = await handleListAgentsInventory(d, NOW);

    expect(checkHealth).toHaveBeenCalledTimes(2);
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe('offline');
    expect(entries[0].lastError).toBe('boom');
    expect(entries[1].status).toBe('online');
  });
});