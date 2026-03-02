import type { ZFSStatsRow } from '@/types/zfs';
import { generateZFSHistory } from '../generators/zfs';

/**
 * Mock: Get historical ZFS stats for preloading.
 * Matches the real `getHistoricalZFSStats` signature.
 */
export const getHistoricalZFSStats = async (opts?: {
  data?: { seconds?: number };
}): Promise<ZFSStatsRow[]> => {
  const seconds = opts?.data?.seconds ?? 60;
  return generateZFSHistory(seconds);
};
