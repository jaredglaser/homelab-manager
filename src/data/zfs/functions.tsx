import { createServerFn } from '@tanstack/react-start';
import type { ZFSStatsRow } from '@/types/zfs';
import type { ZfsNodeSummary } from '@/lib/zfs/node-state';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { authMiddleware } from '@/middleware/auth-middleware';
import { roleMiddleware } from '@/lib/auth/role-middleware';
import {
  confirmZfsNodeHostKeySchema,
  createZfsNodeSchema,
  getHistoricalZFSStatsSchema,
  zfsNodeIdSchema,
} from '@/data/zfs/schemas';
import type {
  CreateZfsNodeResult,
  ScanZfsNodeResult,
  VerifyZfsNodeResult,
  ZfsNodeHandlerDeps,
} from '@/data/zfs/handlers';

export type { CreateZfsNodeResult, ScanZfsNodeResult, VerifyZfsNodeResult } from '@/data/zfs/handlers';

/**
 * Get historical ZFS stats (wide rows) for preloading.
 */
export const getHistoricalZFSStats = createServerFn()
  .middleware([authMiddleware, roleMiddleware('admin', 'operator', 'viewer'), databaseMiddleware])
  .validator(getHistoricalZFSStatsSchema)
  .handler(async ({ context, data }): Promise<ZFSStatsRow[]> => {
    try {
      const { StatsRepository } = await import(
        '@/lib/database/repositories/stats-repository'
      );
      const repo = new StatsRepository(context.pool);

      return await repo.getZFSStatsHistory(data.seconds);
    } catch (err) {
      console.error('[getHistoricalZFSStats] Failed to fetch historical data:', err);
      return [];
    }
  });

async function loadZfsNodeDeps(): Promise<ZfsNodeHandlerDeps> {
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { loadMasterKeyring } = await import('@/lib/crypto/master-key');
  const { ZfsNodeRepository } = await import('@/lib/database/repositories/zfs-node-repository');
  const { createSsh2Transport } = await import('@/lib/zfs/ssh-transport');
  const { utils } = await import('ssh2');
  const dbClient = await databaseConnectionManager.getClient(loadDatabaseConfig());
  const keyring = await loadMasterKeyring();
  return {
    repo: new ZfsNodeRepository(dbClient.getPool(), keyring),
    transport: createSsh2Transport(),
    generateKeyPair: () => {
      const pair = utils.generateKeyPairSync('ed25519');
      return { privateKey: pair.private, publicKey: pair.public.split(' ').slice(0, 2).join(' ') };
    },
  };
}

export const listZfsNodes = createServerFn()
  .middleware([authMiddleware, roleMiddleware('admin', 'operator', 'viewer')])
  .handler(async (): Promise<ZfsNodeSummary[]> => {
    const { handleListZfsNodes } = await import('@/data/zfs/handlers');
    return handleListZfsNodes(await loadZfsNodeDeps());
  });

export const createZfsNode = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, roleMiddleware('admin')])
  .validator(createZfsNodeSchema)
  .handler(async ({ data }): Promise<CreateZfsNodeResult> => {
    const { handleCreateZfsNode } = await import('@/data/zfs/handlers');
    return handleCreateZfsNode(await loadZfsNodeDeps(), data);
  });

export const getZfsNodeSetupScript = createServerFn()
  .middleware([authMiddleware, roleMiddleware('admin')])
  .validator(zfsNodeIdSchema)
  .handler(async ({ data }): Promise<{ setupScript: string } | null> => {
    const { handleGetZfsNodeSetupScript } = await import('@/data/zfs/handlers');
    return handleGetZfsNodeSetupScript(await loadZfsNodeDeps(), data);
  });

export const scanZfsNodeHostKey = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, roleMiddleware('admin')])
  .validator(zfsNodeIdSchema)
  .handler(async ({ data }): Promise<ScanZfsNodeResult> => {
    const { handleScanZfsNodeHostKey } = await import('@/data/zfs/handlers');
    return handleScanZfsNodeHostKey(await loadZfsNodeDeps(), data);
  });

export const confirmZfsNodeHostKey = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, roleMiddleware('admin')])
  .validator(confirmZfsNodeHostKeySchema)
  .handler(async ({ data }): Promise<VerifyZfsNodeResult> => {
    const { handleConfirmZfsNodeHostKey } = await import('@/data/zfs/handlers');
    return handleConfirmZfsNodeHostKey(await loadZfsNodeDeps(), data);
  });

export const verifyZfsNode = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, roleMiddleware('admin', 'operator')])
  .validator(zfsNodeIdSchema)
  .handler(async ({ data }): Promise<VerifyZfsNodeResult> => {
    const { handleVerifyZfsNode } = await import('@/data/zfs/handlers');
    return handleVerifyZfsNode(await loadZfsNodeDeps(), data);
  });

export const removeZfsNode = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, roleMiddleware('admin')])
  .validator(zfsNodeIdSchema)
  .handler(async ({ data }): Promise<{ removed: boolean }> => {
    const { handleRemoveZfsNode } = await import('@/data/zfs/handlers');
    return handleRemoveZfsNode(await loadZfsNodeDeps(), data);
  });
