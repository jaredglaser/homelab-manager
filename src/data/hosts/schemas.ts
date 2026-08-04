import { z } from 'zod';

const hostNameSchema = z.string().min(1).max(100).regex(
  /^[a-zA-Z0-9_-]+$/,
  'Must contain only letters, numbers, hyphens, and underscores',
);

/** `ansible_host` is consumed as a bare address, so a scheme, port, or path here would be passed to SSH verbatim. */
const sshHostSchema = z.string().trim().min(1).max(253).regex(
  /^(?:[a-zA-Z0-9.-]+|[0-9a-fA-F:]+)$/,
  'Must be a hostname or IP address, without a scheme, port, or path',
);

const sshUserSchema = z.string().trim().min(1).max(32).regex(
  /^[a-z_][a-z0-9_-]*$/,
  'Must be a valid Linux username',
);

export const verifyHostSchema = z.object({
  name: hostNameSchema,
  agentUrl: z.url(),
  sshHost: sshHostSchema.nullish(),
  sshUser: sshUserSchema.nullish(),
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
  sshHost: sshHostSchema.nullish(),
  sshUser: sshUserSchema.nullish(),
}).refine(
  (data) => data.name !== undefined
    || data.agentUrl !== undefined
    || data.sshHost !== undefined
    || data.sshUser !== undefined,
  { error: 'At least one of name, agentUrl, sshHost, or sshUser must be provided' },
);
