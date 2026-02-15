import { z } from 'zod';

const WorkerConfigSchema = z.object({
  enabled: z.boolean(),
  docker: z.object({
    enabled: z.boolean(),
  }),
  zfs: z.object({
    enabled: z.boolean(),
  }),
  collection: z.object({
    interval: z.number().int().min(100).max(60000),
  }),
  batch: z.object({
    size: z.number().int().min(1).max(1000),
    timeout: z.number().int().min(1000).max(60000),
  }),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/**
 * Load worker configuration from environment variables
 * Validates all required fields and provides sensible defaults
 *
 * @returns Validated worker configuration
 * @throws {z.ZodError} If configuration is invalid
 */
export function loadWorkerConfig(): WorkerConfig {
  const config = {
    enabled: process.env.WORKER_ENABLED === 'true',
    docker: {
      enabled: process.env.WORKER_DOCKER_ENABLED !== 'false',
    },
    zfs: {
      enabled: process.env.WORKER_ZFS_ENABLED !== 'false',
    },
    collection: {
      interval: parseInt(process.env.WORKER_COLLECTION_INTERVAL_MS || '5000', 10),
    },
    batch: {
      size: parseInt(process.env.WORKER_BATCH_SIZE || '10', 10),
      timeout: parseInt(process.env.WORKER_BATCH_TIMEOUT_MS || '1000', 10),
    },
  };

  return WorkerConfigSchema.parse(config);
}
