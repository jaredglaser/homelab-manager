import { z } from 'zod';

const socketProxyUrlSchema = z.string().min(1).refine(
  (val) => /^(tcp|http|https):\/\/.+/.test(val),
  { message: 'Must be a valid URL with tcp://, http://, or https:// scheme' }
);

export const addHostSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, 'Must contain only letters, numbers, hyphens, and underscores'),
  socketProxyUrl: socketProxyUrlSchema,
  agentPort: z.number().int().min(1).max(65535).optional().default(9090),
});

export const registerExistingHostSchema = z.object({
  name: z.string().min(1).max(100),
  agentUrl: z.string().url(),
  socketProxyUrl: socketProxyUrlSchema,
  agentToken: z.string().min(1),
});

export const removeHostSchema = z.object({ hostId: z.number().int().positive() });
export const updateAgentSchema = z.object({ hostId: z.number().int().positive() });
export const checkHostHealthSchema = z.object({ hostId: z.number().int().positive() });

export const updateHostSchema = z.object({
  hostId: z.number().int().positive(),
  name: z.string().min(1).max(100).optional(),
  agentUrl: z.string().url().optional(),
  socketProxyUrl: socketProxyUrlSchema.optional(),
});
