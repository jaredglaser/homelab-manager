import { z } from 'zod';

/** Allowed stack name pattern — alphanumeric, hyphens, underscores, dots. No slashes or path traversal. */
const stackNameField = z.string().min(1).regex(/^[a-zA-Z0-9._-]+$/, 'Stack name must be alphanumeric (hyphens, underscores, dots allowed)');

export const getStackDetailSchema = z.object({
  stackName: stackNameField,
});

export const triggerDeploySchema = z.object({
  stack: stackNameField,
  host: z.string().min(1),
  action: z.enum(['deploy', 'teardown', 'restart']),
});

export const getDeployHistorySchema = z.object({
  stackName: stackNameField,
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export const saveComposeFileSchema = z.object({
  stackName: stackNameField,
  content: z.string(),
});

export const updateStackIconSchema = z.object({
  stackName: stackNameField,
  iconSlug: z.string().min(1),
});
