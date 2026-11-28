import { createServerFn } from '@tanstack/react-start';
import type { Pool } from 'pg';
import type { ProxmoxConnectionSummary, ProxmoxStatsRow } from '@/types/proxmox';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { authMiddleware } from '@/middleware/auth-middleware';
import { roleMiddleware } from '@/lib/auth/role-middleware';
import {
  getHistoricalProxmoxStatsSchema,
  removeProxmoxConnectionSchema,
  saveProxmoxConnectionSchema,
  testProxmoxConnectionSchema,
} from '@/data/proxmox/schemas';
import {
  createProxmoxConnectionDeps,
  handleListProxmoxConnections,
  handleRemoveProxmoxConnection,
  handleSaveProxmoxConnection,
  handleTestProxmoxConnection,
  type ProxmoxConnectionDeps,
  type SaveProxmoxConnectionResult,
  type TestProxmoxConnectionResult,
} from '@/data/proxmox/connection-handlers';

export type { SaveProxmoxConnectionResult, TestProxmoxConnectionResult } from '@/data/proxmox/connection-handlers';

/**
 * Fetch historical Proxmox stats rows from the database.
 * Used by useTimeSeriesStream to preload data before live streaming begins.
 */
export const getHistoricalProxmoxStats = createServerFn()
  .middleware([authMiddleware, roleMiddleware('admin', 'operator', 'viewer'), databaseMiddleware])
  .validator(getHistoricalProxmoxStatsSchema)
  .handler(async ({ context, data }): Promise<ProxmoxStatsRow[]> => {
    try {
      const { StatsRepository } = await import(
        '@/lib/database/repositories/stats-repository'
      );
      const repo = new StatsRepository(context.pool);

      return await repo.getProxmoxStatsHistory(data.seconds);
    } catch (err) {
      console.error('[getHistoricalProxmoxStats] Failed to fetch historical data:', err);
      return [];
    }
  });

async function loadConnectionDeps(pool: Pool): Promise<ProxmoxConnectionDeps> {
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  return createProxmoxConnectionDeps(pool, await loadMasterKeyring());
}

export const listProxmoxConnections = createServerFn()
  .middleware([authMiddleware, roleMiddleware('admin', 'operator', 'viewer'), databaseMiddleware])
  .handler(async ({ context }): Promise<ProxmoxConnectionSummary[]> => {
    return handleListProxmoxConnections(await loadConnectionDeps(context.pool));
  });

export const saveProxmoxConnection = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, roleMiddleware('admin'), databaseMiddleware])
  .validator(saveProxmoxConnectionSchema)
  .handler(async ({ context, data }): Promise<SaveProxmoxConnectionResult> => {
    return handleSaveProxmoxConnection(await loadConnectionDeps(context.pool), data);
  });

export const testProxmoxConnection = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, roleMiddleware('admin'), databaseMiddleware])
  .validator(testProxmoxConnectionSchema)
  .handler(async ({ context, data }): Promise<TestProxmoxConnectionResult> => {
    return handleTestProxmoxConnection(await loadConnectionDeps(context.pool), data);
  });

export const removeProxmoxConnection = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, roleMiddleware('admin'), databaseMiddleware])
  .validator(removeProxmoxConnectionSchema)
  .handler(async ({ context, data }): Promise<{ removed: boolean }> => {
    return handleRemoveProxmoxConnection(await loadConnectionDeps(context.pool), data);
  });
