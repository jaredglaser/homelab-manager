import type { ProxmoxStatsRow } from '@/types/proxmox';
import { generateProxmoxHistory } from '@/lib/mock/generators/proxmox';

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

/**
 * Mock: Test Proxmox connection — always succeeds in demo mode.
 */
export const testProxmoxConnection = async (): Promise<{
  connected: boolean;
  error?: string;
}> => {
  return { connected: true };
};
