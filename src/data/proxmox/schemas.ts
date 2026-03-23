import { z } from 'zod';

export const getHistoricalProxmoxStatsSchema = z.object({
  seconds: z.number().int().positive().optional().default(120),
});
