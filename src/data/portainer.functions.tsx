import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import type { PortainerEndpoint, PortainerStack } from '@/types/portainer';
import type { ContainerVersionSummary } from '@/types/container-versions';

// ─── Status ───────────────────────────────────────────────────────────────────

export const getPortainerStatus = createServerFn()
  .handler(async (): Promise<{ configured: boolean }> => {
    const { isPortainerConfigured } = await import('@/lib/config/portainer-config');
    return { configured: isPortainerConfigured() };
  });

// ─── Stacks ───────────────────────────────────────────────────────────────────

interface EnrichedStack {
  id: number;
  name: string;
  endpointId: number;
  endpointName: string;
  status: number;
}

export const getPortainerStacks = createServerFn()
  .handler(async (): Promise<EnrichedStack[]> => {
    try {
      const { isPortainerConfigured, loadPortainerConfig } = await import(
        '@/lib/config/portainer-config'
      );
      const { portainerConnectionManager } = await import(
        '@/lib/clients/portainer-client'
      );

      if (!isPortainerConfigured()) return [];

      const config = loadPortainerConfig();
      const client = portainerConnectionManager.getClient(config);

      const [stacks, endpoints] = await Promise.all([
        client.getStacks(),
        client.getEndpoints(),
      ]);

      const endpointMap = new Map<number, string>(
        endpoints.map((ep: PortainerEndpoint) => [ep.Id, ep.Name]),
      );

      return stacks.map((stack: PortainerStack) => ({
        id: stack.Id,
        name: stack.Name,
        endpointId: stack.EndpointId,
        endpointName: endpointMap.get(stack.EndpointId) ?? 'Unknown',
        status: stack.Status,
      }));
    } catch (err) {
      console.error('[getPortainerStacks] Failed:', err);
      return [];
    }
  });

// ─── Redeploy Dry Run ────────────────────────────────────────────────────────

const getRedeployDryRunSchema = z.object({
  stackId: z.number(),
});

interface DryRunContainer {
  name: string;
  image: string;
  currentTag: string | null;
  latestTag: string | null;
  updateAvailable: boolean;
}

interface DryRunResult {
  stackName: string;
  endpointId: number;
  containers: DryRunContainer[];
}

export const getRedeployDryRun = createServerFn()
  .inputValidator(getRedeployDryRunSchema)
  .handler(async ({ data }): Promise<DryRunResult | null> => {
    try {
      const { isPortainerConfigured, loadPortainerConfig } = await import(
        '@/lib/config/portainer-config'
      );
      const { portainerConnectionManager } = await import(
        '@/lib/clients/portainer-client'
      );
      const { databaseConnectionManager } = await import(
        '@/lib/clients/database-client'
      );
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { StatsRepository } = await import(
        '@/lib/database/repositories/stats-repository'
      );

      if (!isPortainerConfigured()) return null;

      const portainerConfig = loadPortainerConfig();
      const client = portainerConnectionManager.getClient(portainerConfig);

      const stacks = await client.getStacks();
      const stack = stacks.find((s: PortainerStack) => s.Id === data.stackId);
      if (!stack) return null;

      const dbConfig = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(dbConfig);
      const repo = new StatsRepository(dbClient.getPool());

      // Get all container version summaries
      const versions: ContainerVersionSummary[] = await repo.getContainerVersionSummaries();

      // Filter versions for containers whose image matches the stack name pattern
      // Stack names in Portainer correspond to docker compose project names
      // Container images that belong to this stack will have compose project label matching the stack name
      const stackName = stack.Name.toLowerCase();
      const matchingVersions = versions.filter((v) => {
        // Match images where the name portion (before the tag) contains the stack name
        const imageName = v.image.split(':')[0].toLowerCase();
        const lastSegment = imageName.split('/').pop() ?? '';
        return lastSegment.includes(stackName) || stackName.includes(lastSegment);
      });

      const containers: DryRunContainer[] = matchingVersions.map((v) => ({
        name: v.image.split(':')[0].split('/').pop() ?? v.image,
        image: v.image,
        currentTag: v.current_tag,
        latestTag: v.latest_tag,
        updateAvailable: v.update_available,
      }));

      return {
        stackName: stack.Name,
        endpointId: stack.EndpointId,
        containers,
      };
    } catch (err) {
      console.error('[getRedeployDryRun] Failed:', err);
      return null;
    }
  });

// ─── Redeploy Stack ──────────────────────────────────────────────────────────

const redeployStackSchema = z.object({
  stackId: z.number(),
  endpointId: z.number(),
});

export const redeployStack = createServerFn()
  .inputValidator(redeployStackSchema)
  .handler(async ({ data }): Promise<{ success: boolean; error?: string }> => {
    // Resolve stack name first for notification messages
    let stackName = `Stack #${data.stackId}`;

    try {
      const { loadPortainerConfig } = await import('@/lib/config/portainer-config');
      const { portainerConnectionManager } = await import(
        '@/lib/clients/portainer-client'
      );
      const { databaseConnectionManager } = await import(
        '@/lib/clients/database-client'
      );
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { NotificationRepository } = await import(
        '@/lib/database/repositories/notification-repository'
      );
      const { buildNotification } = await import(
        '@/lib/constants/notification-templates'
      );

      const portainerConfig = loadPortainerConfig();
      const client = portainerConnectionManager.getClient(portainerConfig);

      // Try to resolve the actual stack name
      try {
        const stacks = await client.getStacks();
        const stack = stacks.find((s: PortainerStack) => s.Id === data.stackId);
        if (stack) stackName = stack.Name;
      } catch {
        // Keep fallback name
      }

      await client.redeployStack(data.stackId, data.endpointId);

      // Create success notification
      const dbConfig = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(dbConfig);
      const notifRepo = new NotificationRepository(dbClient.getPool());
      const notif = buildNotification('stackRedeploySuccess', { stackName });
      await notifRepo.createNotification(notif.type, notif.severity, notif.title, notif.message);

      return { success: true };
    } catch (err) {
      console.error('[redeployStack] Failed:', err);

      // Create failure notification
      try {
        const { databaseConnectionManager } = await import(
          '@/lib/clients/database-client'
        );
        const { loadDatabaseConfig } = await import('@/lib/config/database-config');
        const { NotificationRepository } = await import(
          '@/lib/database/repositories/notification-repository'
        );
        const { buildNotification } = await import(
          '@/lib/constants/notification-templates'
        );

        const dbConfig = loadDatabaseConfig();
        const dbClient = await databaseConnectionManager.getClient(dbConfig);
        const notifRepo = new NotificationRepository(dbClient.getPool());
        const errorMessage = err instanceof Error ? err.message : String(err);
        const notif = buildNotification('stackRedeployFailed', {
          stackName,
          error: errorMessage,
        });
        await notifRepo.createNotification(notif.type, notif.severity, notif.title, notif.message);
      } catch (notifErr) {
        console.error('[redeployStack] Failed to create failure notification:', notifErr);
      }

      const errorMessage = err instanceof Error ? err.message : String(err);
      return { success: false, error: errorMessage };
    }
  });
