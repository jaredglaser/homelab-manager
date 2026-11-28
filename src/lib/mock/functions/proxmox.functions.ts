import type { ProxmoxConnectionSummary, ProxmoxStatsRow } from '@/types/proxmox';
import type { SaveProxmoxConnectionResult, TestProxmoxConnectionResult } from '@/data/proxmox/connection-handlers';
import type { SaveProxmoxConnectionInput, TestProxmoxConnectionInput } from '@/data/proxmox/schemas';
import { generateProxmoxHistory } from '@/lib/mock/generators/proxmox';
import { PROXMOX_HOST } from '@/lib/mock/entities';

const MAX_HISTORY_SECONDS = 3600;

/**
 * Mock: Get historical Proxmox stats for preloading.
 * Matches the real `getHistoricalProxmoxStats` signature.
 */
export const getHistoricalProxmoxStats = async (opts?: {
  data?: { seconds?: number };
}): Promise<ProxmoxStatsRow[]> => {
  const seconds = Math.min(opts?.data?.seconds ?? 120, MAX_HISTORY_SECONDS);
  return generateProxmoxHistory(seconds);
};

const mockConnections: readonly ProxmoxConnectionSummary[] = [
  { id: 1, name: 'homelab', address: PROXMOX_HOST, port: 8006, tokenId: 'root@pam!homelab-manager', allowSelfSignedCerts: true },
];

export async function listProxmoxConnections(): Promise<ProxmoxConnectionSummary[]> {
  return [...mockConnections];
}

/** Stateless like the host mocks: the demo keeps its one cluster. */
export async function saveProxmoxConnection(data: SaveProxmoxConnectionInput): Promise<SaveProxmoxConnectionResult> {
  return {
    ok: true,
    connection: {
      id: data.id ?? mockConnections.length + 1,
      name: data.name || data.address,
      address: data.address,
      port: data.port,
      tokenId: data.tokenId,
      allowSelfSignedCerts: data.allowSelfSignedCerts,
    },
  };
}

export async function testProxmoxConnection(_data: TestProxmoxConnectionInput): Promise<TestProxmoxConnectionResult> {
  return { ok: true, clusterName: 'homelab', release: '9.0', nodeCount: 2 };
}

export async function removeProxmoxConnection(data: { id: number }): Promise<{ removed: boolean }> {
  return { removed: mockConnections.some((c) => c.id === data.id) };
}
