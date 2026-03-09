import { createServerFn } from '@tanstack/react-start';
import { z } from 'zod';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import type { SettingsRepository } from '@/lib/database/repositories/settings-repository';

const UPDATE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ── Helpers ──────────────────────────────────────────────────────────

async function getSettingsRepo() {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { SettingsRepository } = await import(
    '@/lib/database/repositories/settings-repository'
  );

  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return new SettingsRepository(client.getPool());
}

async function getNotificationRepo() {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { NotificationRepository } = await import(
    '@/lib/database/repositories/notification-repository'
  );

  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return new NotificationRepository(client.getPool());
}

async function broadcastStatus(
  settingsRepo: SettingsRepository,
  status: string,
  target: string,
  step: string,
  error?: string,
) {
  await settingsRepo.set(SETTINGS_KEYS.update.status, status);
  await settingsRepo.set(SETTINGS_KEYS.update.target, target);
  await settingsRepo.set(SETTINGS_KEYS.update.step, step);
  if (error !== undefined) await settingsRepo.set(SETTINGS_KEYS.update.error, error);
}

// ── Schemas ──────────────────────────────────────────────────────────

const containerUpdateSchema = z.object({
  containerId: z.string().min(1),
  host: z.string().min(1),
});

// ── Dry Run ──────────────────────────────────────────────────────────

