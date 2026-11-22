import { describe, it, expect } from 'bun:test';
import type { ManagedHost } from '@/lib/database/repositories/host-repository';
import { HOST_PROBE_FAILURE_CODES } from '@/lib/errors/host-failure-copy';
import { buildAgentInventoryEntry, buildStoredAgentInventoryEntry } from '@/lib/hosts/agent-inventory';

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
    ...overrides,
  };
}

describe('inventory status for a failure', () => {
  it('is the same from a live probe and from the stored row, for every code a probe can record', () => {
    for (const code of HOST_PROBE_FAILURE_CODES) {
      const live = buildAgentInventoryEntry(
        host({ status: 'healthy' }),
        { healthy: false, ...(code === 'health_check_failed' ? {} : { reason: code }), error: 'detail' },
        NOW,
      );
      const stored = buildStoredAgentInventoryEntry(host({ failure: { code, detail: 'detail' } }));

      expect(stored.status, code).toBe(live.status);
      expect(stored.failure, code).toEqual(live.failure);
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

  it('shows a pending host\'s cause on either path, and leaves one with no cause unknown', () => {
    const live = buildAgentInventoryEntry(host({ status: 'pending' }), { healthy: false, reason: 'unreachable', error: 'x' }, NOW);
    const stored = buildStoredAgentInventoryEntry(host({ status: 'pending', failure: { code: 'unreachable', detail: 'x' } }));
    const uncaused = buildStoredAgentInventoryEntry(host({ status: 'pending' }));

    expect(live.status).toBe('unreachable');
    expect(stored.status).toBe('unreachable');
    expect(uncaused.status).toBe('unknown');
  });
});
