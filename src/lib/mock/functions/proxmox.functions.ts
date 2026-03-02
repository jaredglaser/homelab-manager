import type { ProxmoxStatsRow } from '@/types/proxmox';
import { generateProxmoxHistory } from '../generators/proxmox';

/**
 * Mock: Get historical Proxmox stats for preloading.
 * Matches the real `getHistoricalProxmoxStats` signature.
 */
export const getHistoricalProxmoxStats = async (opts?: {
  data?: { seconds?: number };
}): Promise<ProxmoxStatsRow[]> => {
  const seconds = opts?.data?.seconds ?? 120;
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