export const getContainerUpdateDryRun = createServerFn()
  .inputValidator(containerUpdateSchema)
  .handler(async ({ data }) => {
    try {
      const { dockerConnectionManager } = await import('@/lib/clients/docker-client');
      const { loadDockerConfig } = await import('@/lib/config/docker-config');
      const { databaseConnectionManager } = await import('@/lib/clients/database-client');
      const { loadDatabaseConfig } = await import('@/lib/config/database-config');
      const { StatsRepository } = await import(
        '@/lib/database/repositories/stats-repository'
      );

      const dockerConfig = loadDockerConfig();
      const hostConfig = dockerConfig.hosts.find(
        (h) => h.host === data.host || h.name === data.host,
      );
      if (!hostConfig) throw new Error(`Docker host not found: ${data.host}`);

      const dockerClient = await dockerConnectionManager.getClient(hostConfig);
      const docker = dockerClient.getDocker();
      const container = docker.getContainer(data.containerId);
      const inspectData = await container.inspect();

      const dbConfig = loadDatabaseConfig();
      const dbClient = await databaseConnectionManager.getClient(dbConfig);
      const repo = new StatsRepository(dbClient.getPool());
      const versions = await repo.getContainerVersionSummaries();
      const image = inspectData.Config.Image || '';
      const versionInfo = versions.find((v) => v.image === image);

      return {
        containerId: data.containerId,
        containerName: inspectData.Name?.replace(/^\//, '') || '',
        image,
        currentTag: versionInfo?.current_tag ?? null,
        latestTag: versionInfo?.latest_tag ?? null,
        updateAvailable: versionInfo?.update_available ?? false,
        ports: Object.keys(inspectData.HostConfig.PortBindings || {}).length,
        volumes: (inspectData.Mounts || []).length,
        networks: Object.keys(inspectData.NetworkSettings?.Networks || {}).length,
        envVars: (inspectData.Config.Env || []).length,
      };
    } catch (err) {
      console.error('[getContainerUpdateDryRun] Failed:', err);
      return null;
    }
  });

// ── Update Container ─────────────────────────────────────────────────

export const updateContainer = createServerFn()
  .inputValidator(containerUpdateSchema)
  .handler(async ({ data }): Promise<{ success: boolean; error?: string }> => {
    const settingsRepo = await getSettingsRepo();

    // Check if another update is already in progress
    const currentStatus = await settingsRepo.get(SETTINGS_KEYS.update.status);
    if (currentStatus && currentStatus !== 'idle') {
      return { success: false, error: 'Another update is already in progress' };
    }

    let containerName = data.containerId.substring(0, 12);
    let currentStep = 'initializing';

    try {
      const result = await Promise.race([
        performUpdate(data, settingsRepo, (name, _img, step) => {
          containerName = name;
          currentStep = step;
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Update timed out')), UPDATE_TIMEOUT_MS),
        ),
      ]);
      return result;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const isTimeout = errorMessage === 'Update timed out';

      console.error(`[updateContainer] Failed during ${currentStep}:`, err);

      await broadcastStatus(settingsRepo, 'error', containerName, currentStep, errorMessage);

      // Attempt recovery: try to restart the old container
      try {
        const { dockerConnectionManager } = await import('@/lib/clients/docker-client');
        const { loadDockerConfig } = await import('@/lib/config/docker-config');
        const dockerConfig = loadDockerConfig();
        const hostConfig = dockerConfig.hosts.find(
          (h) => h.host === data.host || h.name === data.host,
        );
        if (hostConfig) {
          const dockerClient = await dockerConnectionManager.getClient(hostConfig);
          const docker = dockerClient.getDocker();
          const container = docker.getContainer(data.containerId);
          const inspectData = await container.inspect();
          if (inspectData.State.Status !== 'running') {
            await container.start();
          }
        }
      } catch (recoveryErr) {
        console.error('[updateContainer] Recovery failed:', recoveryErr);
        const notifRepo = await getNotificationRepo();
        const { buildNotification } = await import(
          '@/lib/constants/notification-templates'
        );
        const notif = buildNotification('containerRecoveryFailed', {
          name: containerName,
          error: recoveryErr instanceof Error ? recoveryErr.message : String(recoveryErr),
        });
        await notifRepo.createNotification(notif.type, notif.severity, notif.title, notif.message);
      }

      // Create failure notification
      const notifRepo = await getNotificationRepo();
      const { buildNotification } = await import(
        '@/lib/constants/notification-templates'
      );
      if (isTimeout) {
        const notif = buildNotification('containerUpdateTimeout', {
          name: containerName,
          step: currentStep,
        });
        await notifRepo.createNotification(notif.type, notif.severity, notif.title, notif.message);
      } else {
        const notif = buildNotification('containerUpdateFailed', {
          name: containerName,
          step: currentStep,
          error: errorMessage,
        });
        await notifRepo.createNotification(notif.type, notif.severity, notif.title, notif.message);
      }

      return { success: false, error: errorMessage };
    } finally {
      await broadcastStatus(settingsRepo, 'idle', '', '', '');
    }
  });

async function performUpdate(
  data: { containerId: string; host: string },
  settingsRepo: SettingsRepository,
  onProgress: (name: string, image: string, step: string) => void,
): Promise<{ success: boolean }> {
  const { dockerConnectionManager } = await import('@/lib/clients/docker-client');
  const { loadDockerConfig } = await import('@/lib/config/docker-config');

  const dockerConfig = loadDockerConfig();
  const hostConfig = dockerConfig.hosts.find(
    (h) => h.host === data.host || h.name === data.host,
  );
  if (!hostConfig) throw new Error(`Docker host not found: ${data.host}`);

  const dockerClient = await dockerConnectionManager.getClient(hostConfig);
  const docker = dockerClient.getDocker();
  const container = docker.getContainer(data.containerId);
  const inspectData = await container.inspect();

  const containerName = inspectData.Name?.replace(/^\//, '') || data.containerId.substring(0, 12);
  const image = inspectData.Config.Image || '';
  onProgress(containerName, image, 'inspecting');

  // Step 1: Pull new image
  onProgress(containerName, image, 'pulling');
  await broadcastStatus(settingsRepo, 'pulling', containerName, `Pulling image ${image}`);
  const pullStream = await docker.pull(image);
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(pullStream, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });

  // Step 2: Stop container
  onProgress(containerName, image, 'stopping');
  await broadcastStatus(settingsRepo, 'stopping', containerName, `Stopping ${containerName}`);
  await container.stop();

  // Step 3: Remove container
  onProgress(containerName, image, 'recreating');
  await broadcastStatus(
    settingsRepo,
    'recreating',
    containerName,
    `Removing old container and creating new one`,
  );
  await container.remove();

  // Step 4: Create new container with same config
  const createConfig = {
    name: containerName,
    Image: image,
    Env: inspectData.Config.Env,
    Cmd: inspectData.Config.Cmd,
    Entrypoint: inspectData.Config.Entrypoint,
    ExposedPorts: inspectData.Config.ExposedPorts,
    Labels: inspectData.Config.Labels,
    WorkingDir: inspectData.Config.WorkingDir,
    User: inspectData.Config.User,
    HostConfig: {
      Binds: inspectData.HostConfig.Binds,
      PortBindings: inspectData.HostConfig.PortBindings,
      RestartPolicy: inspectData.HostConfig.RestartPolicy,
      NetworkMode: inspectData.HostConfig.NetworkMode,
      Privileged: inspectData.HostConfig.Privileged,
      CapAdd: inspectData.HostConfig.CapAdd,
      CapDrop: inspectData.HostConfig.CapDrop,
      Devices: inspectData.HostConfig.Devices,
      Memory: inspectData.HostConfig.Memory,
      MemoryReservation: inspectData.HostConfig.MemoryReservation,
      CpuShares: inspectData.HostConfig.CpuShares,
      CpuQuota: inspectData.HostConfig.CpuQuota,
      CpuPeriod: inspectData.HostConfig.CpuPeriod,
    },
    NetworkingConfig: {
      EndpointsConfig: inspectData.NetworkSettings?.Networks || {},
    },
  };
  const newContainer = await docker.createContainer(createConfig);

  // Step 5: Start new container
  onProgress(containerName, image, 'starting');
  await broadcastStatus(settingsRepo, 'starting', containerName, `Starting ${containerName}`);
  await newContainer.start();

  // Step 6: Complete
  await broadcastStatus(settingsRepo, 'complete', containerName, `${containerName} updated successfully`);

  // Create success notification
  const notifRepo = await getNotificationRepo();
  const { buildNotification } = await import('@/lib/constants/notification-templates');
  const tag = image.includes(':') ? image.split(':').pop() || 'latest' : 'latest';
  const notif = buildNotification('containerUpdateSuccess', { name: containerName, tag });
  await notifRepo.createNotification(notif.type, notif.severity, notif.title, notif.message);

  return { success: true };
}
