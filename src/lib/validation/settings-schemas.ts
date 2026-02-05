import { z } from 'zod';

/**
 * Zod schemas for validating Docker and ZFS settings.
 * Used both client-side (form validation) and server-side (save handler).
 */

// --- Docker Settings ---

export const dockerSettingsSchema = z.object({
  host: z
    .string()
    .min(1, 'Host is required')
    .max(253, 'Host must be 253 characters or fewer'),
  port: z
    .number()
    .int('Port must be a whole number')
    .min(1, 'Port must be between 1 and 65535')
    .max(65535, 'Port must be between 1 and 65535'),
  protocol: z.enum(['http', 'https'], {
    message: 'Protocol must be http or https',
  }),
});

export type DockerSettings = z.infer<typeof dockerSettingsSchema>;

// --- ZFS SSH Settings ---

const baseZFSFields = {
  host: z
    .string()
    .min(1, 'Host is required')
    .max(253, 'Host must be 253 characters or fewer'),
  port: z
    .number()
    .int('Port must be a whole number')
    .min(1, 'Port must be between 1 and 65535')
    .max(65535, 'Port must be between 1 and 65535'),
  username: z
    .string()
    .min(1, 'Username is required')
    .max(256, 'Username must be 256 characters or fewer'),
};

const zfsPasswordAuthSchema = z.object({
  ...baseZFSFields,
  authType: z.literal('password'),
  password: z.string().min(1, 'Password is required'),
  keyPath: z.string().optional(),
  passphrase: z.string().optional(),
});

const zfsKeyAuthSchema = z.object({
  ...baseZFSFields,
  authType: z.literal('privateKey'),
  password: z.string().optional(),
  keyPath: z
    .string()
    .min(1, 'Key path is required for private key authentication'),
  passphrase: z.string().optional(),
});

export const zfsSettingsSchema = z.discriminatedUnion('authType', [
  zfsPasswordAuthSchema,
  zfsKeyAuthSchema,
]);

export type ZFSSettings = z.infer<typeof zfsSettingsSchema>;

// --- Combined Settings ---

export const settingsSchema = z.object({
  docker: dockerSettingsSchema,
  zfs: zfsSettingsSchema,
});

export type Settings = z.infer<typeof settingsSchema>;

// --- Form input schemas (accept string port, coerce to number) ---

export const dockerFormSchema = z.object({
  host: dockerSettingsSchema.shape.host,
  port: z
    .string()
    .min(1, 'Port is required')
    .transform((val) => parseInt(val, 10))
    .pipe(dockerSettingsSchema.shape.port),
  protocol: dockerSettingsSchema.shape.protocol,
});

export type DockerFormInput = z.input<typeof dockerFormSchema>;

const baseZFSFormFields = {
  host: baseZFSFields.host,
  port: z
    .string()
    .min(1, 'Port is required')
    .transform((val) => parseInt(val, 10))
    .pipe(baseZFSFields.port),
  username: baseZFSFields.username,
};

const zfsPasswordFormSchema = z.object({
  ...baseZFSFormFields,
  authType: z.literal('password'),
  password: z.string().min(1, 'Password is required'),
  keyPath: z.string().optional(),
  passphrase: z.string().optional(),
});

const zfsKeyFormSchema = z.object({
  ...baseZFSFormFields,
  authType: z.literal('privateKey'),
  password: z.string().optional(),
  keyPath: z
    .string()
    .min(1, 'Key path is required for private key authentication'),
  passphrase: z.string().optional(),
});

export const zfsFormSchema = z.discriminatedUnion('authType', [
  zfsPasswordFormSchema,
  zfsKeyFormSchema,
]);

export type ZFSFormInput = z.input<typeof zfsFormSchema>;
