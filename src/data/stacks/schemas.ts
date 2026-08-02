import { z } from 'zod';
import { STACK_NAME_PATTERN } from '@/lib/constants/path-patterns';

const stackNameField = z.string().min(1).regex(STACK_NAME_PATTERN, 'Stack name must start with a letter or digit and contain only letters, digits, hyphens, and underscores');

/** Allowed service name pattern. Matches Docker Compose service name conventions: alphanumeric start, then alphanumeric/dots/hyphens/underscores. */
const serviceNameField = z.string().min(1).regex(
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
  'Service name must start with alphanumeric and contain only alphanumeric, dots, hyphens, and underscores',
);

export const getStackDetailSchema = z.object({
  stackName: stackNameField,
});

export const triggerDeploySchema = z.object({
  stack: stackNameField,
  host: z.string().min(1),
  action: z.enum(['deploy', 'teardown', 'update']),
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
    service: serviceNameField,
  }),
]);
