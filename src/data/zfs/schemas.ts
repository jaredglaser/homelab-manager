import { z } from 'zod';

export const getHistoricalZFSStatsSchema = z.object({
  /** Number of seconds of historical data to fetch. Default: 60 */
  seconds: z.number().int().positive().optional().default(60),
});
