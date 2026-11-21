import { describe, it, expect, mock } from 'bun:test';
import type { HostRepo, AgentsInventoryDeps } from '../handlers';
import { handleSweepAgentInventory, handleListAgentsInventorySnapshot } from '../handlers';
import type { ManagedHost, HostHealthVerdict, UpdateAgentInfoInput } from '@/lib/database/repositories/host-repository';
import type { HealthCheckOutcome } from '@/lib/hosts/host-utils';
import { buildAgentInventorySnapshot } from '@/lib/hosts/agent-inventory';

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
    agentImageDigest: null,
    agentOutOfDate: false,
    failure: null,
    status: 'healthy',
    createdAt: NOW,
    updatedAt: NOW,
    lastSweptAt: null,
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
    updateHealth: mock(() => Promise.resolve()),
    updateLastSweptAt: mock(() => Promise.resolve()),
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
  resolveAgentImageDigest?: (imageRef: string) => Promise<string | null>,
): AgentsInventoryDeps & { repo: HostRepo } {
  let call = 0;
  return {
    repo: mockRepo(hosts, repoOverrides),
    checkHealth: mock(() => {
      const outcome = outcomes[Math.min(call, outcomes.length - 1)];
      call += 1;
      return Promise.resolve(outcome);
    }),
    ...(resolveAgentImageDigest ? { resolveAgentImageDigest } : {}),
  };
}

