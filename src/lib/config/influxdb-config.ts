import { z } from 'zod';

export interface InfluxDBConfig {
  url: string;
  token: string;
  org: string;
  bucket: string;
}

const InfluxDBConfigSchema = z.object({
  url: z.string().url(),
  token: z.string().min(1),
  org: z.string().min(1),
  bucket: z.string().min(1),
});

/**
 * Load InfluxDB configuration from environment variables.
 * Validates all required fields.
 *
 * @returns Validated InfluxDB configuration
 * @throws {z.ZodError} If configuration is invalid
 */
export function loadInfluxDBConfig(): InfluxDBConfig {
  const config = {
    url: process.env.INFLUXDB_URL || 'http://localhost:8086',
    token: process.env.INFLUXDB_TOKEN || '',
    org: process.env.INFLUXDB_ORG || 'homelab',
    bucket: process.env.INFLUXDB_BUCKET || 'homelab',
  };

  return InfluxDBConfigSchema.parse(config);
}
