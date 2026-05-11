import { z } from 'zod';

/** Allowed stack name pattern. No dots, slashes, or path traversal. */
const SAFE_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9_-]+$/;
const stackNameField = z.string().min(1).regex(SAFE_PATH_SEGMENT_PATTERN, 'Stack name must contain only letters, numbers, hyphens, and underscores');

export const getStackDetailSchema = z.object({
  stackName: stackNameField,
});

export const triggerDeploySchema = z.object({
  stack: stackNameField,
  host: z.string().min(1),
  action: z.enum(['deploy', 'teardown']),
  commitSha: z.string().optional(),
  forceRecreate: z.boolean().optional(),
});

export const getDeployHistorySchema = z.object({
  stackName: stackNameField,
  limit: z.number().int().min(1).max(100).optional().default(20),
});

export const saveComposeFileSchema = z.object({
  stackName: stackNameField,
  content: z.string().min(1, 'Compose file content cannot be empty'),
});

export const updateStackIconSchema = z.object({
  stackName: stackNameField,
  iconSlug: z.string().min(1),
});

export const resumeDeploySchema = z.object({
  deployId: z.number().int().positive(),
});

export const rejectDeploySchema = z.object({
  deployId: z.number().int().positive(),
});

export const controlStackSchema = z.discriminatedUnion('scope', [
  z.object({
    stack: stackNameField,
    host: z.string().min(1),
    action: z.enum(['start', 'stop', 'restart']),
    scope: z.literal('stack'),
  }),
  z.object({
    stack: stackNameField,
    host: z.string().min(1),
    action: z.enum(['start', 'stop', 'restart']),
    scope: z.literal('service'),
    service: z.string().min(1),
  }),
]);
