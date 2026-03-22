import { z } from 'zod';

export const getHistoricalDockerStatsSchema = z.object({
  /** Number of seconds of historical data to fetch. Default: 60 */
  seconds: z.number().min(1).max(3600).optional().default(60),
});

export const getContainerHistorySchema = z.object({
  containerId: z.string().min(1),
  host: z.string().optional(),
  fromMs: z.number(),
  toMs: z.number(),
  targetPoints: z.number().min(1).max(5000).optional(),
});

export const getContainerInfoSchema = z.object({
  containerId: z.string().min(1),
  host: z.string().optional(),
});

export const updateContainerIconSchema = z.object({
  /** Service-key entity path (host/service_key) - icon is stored here so it survives recreation. */
  serviceKeyEntity: z.string().min(1),
  iconSlug: z.string().min(1),
});
