import { z } from 'zod';

export const getHistoricalDockerStatsSchema = z.object({
  /** Number of seconds of historical data to fetch. Default: 60 */
  seconds: z.number().min(1).max(3600).optional().default(60),
});

export const getContainerHistorySchema = z.object({
  containerId: z.string().min(1),
  host: z.string().optional(),
  fromMs: z.number().int().nonnegative(),
  toMs: z.number().int().nonnegative(),
  targetPoints: z.number().min(1).max(5000).optional(),
}).refine((data) => data.fromMs <= data.toMs, {
  error: 'fromMs must be less than or equal to toMs',
  path: ['fromMs'],
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

export const clearContainerIconSchema = z.object({
  serviceKeyEntity: z.string().min(1),
});

export const controlContainerSchema = z.object({
  host: z.string().min(1),
  containerId: z.string().min(1),
  action: z.enum(['start', 'stop', 'restart']),
});
