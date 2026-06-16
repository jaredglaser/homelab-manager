import { z } from 'zod';

const hostNameSchema = z.string().min(1).max(100).regex(
  /^[a-zA-Z0-9_-]+$/,
  'Must contain only letters, numbers, hyphens, and underscores',
);

const socketProxyUrlSchema = z.string().min(1).refine(
  (val) => /^(tcp|http|https):\/\/.+/.test(val),
  { error: 'Must be a valid URL with tcp://, http://, or https:// scheme' }
);

export const addHostSchema = z.object({
  name: hostNameSchema,
  socketProxyUrl: socketProxyUrlSchema,
  agentPort: z.number().int().min(1).max(65535).optional().default(9090),
});

export const registerExistingHostSchema = z.object({
  name: hostNameSchema,
  agentUrl: z.url(),
});

export const verifyHostSchema = z.object({
  name: hostNameSchema,
  agentUrl: z.url(),
  capabilities: z.object({
    docker: z.boolean().optional().default(false),
    zfs: z.boolean().optional().default(false),
  }).optional().default({ docker: false, zfs: false }),
});

export const removeHostSchema = z.object({ hostId: z.number().int().positive() });
export const updateAgentSchema = z.object({ hostId: z.number().int().positive() });
export const checkHostHealthSchema = z.object({ hostId: z.number().int().positive() });

export const updateHostSchema = z.object({
  hostId: z.number().int().positive(),
  name: hostNameSchema.optional(),
  agentUrl: z.string().url().optional(),
}).refine(
  (data) => data.name !== undefined || data.agentUrl !== undefined,
  { error: 'At least one of name or agentUrl must be provided' },
);
