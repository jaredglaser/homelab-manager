import { z } from 'zod';

export const getStackDetailSchema = z.object({
  stackName: z.string().min(1),
});

export const triggerDeploySchema = z.object({
  stack: z.string().min(1),
  host: z.string().min(1),
  action: z.enum(['deploy', 'teardown', 'restart']),
});

export const getDeployHistorySchema = z.object({
  stackName: z.string().min(1),
  limit: z.number().min(1).max(100).optional().default(20),
});

export const saveComposeFileSchema = z.object({
  stackName: z.string().min(1),
  content: z.string(),
});

export const updateStackIconSchema = z.object({
  stackName: z.string().min(1),
  iconSlug: z.string().min(1),
});
