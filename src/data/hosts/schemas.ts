import { z } from 'zod';

const hostNameSchema = z.string().min(1).max(100).regex(
  /^[a-zA-Z0-9_-]+$/,
  'Must contain only letters, numbers, hyphens, and underscores',
);

export const verifyHostSchema = z.object({
  name: hostNameSchema,
  agentUrl: z.url(),
  capabilities: z.object({
    docker: z.boolean().optional().default(false),
    zfs: z.boolean().optional().default(false),
  }).optional().default({ docker: false, zfs: false }),
});

export const removeHostSchema = z.object({ hostId: z.number().int().positive() });
export const checkHostHealthSchema = z.object({ hostId: z.number().int().positive() });

export const updateHostSchema = z.object({
  hostId: z.number().int().positive(),
  name: hostNameSchema.optional(),
  agentUrl: z.string().url().optional(),
}).refine(
  (data) => data.name !== undefined || data.agentUrl !== undefined,
  { error: 'At least one of name or agentUrl must be provided' },
);
