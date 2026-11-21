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
        versionSource: 'live',
        agentImage: null,
        agentImageTag: null,
        agentImageDigest: null,
        agentOutOfDate: false,
        failure: null,
        checkedAt: '2026-03-01T00:00:00.000Z',
        ...overrides,
      },
    ],
    sweptAt: null,
  };
}

describe('agent inventory wire schema', () => {
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
});
