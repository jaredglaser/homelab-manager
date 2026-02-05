import { z } from 'zod';
import type { DatabaseConfig } from '../clients/database-client';

const DatabaseConfigSchema = z.object({
  host: z.string(),
  port: z.number().int().positive(),
  database: z.string(),
  user: z.string(),
  password: z.string(),
  ssl: z.boolean(),
  max: z.number().int().min(1).max(100),
});

/**
 * Load database configuration from environment variables
 * Validates all required fields and provides sensible defaults
 *
 * @returns Validated database configuration
 * @throws {z.ZodError} If configuration is invalid
 */
export function loadDatabaseConfig(): DatabaseConfig {
  const config = {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432', 10),
    database: process.env.POSTGRES_DB || 'homelab',
    user: process.env.POSTGRES_USER || 'homelab',
    password: process.env.POSTGRES_PASSWORD || '',
    ssl: process.env.POSTGRES_SSL === 'true',
    max: parseInt(process.env.POSTGRES_POOL_SIZE || '10', 10),
  };

  return DatabaseConfigSchema.parse(config);
}
