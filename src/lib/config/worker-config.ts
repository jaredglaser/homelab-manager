import { z } from 'zod';

const WorkerConfigSchema = z.object({
  enabled: z.boolean(),
  docker: z.object({
    enabled: z.boolean(),
  }),
  zfs: z.object({
    enabled: z.boolean(),
  }),
  proxmox: z.object({
    enabled: z.boolean(),
  }),
  collection: z.object({
    interval: z.number().int().min(100).max(60000),
  }),
  versionCheck: z.object({
    enabled: z.boolean(),
    interval: z.number().int().min(60000),
  }),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/**
 * Load and validate worker configuration from environment variables.
 *
 * Reads configuration values from process.env, applies defaults where needed,
 * and validates the result against the WorkerConfigSchema.
 *
 * @returns The validated worker configuration.
 * @throws {z.ZodError} If the configuration is invalid according to the schema.
 */
export function loadWorkerConfig(): WorkerConfig {
  const config = {
    enabled: process.env.WORKER_ENABLED === 'true',
    docker: {
      enabled: process.env.WORKER_DOCKER_ENABLED === 'true',
    },
    zfs: {
      enabled: process.env.WORKER_ZFS_ENABLED === 'true',
    },
    proxmox: {
      enabled: process.env.WORKER_PROXMOX_ENABLED === 'true',
    },
    collection: {
      interval: parseInt(process.env.WORKER_COLLECTION_INTERVAL_MS || '1000', 10),
    },
    versionCheck: {
      enabled: process.env.WORKER_VERSION_CHECK_ENABLED !== 'false',
      interval: parseInt(process.env.WORKER_VERSION_CHECK_INTERVAL_MS || '86400000', 10),
    },
  };

  return WorkerConfigSchema.parse(config);
}
