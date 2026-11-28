import { z } from 'zod';

export const getHistoricalZFSStatsSchema = z.object({
  /** Number of seconds of historical data to fetch. Default: 60 */
  seconds: z.number().int().positive().optional().default(60),
});

const HOST_ADDRESS = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[?[0-9A-Fa-f:.]+\]?)$/;

export const createZfsNodeSchema = z.object({
  name: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/, 'Use only letters, numbers, hyphens and underscores.'),
  address: z.string().trim().min(1).max(253).regex(HOST_ADDRESS, 'Enter a host name or IP address.'),
  port: z.number().int().min(1).max(65535).default(22),
  allowedFrom: z
    .string()
    .trim()
    .max(255)
    .regex(/^[A-Za-z0-9.:/*?!,_-]*$/, 'Enter addresses separated by commas, with no spaces or quotes.')
    .optional()
    .transform((value) => (value ? value : null)),
});

export const zfsNodeIdSchema = z.object({
  id: z.number().int().positive(),
});

export const confirmZfsNodeHostKeySchema = z.object({
  id: z.number().int().positive(),
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
});
