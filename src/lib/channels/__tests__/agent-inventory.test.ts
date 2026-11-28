import { describe, it, expect } from 'bun:test';
import { zAgentInventorySnapshotWire } from '@/lib/channels/agent-inventory';
import { AGENT_INVENTORY_STATUSES } from '@/lib/hosts/agent-inventory';
import { HOST_PROBE_FAILURE_CODES } from '@/lib/errors/host-failure-copy';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    entries: [
      {
        id: 1,
        name: 'homeserver',
        agentUrl: 'http://192.168.1.10:9090',
        capabilities: { docker: true },
        status: 'online',
        version: '0.2.0',
        agentImage: null,
        agentImageTag: null,
        agentImageDigest: null,
        agentOutOfDate: false,
        failure: null,
        update: null,
        checkedAt: '2026-03-01T00:00:00.000Z',
        ...overrides,
      },
    ],
    sweptAt: null,
  };
}

describe('agent inventory wire schema', () => {
  it('carries a running, finished and interrupted update, and rejects one this build cannot show', () => {
    const at = '2026-11-27T10:00:00.000Z';
    const accepted = [
      { state: 'running', at },
      { state: 'interrupted', at },
      { state: 'done', at, result: { healthy: true, outcome: 'updated', version: '2.0.0' } },
      { state: 'done', at, result: { healthy: true, outcome: 'already_current' } },
      { state: 'done', at, result: { healthy: false, code: 'update_in_progress', message: '' } },
      { state: 'done', at, result: { healthy: false, code: 'agent_did_not_restart', message: 'detail' } },
    ];
    for (const update of accepted) {
      expect(zAgentInventorySnapshotWire.safeParse(snapshot({ update })).success, JSON.stringify(update)).toBe(true);
    }
    const rejected = [
      { state: 'paused', at },
      { state: 'done', at },
      { state: 'done', at, result: { healthy: false, code: 'from_a_newer_build', message: '' } },
    ];
    for (const update of rejected) {
      expect(zAgentInventorySnapshotWire.safeParse(snapshot({ update })).success, JSON.stringify(update)).toBe(false);
    }
  });

  it('accepts every status the inventory can report', () => {
    for (const status of AGENT_INVENTORY_STATUSES) {
      const parsed = zAgentInventorySnapshotWire.safeParse(snapshot({ status }));
      expect(parsed.success, `status ${status}`).toBe(true);
    }
  });

  it('accepts every failure code a probe can record', () => {
    for (const code of HOST_PROBE_FAILURE_CODES) {
      const parsed = zAgentInventorySnapshotWire.safeParse(
        snapshot({ status: 'offline', failure: { code, message: 'detail' } }),
      );
      expect(parsed.success, `code ${code}`).toBe(true);
    }
  });

  it('accepts a failure with no detail and rejects a code outside the probe set', () => {
    expect(
      zAgentInventorySnapshotWire.safeParse(
        snapshot({ status: 'offline', failure: { code: 'offline', message: '' } }),
      ).success,
    ).toBe(true);

    expect(
      zAgentInventorySnapshotWire.safeParse(
        snapshot({ status: 'offline', failure: { code: 'token_signing_failed', message: 'x' } }),
      ).success,
    ).toBe(false);
  });

  it('parses a frame from a manager that still sends versionSource and drops the key', () => {
    const parsed = zAgentInventorySnapshotWire.safeParse(snapshot({ versionSource: 'stored' }));

    expect(parsed.success).toBe(true);
    expect(parsed.data?.entries[0]).not.toHaveProperty('versionSource');
    expect(parsed.data?.entries[0].version).toBe('0.2.0');
  });
});
