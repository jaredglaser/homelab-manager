import { describe, it, expect, mock } from 'bun:test';
import type { HostRepo, AgentsInventoryDeps } from '../handlers';
import { handleSweepAgentInventory, handleListAgentsInventorySnapshot } from '../handlers';
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

describe('handleSweepAgentInventory', () => {
  it('probes every host exactly once per sweep and persists healthy/unhealthy plus agent info', async () => {
    const updateStatus = mock((_id: number, _status: HostStatus) => Promise.resolve());
    const updateAgentInfo = mock((_id: number, _fields: UpdateAgentInfoInput) => Promise.resolve());
    const hosts = [
      mockRow({ id: 1, name: 'up' }),
      mockRow({ id: 2, name: 'down' }),
    ];
    const d = deps(hosts, [healthy('0.2.0'), offline()], { updateStatus, updateAgentInfo });

    const entries = await handleSweepAgentInventory(d, NOW);

    expect(d.checkHealth).toHaveBeenCalledTimes(2);
    expect(updateStatus.mock.calls).toEqual([[1, 'healthy'], [2, 'unhealthy']]);
    expect(updateAgentInfo.mock.calls.length).toBe(1);
    expect(updateAgentInfo.mock.calls[0]?.[0]).toBe(1);
    expect(entries.map((e) => e.status)).toEqual(['online', 'offline']);
  });

  it('marks a pending host unknown on failure and leaves its status pending', async () => {
    const updateStatus = mock(() => Promise.resolve());
    const d = deps([mockRow({ status: 'pending' })], [offline()], { updateStatus });

    const [entry] = await handleSweepAgentInventory(d, NOW);

    expect(entry.status).toBe('unknown');
    expect(updateStatus).not.toHaveBeenCalled();
  });

  it('one host persist failure does not affect other hosts or crash the sweep', async () => {
    const hosts = [
      mockRow({ id: 1, name: 'broken' }),
      mockRow({ id: 2, name: 'fine' }),
    ];
    const updateStatus = mock((id: number, _status: HostStatus) => {
      if (id === 1) return Promise.reject(new Error('write failed'));
      return Promise.resolve();
    });
    const d = deps(hosts, [healthy('0.2.0'), healthy('0.3.0')], { updateStatus });

    const entries = await handleSweepAgentInventory(d, NOW);

    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe('online');
    expect(entries[1].status).toBe('online');
    expect(entries[1].version).toBe('0.3.0');
  });

  it('probes every host even when one probe throws', async () => {
    const hosts = [mockRow({ id: 1, name: 'a' }), mockRow({ id: 2, name: 'b' })];
    const repo = mockRepo(hosts);
    const checkHealth = mock((_url: string, hostName: string) => {
      if (hostName === 'a') return Promise.reject(new Error('boom'));
      return Promise.resolve(healthy('0.2.0'));
    }) as unknown as (url: string, hostName: string) => Promise<HealthCheckOutcome>;
    const d = { repo, checkHealth };

    const entries = await handleSweepAgentInventory(d, NOW);

    expect(checkHealth).toHaveBeenCalledTimes(2);
    expect(entries).toHaveLength(2);
    expect(entries[0].status).toBe('offline');
    expect(entries[0].lastError).toBe('boom');
    expect(entries[1].status).toBe('online');
  });

  it('returns an empty list when no hosts are registered', async () => {
    const d = deps([], []);

    const entries = await handleSweepAgentInventory(d, NOW);

    expect(entries).toEqual([]);
    expect(d.checkHealth).not.toHaveBeenCalled();
  });
});

describe('handleListAgentsInventorySnapshot', () => {
  it('derives entries from stored rows with zero probes', async () => {
    const hosts = [
      mockRow({ id: 1, name: 'up', status: 'healthy', agentVersion: '0.2.0', updatedAt: new Date('2026-02-28T10:00:00Z') }),
      mockRow({ id: 2, name: 'down', status: 'unhealthy' }),
      mockRow({ id: 3, name: 'new', status: 'pending', agentVersion: null }),
    ];
    const repo = mockRepo(hosts);

    const entries = await handleListAgentsInventorySnapshot({ repo });

    expect(entries.map((e) => e.status)).toEqual(['online', 'offline', 'unknown']);
    expect(entries[0].versionSource).toBe('stored');
    expect(entries[0].checkedAt).toBe('2026-02-28T10:00:00.000Z');
    expect(entries[2].version).toBeNull();
    expect(entries[2].versionSource).toBe('unknown');
  });

  it('maps an error status host to unreachable', async () => {
    const repo = mockRepo([mockRow({ status: 'error' })]);

    const [entry] = await handleListAgentsInventorySnapshot({ repo });

    expect(entry.status).toBe('unreachable');
  });
});
