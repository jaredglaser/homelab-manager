import { createServerFn } from '@tanstack/react-start';
import type { DockerStatsRow } from '@/types/docker';
import { databaseMiddleware } from '@/middleware/database-middleware';
import { authMiddleware } from '@/middleware/auth-middleware';
import { requireRole } from '@/lib/auth/require-role';
import {
  getHistoricalDockerStatsSchema,
  getContainerHistorySchema,
  getContainerInfoSchema,
  updateContainerIconSchema,
  clearContainerIconSchema,
  controlContainerSchema,
} from '@/data/docker/schemas';

/**
 * Get historical Docker stats (wide rows) for preloading.
 */
export const getHistoricalDockerStats = createServerFn()
  .middleware([authMiddleware, databaseMiddleware])
  .inputValidator(getHistoricalDockerStatsSchema)
  .handler(async ({ context, data }): Promise<DockerStatsRow[]> => {
    try {
      const { StatsRepository } = await import(
        '@/lib/database/repositories/stats-repository'
      );
      const repo = new StatsRepository(context.pool);

      return await repo.getDockerStatsHistory(data.seconds);
    } catch (err) {
      console.error('[getHistoricalDockerStats] Failed to fetch historical data:', err);
      return [];
    }
  });

/**
 * Get icon and service_key entity for each Docker container.
 * Returns a plain object mapping container entity (host/container_id) →
 * { iconSlug, serviceKeyEntity } for use in the live dashboard.
 * Icons are stored under the service_key entity so they survive container recreation.
 */
export const getDockerEntityIcons = createServerFn()
  .middleware([authMiddleware, databaseMiddleware])
  .handler(async ({ context }): Promise<Record<string, { iconSlug: string | null; serviceKeyEntity: string }>> => {
    try {
      const { EntityMetadataRepository } = await import(
        '@/lib/database/repositories/entity-metadata-repository'
      );
      const repo = new EntityMetadataRepository(context.pool);

      const metaMap = await repo.getDockerContainerMetadata();
      return Object.fromEntries(metaMap);
    } catch (err) {
      console.error('[getDockerEntityIcons] Failed to fetch entity icons:', err);
      return {};
    }
  });

export const getContainerHistory = createServerFn()
  .middleware([authMiddleware, databaseMiddleware])
  .inputValidator(getContainerHistorySchema)
  .handler(async ({ context, data }): Promise<DockerStatsRow[]> => {
    try {
      const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');
      const { EntityMetadataRepository } = await import(
        '@/lib/database/repositories/entity-metadata-repository'
      );
      const repo = new StatsRepository(context.pool);
      const metaRepo = new EntityMetadataRepository(context.pool);

      const fromMs = Math.min(data.fromMs, data.toMs);
      const toMs = Math.max(data.fromMs, data.toMs);

      // Fan out to all container IDs that share the same service_key on this host,
      // so history is seamlessly unified across container recreations.
      let containerIds: string[] = [data.containerId];
      if (data.host) {
        const linked = await metaRepo.getLinkedContainerIds(
          `${data.host}/${data.containerId}`,
          data.host,
        );
        if (linked.length > 0) containerIds = linked;
      }

      return await repo.getDockerStatsForContainer(
        containerIds,
        data.host,
        new Date(fromMs),
        new Date(toMs),
        data.targetPoints,
      );
    } catch (err) {
      console.error('[getContainerHistory] Failed to fetch container history:', err);
      return [];
    }
  });

export const getContainerInfo = createServerFn()
  .middleware([authMiddleware, databaseMiddleware])
  .inputValidator(getContainerInfoSchema)
  .handler(async ({ context, data }): Promise<{
    containerName: string;
    image: string;
    host: string;
    icon: string | null;
    serviceKey: string | null;
  } | null> => {
    try {
      const { StatsRepository } = await import('@/lib/database/repositories/stats-repository');
      const { EntityMetadataRepository } = await import(
        '@/lib/database/repositories/entity-metadata-repository'
      );
      const repo = new StatsRepository(context.pool);
      const metaRepo = new EntityMetadataRepository(context.pool);

      const info = await repo.getContainerInfo(data.containerId, data.host);
      if (!info) return null;

      const containerEntity = `${info.host}/${data.containerId}`;
      const serviceInfo = await metaRepo.getContainerServiceInfo(containerEntity);

      return {
        containerName: info.container_name ?? data.containerId.substring(0, 12),
        image: info.image ?? '',
        host: info.host,
        icon: serviceInfo?.icon ?? null,
        serviceKey: serviceInfo?.serviceKey ?? null,
      };
    } catch (err) {
      console.error('[getContainerInfo] Failed to fetch container info:', err);
      return null;
    }
  });

/**
 * Update the icon for a container service.
 * Stores the icon slug under the service_key entity so it persists across container recreations.
 */
export const controlContainer = createServerFn({ method: 'POST' })
  .middleware([authMiddleware, databaseMiddleware])
  .inputValidator(controlContainerSchema)
  .handler(async ({ context, data }): Promise<void> => {
    requireRole('admin', 'operator')(context.user);
    const { HostRepository } = await import('@/lib/database/repositories/host-repository');
    const { AgentClient } = await import('@/lib/clients/agent-client');
    const { AgentKeypairsRepository } = await import('@/lib/database/repositories/agent-keypairs-repository');
    const { signAgentJwt } = await import('@/lib/crypto/agent-jwt');
    const { loadMasterKeyring } = await import('@/lib/crypto/master-key');

    const hostsRepo = new HostRepository(context.pool);
    const managedHost = await hostsRepo.findByName(data.host);
    if (!managedHost) throw new Error(`Host "${data.host}" not found in managed_hosts`);

    const keyring = await loadMasterKeyring();
    const agentKeypairs = new AgentKeypairsRepository(context.pool, keyring);
    const privateKey = await agentKeypairs.getPrivateKeyForHost(managedHost.name);
    if (!privateKey) throw new Error(`No agent keypair for host "${managedHost.name}". Re-enroll the agent.`);

    const signer = () => signAgentJwt(privateKey, managedHost.name);
    const agent = new AgentClient({ agentUrl: managedHost.agentUrl, signer });

    try {
      if (data.action === 'start') await agent.startContainer(data.containerId);
      else if (data.action === 'stop') await agent.stopContainer(data.containerId);
      else await agent.restartContainer(data.containerId);
    } catch (err) {
      console.error(`[controlContainer] ${data.action} failed for "${data.containerId}" on "${data.host}":`, err);
      throw err;
    }
  });

export const updateContainerIcon = createServerFn()
  .middleware([authMiddleware, databaseMiddleware])
  .inputValidator(updateContainerIconSchema)
  .handler(async ({ context, data }): Promise<void> => {
    const { EntityMetadataRepository } = await import(
      '@/lib/database/repositories/entity-metadata-repository'
    );
    const repo = new EntityMetadataRepository(context.pool);

    await repo.upsertEntityMetadata(data.serviceKeyEntity, 'icon', data.iconSlug);
  });

export const clearContainerIcon = createServerFn()
  .middleware([authMiddleware, databaseMiddleware])
  .inputValidator(clearContainerIconSchema)
  .handler(async ({ context, data }): Promise<void> => {
    const { EntityMetadataRepository } = await import(
      '@/lib/database/repositories/entity-metadata-repository'
    );
    const repo = new EntityMetadataRepository(context.pool);

    await repo.deleteEntityIcon(data.serviceKeyEntity);
  });
