import { z } from 'zod';

export const getHistoricalProxmoxStatsSchema = z.object({
  seconds: z.number().optional().default(120),
});
