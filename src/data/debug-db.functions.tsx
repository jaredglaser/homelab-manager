import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';

async function getStatsRepository() {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { StatsRepository } = await import(
    '@/lib/database/repositories/stats-repository'
  );

  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return new StatsRepository(client.getPool());
}

export const getDebugSummary = createServerFn().handler(async () => {
  const repo = await getStatsRepository();
  return repo.getDebugSummary();
});

const queryDebugStatsSchema = z.object({
  source: z.string().optional(),
  type: z.string().optional(),
  entityFilter: z.string().optional(),
  maxAgeSeconds: z.number().min(1).max(86400).default(300),
  limit: z.number().min(1).max(5000).default(500),
});

export const queryDebugStats = createServerFn()
  .inputValidator(queryDebugStatsSchema)
  .handler(async ({ data }) => {
    const repo = await getStatsRepository();
    return repo.queryDebugStats({
      source: data.source || undefined,
      type: data.type || undefined,
      entityFilter: data.entityFilter || undefined,
      maxAgeSeconds: data.maxAgeSeconds,
      limit: data.limit,
    });
  });
