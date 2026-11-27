import { z } from 'zod';

export const HOST_NAME_MAX_LENGTH = 100;

export const hostNameSchema = z.string()
  .min(1, 'Enter a name for this host.')
  .max(HOST_NAME_MAX_LENGTH, `Use ${HOST_NAME_MAX_LENGTH} characters or fewer.`)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Use only letters, numbers, hyphens and underscores. Spaces are not allowed.');

export const agentUrlSchema = z.url({ protocol: /^https?$/, error: 'Enter the full agent URL, such as https://192.168.1.10:9090.' });

export const createPendingHostSchema = z.object({
  name: hostNameSchema,
  /** The host this wizard already created, which keeps its name once it has enrolled. */
  resumeHostId: z.number().int().positive().optional(),
  capabilities: z.object({
    docker: z.boolean().optional().default(false),
    zfs: z.boolean().optional().default(false),
  }).optional().default({ docker: false, zfs: false }),
});

export const removeHostSchema = z.object({
  hostId: z.number().int().positive(),
  expectStatus: z.literal('pending').optional(),
});
export const checkHostHealthSchema = z.object({ hostId: z.number().int().positive() });
export const getHostPublicJwkSchema = z.object({ hostId: z.number().int().positive() });
export const rotateHostKeypairSchema = z.object({ hostId: z.number().int().positive() });
export const rotateHostTlsSchema = z.object({
  hostId: z.number().int().positive(),
  agentUrl: agentUrlSchema.optional(),
  /** The operator has accepted that a plaintext enrollment trusts whatever certificate the agent presents. */
  acceptPlaintextEnrollment: z.boolean().optional(),
});
export const updateAgentSchema = z.object({ hostId: z.number().int().positive() });

export const updateHostSchema = z.object({
  hostId: z.number().int().positive(),
  name: hostNameSchema.optional(),
  agentUrl: agentUrlSchema.optional(),
}).refine(
  (data) => data.name !== undefined || data.agentUrl !== undefined,
  { error: 'At least one of name or agentUrl must be provided' },
);