describe('handleSweepAgentInventory', () => {
  it('probes every host exactly once per sweep and persists healthy/unhealthy plus agent info', async () => {
    const updateHealth = mock<(id: number, verdict: HostHealthVerdict, probedUrl: string) => Promise<void>>(() => Promise.resolve());
    const updateAgentInfo = mock((_id: number, _fields: UpdateAgentInfoInput) => Promise.resolve());
    const hosts = [
      mockRow({ id: 1, name: 'up' }),
      mockRow({ id: 2, name: 'down' }),
    ];
    const d = deps(hosts, [healthy('0.2.0'), offline()], { updateHealth, updateAgentInfo });

    const entries = await handleSweepAgentInventory(d, NOW);

    expect(d.checkHealth).toHaveBeenCalledTimes(2);
    expect(updateHealth.mock.calls).toEqual([
      [1, { status: 'healthy', failure: null }, 'http://192.168.1.10:9090'],
      [2, { status: 'unhealthy', failure: { code: 'offline', detail: 'Health check timed out after 5000ms' } }, 'http://192.168.1.10:9090'],
    ]);
    expect(updateAgentInfo.mock.calls.length).toBe(1);
    expect(updateAgentInfo.mock.calls[0]?.[0]).toBe(1);
    expect(entries.map((e) => e.status)).toEqual(['online', 'offline']);
  });

  it('persists the probe reason, not just the unhealthy status', async () => {
    const updateHealth = mock<(id: number, verdict: HostHealthVerdict, probedUrl: string) => Promise<void>>(() => Promise.resolve());
    const hosts = [mockRow({ id: 1, name: 'behind-proxy', status: 'healthy' })];
    const d = deps(
      hosts,
      [{ healthy: false, reason: 'unreachable', error: 'Agent returned status 502' }],
      { updateHealth },
    );

    await handleSweepAgentInventory(d, NOW);

    expect(updateHealth.mock.calls).toEqual([
      [1, { status: 'unhealthy', failure: { code: 'unreachable', detail: 'Agent returned status 502' } }, 'http://192.168.1.10:9090'],
    ]);
  });

  it('persists the fallback code when the probe failed without naming a reason', async () => {
    const updateHealth = mock<(id: number, verdict: HostHealthVerdict, probedUrl: string) => Promise<void>>(() => Promise.resolve());
    const d = deps([mockRow({ status: 'healthy' })], [{ healthy: false, error: 'boom' }], { updateHealth });

    await handleSweepAgentInventory(d, NOW);

    expect(updateHealth.mock.calls).toEqual([
      [1, { status: 'unhealthy', failure: { code: 'health_check_failed', detail: 'boom' } }, 'http://192.168.1.10:9090'],
    ]);
  });

  it('records an agent that reports itself unhealthy as unreachable with that cause', async () => {
    const updateHealth = mock<(id: number, verdict: HostHealthVerdict, probedUrl: string) => Promise<void>>(() => Promise.resolve());
    const d = deps(
      [mockRow({ status: 'healthy' })],
      [{ healthy: false, reason: 'agent-unhealthy', error: 'Agent reported itself unhealthy' }],
      { updateHealth },
    );

    const [entry] = await handleSweepAgentInventory(d, NOW);

    expect(updateHealth.mock.calls[0]?.[1]).toEqual({
      status: 'unhealthy',
      failure: { code: 'agent-unhealthy', detail: 'Agent reported itself unhealthy' },
    });
    expect(entry.status).toBe('unreachable');
  });

  it('records why a pending host failed its probe and leaves its status pending', async () => {
    const updateHealth = mock<(id: number, verdict: HostHealthVerdict, probedUrl: string) => Promise<void>>(() => Promise.resolve());
    const d = deps(
      [mockRow({ status: 'pending' })],
      [{ healthy: false, reason: 'awaiting-enrollment', error: 'plain HTTP' }],
      { updateHealth },
    );

    const [entry] = await handleSweepAgentInventory(d, NOW);

    expect(updateHealth.mock.calls).toEqual([
      [1, { status: 'pending', failure: { code: 'awaiting-enrollment', detail: 'plain HTTP' } }, 'http://192.168.1.10:9090'],
    ]);
    expect(entry.status).toBe('awaiting-enrollment');
  });

  it('clears the cause and verifies a pending host whose probe succeeds', async () => {
    const updateHealth = mock<(id: number, verdict: HostHealthVerdict, probedUrl: string) => Promise<void>>(() => Promise.resolve());
    const d = deps(
      [mockRow({ status: 'pending', failure: { code: 'offline', detail: 'refused' } })],
      [healthy('0.2.0')],
      { updateHealth },
    );

    await handleSweepAgentInventory(d, NOW);

    expect(updateHealth.mock.calls).toEqual([[1, { status: 'healthy', failure: null }, 'http://192.168.1.10:9090']]);
  });

  it('one host persist failure does not affect other hosts or crash the sweep', async () => {
    const hosts = [
      mockRow({ id: 1, name: 'broken' }),
      mockRow({ id: 2, name: 'fine' }),
    ];
    const updateHealth = mock((id: number, _verdict: HostHealthVerdict) => {
      if (id === 1) return Promise.reject(new Error('write failed'));
      return Promise.resolve();
    });
    const d = deps(hosts, [healthy('0.2.0'), healthy('0.3.0')], { updateHealth });

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
    expect(entries[0].failure).toEqual({ code: 'offline', message: 'boom' });
    expect(entries[1].status).toBe('online');
  });

  it('stamps lastSweptAt for every probed host, including a pending one it leaves alone', async () => {
    const updateLastSweptAt = mock((_id: number, _at: Date) => Promise.resolve());
    const hosts = [
      mockRow({ id: 1, name: 'up', status: 'healthy' }),
      mockRow({ id: 2, name: 'enrolling', status: 'pending' }),
    ];
    const d = deps(hosts, [healthy('0.2.0'), offline()], { updateLastSweptAt });

    await handleSweepAgentInventory(d, NOW);

    expect(updateLastSweptAt.mock.calls).toEqual([[1, NOW], [2, NOW]]);
  });

  it('returns an empty list when no hosts are registered', async () => {
    const d = deps([], []);

    const entries = await handleSweepAgentInventory(d, NOW);

    expect(entries).toEqual([]);
    expect(d.checkHealth).not.toHaveBeenCalled();
  });

  it('flags a host whose running digest differs from the manager agent digest and persists the verdict', async () => {
    const updateAgentInfo = mock((_id: number, _fields: UpdateAgentInfoInput) => Promise.resolve());
    const staleDigest = 'sha256:' + 'c'.repeat(64);
    const expectedDigest = 'sha256:' + 'd'.repeat(64);
    const hosts = [
      mockRow({ id: 1, name: 'stale' }),
      mockRow({ id: 2, name: 'current' }),
    ];
    const d = deps(
      hosts,
      [
        { healthy: true, infoSupported: true, agentImageDigest: staleDigest },
        { healthy: true, infoSupported: true, agentImageDigest: expectedDigest },
      ],
      { updateAgentInfo },
      mock(async (_imageRef: string) => expectedDigest),
    );

    const entries = await handleSweepAgentInventory(d, NOW);

    expect(entries[0].agentOutOfDate).toBe(true);
    expect(entries[0].agentImageDigest).toBe(staleDigest);
    expect(entries[1].agentOutOfDate).toBe(false);
    expect(updateAgentInfo.mock.calls[0]?.[1]).toMatchObject({
      imageDigest: staleDigest,
      outOfDate: true,
    });
    expect(updateAgentInfo.mock.calls[1]?.[1]).toMatchObject({ outOfDate: false });
  });

  it('reports no digest instead of the stored one when the live probe could not read it', async () => {
    const storedDigest = 'sha256:' + 'c'.repeat(64);
    const hosts = [mockRow({ id: 1, name: 'a', agentImageDigest: storedDigest })];
    const d = deps(
      hosts,
      [{ healthy: true, infoSupported: true }],
      undefined,
      mock(async (_imageRef: string) => 'sha256:' + 'd'.repeat(64)),
    );

    const [entry] = await handleSweepAgentInventory(d, NOW);

    expect(entry.agentImageDigest).toBeNull();
    expect(entry.agentOutOfDate).toBe(false);
  });

  it('leaves every host unflagged when the manager agent digest is unresolvable', async () => {
    const hosts = [mockRow({ id: 1, name: 'a' })];
    const d = deps(
      hosts,
      [{ healthy: true, infoSupported: true, agentImageDigest: 'sha256:' + 'c'.repeat(64) }],
      undefined,
      mock(async (_imageRef: string) => null),
    );

    const [entry] = await handleSweepAgentInventory(d, NOW);

    expect(entry.agentOutOfDate).toBe(false);
  });

  it('carries the stored out-of-date verdict for a host whose probe fails', async () => {
    const hosts = [mockRow({ id: 1, name: 'down', agentImageDigest: 'sha256:' + 'c'.repeat(64), agentOutOfDate: true })];
    const d = deps(hosts, [offline()], undefined, mock(async (_imageRef: string) => 'sha256:' + 'd'.repeat(64)));

    const [entry] = await handleSweepAgentInventory(d, NOW);

    expect(entry.status).toBe('offline');
    expect(entry.agentOutOfDate).toBe(true);
    expect(entry.agentImageDigest).toBe('sha256:' + 'c'.repeat(64));
  });
});

