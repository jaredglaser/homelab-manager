import { createServerFn } from '@tanstack/react-start';
import type { ProxmoxStatsRow } from '@/types/proxmox';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { getHistoricalProxmoxStatsSchema } from '@/data/proxmox/schemas';

/**
 * Fetch historical Proxmox stats rows from the database.
 * Used by useTimeSeriesStream to preload data before SSE streaming begins.
 */
export const getHistoricalProxmoxStats = createServerFn()
  .middleware([databaseMiddleware])
  .inputValidator(getHistoricalProxmoxStatsSchema)
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

/**
 * Test the Proxmox API connection.
 */
export const testProxmoxConnection = createServerFn()
  .handler(async (): Promise<{ connected: boolean; error?: string }> => {
    try {
      const { isProxmoxConfigured, loadProxmoxConfig } = await import(
        '@/lib/config/proxmox-config'
      );

      if (!isProxmoxConfigured()) {
        return { connected: false, error: 'Proxmox is not configured. Set PROXMOX_HOST, PROXMOX_TOKEN_ID, and PROXMOX_TOKEN_SECRET environment variables.' };
      }

      const { proxmoxConnectionManager } = await import(
        '@/lib/clients/proxmox-client'
      );

      const config = loadProxmoxConfig();
      const client = proxmoxConnectionManager.getClient(config);
      const connected = await client.testConnection();

      return connected
        ? { connected: true }
        : { connected: false, error: 'Failed to connect to Proxmox API' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[testProxmoxConnection] Failed:', message);
      return { connected: false, error: message };
    }
  });
