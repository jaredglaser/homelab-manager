import type { ZFSStatsRow } from '@/types/zfs';
import { generateZFSHistory } from '@/lib/mock/generators/zfs';

const MAX_HISTORY_SECONDS = 3600;

/**
 * Mock: Get historical ZFS stats for preloading.
 * Matches the real `getHistoricalZFSStats` signature.
 */
export const getHistoricalZFSStats = async (opts?: {
  data?: { seconds?: number };
}): Promise<ZFSStatsRow[]> => {
  const seconds = Math.min(opts?.data?.seconds ?? 60, MAX_HISTORY_SECONDS);
  return generateZFSHistory(seconds);
};
