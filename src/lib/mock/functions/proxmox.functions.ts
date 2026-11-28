import type { ProxmoxConnectionSummary, ProxmoxStatsRow } from '@/types/proxmox';
import type { SaveProxmoxConnectionResult, TestProxmoxConnectionResult } from '@/data/proxmox/connection-handlers';
import type { SaveProxmoxConnectionInput } from '@/data/proxmox/schemas';
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

export function listProxmoxConnections(): Promise<ProxmoxConnectionSummary[]> {
  return Promise.resolve([...mockConnections]);
}

/** Stateless like the host mocks: the demo keeps its one cluster. */
export function saveProxmoxConnection(data: SaveProxmoxConnectionInput): Promise<SaveProxmoxConnectionResult> {
  return Promise.resolve({
    ok: true,
    connection: {
      id: data.id ?? mockConnections.length + 1,
      name: data.name || data.address,
      address: data.address,
      port: data.port,
      tokenId: data.tokenId,
      allowSelfSignedCerts: data.allowSelfSignedCerts,
    },
  });
}

export function testProxmoxConnection(): Promise<TestProxmoxConnectionResult> {
  return Promise.resolve({ ok: true, clusterName: 'homelab', release: '9.0', nodeCount: 2 });
}

export function removeProxmoxConnection(data: { id: number }): Promise<{ removed: boolean }> {
  return Promise.resolve({ removed: mockConnections.some((c) => c.id === data.id) });
}
