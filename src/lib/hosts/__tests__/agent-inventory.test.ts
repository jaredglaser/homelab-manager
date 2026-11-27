import { describe, it, expect } from 'bun:test';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import { HOST_PROBE_FAILURE_CODES } from '@/lib/errors/host-failure-copy';
import { buildStoredAgentInventoryEntry } from '@/lib/hosts/agent-inventory';

const NOW = new Date('2026-03-01T00:00:00Z');

function host(overrides: Partial<ManagedHost> = {}): ManagedHost {
  return {
    id: 1,
    name: 'homeserver',
    agentUrl: 'http://192.168.1.10:9090',
    capabilities: { docker: true },
    agentVersion: null,
    agentImage: null,
    agentImageTag: null,
    agentImageDigest: null,
    agentOutOfDate: false,
    failure: null,
    status: 'unhealthy',
    createdAt: NOW,
    updatedAt: NOW,
    lastSweptAt: NOW,
    agentUpdate: null,
    ...overrides,
  };
}

describe('inventory status for a failure', () => {
  it('carries the recorded cause and its detail onto the entry, for every code a probe can record', () => {
    for (const code of HOST_PROBE_FAILURE_CODES) {
      const entry = buildStoredAgentInventoryEntry(host({ failure: { code, detail: 'detail' } }));

      expect(entry.failure, code).toEqual({ code, message: 'detail' });
    }
  });

  it('maps each code to the status the card shows', () => {
    const statusOf = (code: (typeof HOST_PROBE_FAILURE_CODES)[number]) =>
      buildStoredAgentInventoryEntry(host({ failure: { code, detail: null } })).status;

    expect(statusOf('offline')).toBe('offline');
    expect(statusOf('health_check_failed')).toBe('offline');
    expect(statusOf('unreachable')).toBe('unreachable');
    expect(statusOf('agent-unhealthy')).toBe('unreachable');
    expect(statusOf('certificate-rejected')).toBe('unreachable');
    expect(statusOf('awaiting-enrollment')).toBe('awaiting-enrollment');
  });

  it('shows a pending host\'s cause, and leaves one with no cause unknown', () => {
    const stored = buildStoredAgentInventoryEntry(host({ status: 'pending', failure: { code: 'unreachable', detail: 'x' } }));
    const uncaused = buildStoredAgentInventoryEntry(host({ status: 'pending' }));

    expect(stored.status).toBe('unreachable');
    expect(uncaused.status).toBe('unknown');
  });
});

describe('agent update on the inventory entry', () => {
  it('sends the stored update with its time as an ISO string, and leaves the update badge to the sweep', () => {
    const at = new Date('2026-11-27T10:00:00.123Z');
    const running = buildStoredAgentInventoryEntry(host({ status: 'healthy', agentOutOfDate: true, agentUpdate: { state: 'running', at } }));
    expect(running.update).toEqual({ state: 'running', at: '2026-11-27T10:00:00.123Z' });
    expect(running.agentOutOfDate).toBe(true);

    const done = buildStoredAgentInventoryEntry(
      host({ agentUpdate: { state: 'done', at, result: { healthy: true, outcome: 'already_current' } } }),
    );
    expect(done.update).toEqual({ state: 'done', at: '2026-11-27T10:00:00.123Z', result: { healthy: true, outcome: 'already_current' } });
    expect(buildStoredAgentInventoryEntry(host()).update).toBeNull();
  });
});