describe('handleListAgentsInventorySnapshot', () => {
  it('derives entries from stored rows with zero probes', async () => {
    const hosts = [
      mockRow({ id: 1, name: 'up', status: 'healthy', agentVersion: '0.2.0', lastSweptAt: new Date('2026-02-28T10:00:00Z') }),
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

  it('reports the recorded cause, so an agent awaiting enrollment is not reported as generically down', async () => {
    const detail = 'The agent is serving plain HTTP awaiting TLS enrollment';
    const repo = mockRepo([
      mockRow({ status: 'unhealthy', failure: { code: 'awaiting-enrollment', detail } }),
    ]);

    const [entry] = await handleListAgentsInventorySnapshot({ repo });

    expect(entry.status).toBe('awaiting-enrollment');
    expect(entry.failure).toEqual({ code: 'awaiting-enrollment', message: detail });
  });

  it('reports an unreachable cause, and an empty message for a row that recorded none', async () => {
    const repo = mockRepo([
      mockRow({ status: 'unhealthy', failure: { code: 'unreachable', detail: null } }),
    ]);

    const [entry] = await handleListAgentsInventorySnapshot({ repo });

    expect(entry.status).toBe('unreachable');
    expect(entry.failure).toEqual({ code: 'unreachable', message: '' });
  });

  it('shows the recorded cause of a pending host, so a freshly added plain-HTTP agent says why', async () => {
    const repo = mockRepo([
      mockRow({ status: 'pending', failure: { code: 'awaiting-enrollment', detail: 'plain HTTP' } }),
    ]);

    const [entry] = await handleListAgentsInventorySnapshot({ repo });

    expect(entry.status).toBe('awaiting-enrollment');
    expect(entry.failure).toEqual({ code: 'awaiting-enrollment', message: 'plain HTTP' });
  });

  it('keeps a pending host with no recorded cause unknown', async () => {
    const repo = mockRepo([mockRow({ status: 'pending' })]);

    const [entry] = await handleListAgentsInventorySnapshot({ repo });

    expect(entry.status).toBe('unknown');
    expect(entry.failure).toBeNull();
  });

  it('reports a row with a fallback cause as offline and keeps the cause', async () => {
    const repo = mockRepo([
      mockRow({ status: 'unhealthy', failure: { code: 'health_check_failed', detail: 'boom' } }),
    ]);

    const [entry] = await handleListAgentsInventorySnapshot({ repo });

    expect(entry.status).toBe('offline');
    expect(entry.failure).toEqual({ code: 'health_check_failed', message: 'boom' });
  });

  it('reports a legacy unhealthy row with no recorded cause as offline with no failure', async () => {
    const repo = mockRepo([mockRow({ status: 'unhealthy' })]);

    const [entry] = await handleListAgentsInventorySnapshot({ repo });

    expect(entry.status).toBe('offline');
    expect(entry.failure).toBeNull();
  });

  it('reports checkedAt from lastSweptAt, ignoring an updatedAt bumped by other writes', async () => {
    const hosts = [
      mockRow({
        status: 'healthy',
        lastSweptAt: new Date('2026-02-28T10:00:00Z'),
        // A rename, key rotation or single-host health check moves updatedAt
        // without an inventory sweep having run.
        updatedAt: new Date('2026-03-01T09:00:00Z'),
      }),
    ];
    const [entry] = await handleListAgentsInventorySnapshot({ repo: mockRepo(hosts) });

    expect(entry.checkedAt).toBe('2026-02-28T10:00:00.000Z');
  });

  it('falls back to updatedAt for a host that has never been swept', async () => {
    const hosts = [mockRow({ status: 'pending', lastSweptAt: null, updatedAt: new Date('2026-02-01T00:00:00Z') })];
    const [entry] = await handleListAgentsInventorySnapshot({ repo: mockRepo(hosts) });

    expect(entry.checkedAt).toBe('2026-02-01T00:00:00.000Z');
  });
});

describe('buildAgentInventorySnapshot', () => {
  it('derives sweptAt from the freshest lastSweptAt, not updatedAt', () => {
    const snapshot = buildAgentInventorySnapshot([
      mockRow({ id: 1, lastSweptAt: new Date('2026-02-28T10:00:00Z'), updatedAt: new Date('2026-03-01T00:00:00Z') }),
      mockRow({ id: 2, lastSweptAt: new Date('2026-02-28T11:00:00Z'), updatedAt: new Date('2026-02-20T00:00:00Z') }),
    ]);

    expect(snapshot.sweptAt).toBe('2026-02-28T11:00:00.000Z');
  });

  it('reports sweptAt null when no host has ever been swept', () => {
    const snapshot = buildAgentInventorySnapshot([
      mockRow({ lastSweptAt: null, updatedAt: new Date('2026-03-01T00:00:00Z') }),
    ]);

    expect(snapshot.sweptAt).toBeNull();
  });
});
