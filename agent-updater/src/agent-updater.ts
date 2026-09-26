import type Dockerode from 'dockerode';
import type { HealthReporter } from './health-reporter';

export interface AgentUpdaterConfig {
  containerName: string;
  imageName: string;
  checkIntervalMs: number;
  healthCheckMaxAttempts?: number;
  healthCheckIntervalMs?: number;
}

export interface UpdateCheckResult {
  updateAvailable: boolean;
  currentDigest?: string;
  remoteDigest?: string;
}

export interface UpdateResult {
  success: boolean;
  previousImage?: string;
  newImage?: string;
  error?: string;
  rolledBack?: boolean;
}

export interface HealthWaitParams {
  maxAttempts: number;
  intervalMs: number;
}

// Docker's first health result only lands after one full interval, so a fixed
// 30s window races any image whose HEALTHCHECK interval is >= 30s.
export function deriveHealthWaitParams(healthcheck:
  | { Interval?: number; StartPeriod?: number; Retries?: number }
  | undefined): HealthWaitParams {
  if (!healthcheck?.Interval) {
    return { maxAttempts: 10, intervalMs: 3000 };
  }
  const intervalMs = healthcheck.Interval / 1e6;
  const startPeriodMs = (healthcheck.StartPeriod ?? 0) / 1e6;
  const retries = healthcheck.Retries && healthcheck.Retries > 0 ? healthcheck.Retries : 3;
  const totalMs = startPeriodMs + intervalMs * (retries + 1) + 10_000;
  const pollMs = Math.min(3000, intervalMs);
  return { maxAttempts: Math.ceil(totalMs / pollMs), intervalMs: pollMs };
}

/** Polls GHCR for new image digests and recreates the agent container when updates are available. */
export class AgentUpdater {
  private docker: Dockerode;
  private config: AgentUpdaterConfig;
  private healthReporter: HealthReporter;

  constructor(docker: Dockerode, config: AgentUpdaterConfig, healthReporter: HealthReporter) {
    this.docker = docker;
    this.config = config;
    this.healthReporter = healthReporter;
  }

  /** Check whether a newer image digest is available on the registry. */
  async checkForUpdate(): Promise<UpdateCheckResult> {
    try {
      const container = this.docker.getContainer(this.config.containerName);
      const containerInfo = await container.inspect();

      const image = this.docker.getImage(containerInfo.Image);
      const imageInfo = await image.inspect();
      const currentDigest = this.extractDigest(
        imageInfo.RepoDigests?.[0] ?? containerInfo.Image
      );

      const remoteImage = this.docker.getImage(this.config.imageName);
      const distribution = await remoteImage.distribution();
      const remoteDigest = distribution.Descriptor?.digest as string | undefined;

      if (!remoteDigest) {
        return { updateAvailable: false, currentDigest };
      }

      const updateAvailable = currentDigest !== remoteDigest;
      return { updateAvailable, currentDigest, remoteDigest };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to check for update: ${message}`);
      return { updateAvailable: false };
    }
  }

  /** Pull new image, stop old container, recreate with same config, verify health. Rolls back on failure. */
  async performUpdate(): Promise<UpdateResult> {
    let previousImage: string | undefined;
    let containerInfo: Dockerode.ContainerInspectInfo | undefined;
    let teardownCompleted = false;

    try {
      const container = this.docker.getContainer(this.config.containerName);
      containerInfo = await container.inspect();
      // Pin by digest or image ID: after the pull the old tag resolves to the
      // new image, which would make rollback a no-op.
      previousImage = await this.resolvePreviousImageRef(containerInfo);

      console.info(`Pulling new image: ${this.config.imageName}`);
      await this.pullImage(this.config.imageName);

      console.info(`Stopping container: ${this.config.containerName}`);
      await container.stop();
      await container.remove();
      teardownCompleted = true;

      console.info(`Creating container: ${this.config.containerName}`);
      const newContainer = await this.recreateContainer(containerInfo);
      await newContainer.start();

      const wait = await this.resolveHealthWaitParams();
      const healthy = await this.waitForHealthy(newContainer, wait.maxAttempts, wait.intervalMs);
      if (!healthy) {
        console.info('Docker health check failed, rolling back to previous image');
        const rolledBack = await this.rollback(newContainer, containerInfo, previousImage);
        return {
          success: false,
          previousImage,
          newImage: this.config.imageName,
          error: 'Health check failed after update',
          rolledBack,
        };
      }

      const httpHealthy = await this.healthReporter.checkAgentHealth();
      if (!httpHealthy) {
        console.info('Agent HTTP health check failed, rolling back to previous image');
        const rolledBack = await this.rollback(newContainer, containerInfo, previousImage);
        return {
          success: false,
          previousImage,
          newImage: this.config.imageName,
          error: 'Agent HTTP health check failed after update',
          rolledBack,
        };
      }

      console.info(`Successfully updated to ${this.config.imageName}`);
      return {
        success: true,
        previousImage,
        newImage: this.config.imageName,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Update failed: ${message}`);

      if (teardownCompleted && previousImage && containerInfo) {
        console.info('Attempting rollback after mid-update failure');
        const rolledBack = await this.rollback(undefined, containerInfo, previousImage);
        return {
          success: false,
          previousImage,
          newImage: this.config.imageName,
          error: message,
          rolledBack,
        };
      }

      return {
        success: false,
        previousImage,
        newImage: this.config.imageName,
        error: message,
      };
    }
  }

  private extractDigest(imageId: string): string {
    if (imageId.includes('@')) {
      return imageId.split('@')[1];
    }
    return imageId;
  }

  private async resolvePreviousImageRef(containerInfo: Dockerode.ContainerInspectInfo): Promise<string> {
    try {
      const imageInfo = await this.docker.getImage(containerInfo.Image).inspect();
      const digestRef = imageInfo.RepoDigests?.[0];
      if (digestRef) {
        return digestRef;
      }
    } catch {
      // Fall through to the image ID below.
    }
    return containerInfo.Image;
  }

  private async resolveHealthWaitParams(): Promise<HealthWaitParams> {
    let derived: HealthWaitParams;
    try {
      const imageInfo = await this.docker.getImage(this.config.imageName).inspect();
      derived = deriveHealthWaitParams(imageInfo.Config?.Healthcheck);
    } catch {
      derived = deriveHealthWaitParams(undefined);
    }
    return {
      maxAttempts: this.config.healthCheckMaxAttempts ?? derived.maxAttempts,
      intervalMs: this.config.healthCheckIntervalMs ?? derived.intervalMs,
    };
  }

  private async pullImage(imageName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.docker.pull(imageName, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) {
          reject(err);
          return;
        }
        this.docker.modem.followProgress(stream, (progressErr: Error | null) => {
          if (progressErr) {
            reject(progressErr);
          } else {
            resolve();
          }
        });
      });
    });
  }

  private buildContainerOptions(
    image: string,
    info: Dockerode.ContainerInspectInfo
  ): Dockerode.ContainerCreateOptions {
    return {
      name: this.config.containerName,
      Image: image,
      // CI stamps AGENT_VERSION into the image; carrying the old one would
      // freeze the version the agent reports after an update.
      Env: info.Config.Env?.filter((entry) => !entry.startsWith('AGENT_VERSION=')),
      Cmd: info.Config.Cmd,
      Entrypoint: info.Config.Entrypoint,
      HostConfig: info.HostConfig,
      ExposedPorts: info.Config.ExposedPorts,
      Labels: info.Config.Labels,
      NetworkingConfig: {
        EndpointsConfig: info.NetworkSettings.Networks as Record<
          string,
          Dockerode.EndpointSettings
        >,
      },
    };
  }

  private async recreateContainer(
    previousInfo: Dockerode.ContainerInspectInfo
  ): Promise<Dockerode.Container> {
    const createOptions = this.buildContainerOptions(this.config.imageName, previousInfo);
    return this.docker.createContainer(createOptions);
  }

  private async waitForHealthy(
    container: Dockerode.Container,
    maxAttempts = 10,
    intervalMs = 3000
  ): Promise<boolean> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const info = await container.inspect();
        const healthStatus = info.State.Health?.Status;
        if (healthStatus === 'healthy') {
          return true;
        }
        if (healthStatus === 'unhealthy') {
          return false;
        }
        if (healthStatus === undefined) {
          // No healthcheck defined; consider running as healthy
          if (info.State.Running) {
            return true;
          }
        }
      } catch {
        // Container may not be ready yet
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  private async rollback(
    failedContainer: Dockerode.Container | undefined,
    previousInfo: Dockerode.ContainerInspectInfo,
    previousImage: string
  ): Promise<boolean> {
    try {
      if (failedContainer) {
        try {
          await failedContainer.stop();
        } catch {
          // May already be stopped
        }
        try {
          await failedContainer.remove();
        } catch {
          // May already be removed
        }
      }

      const rollbackOptions = this.buildContainerOptions(previousImage, previousInfo);
      const rolledBackContainer = await this.docker.createContainer(rollbackOptions);
      await rolledBackContainer.start();
      console.info(`Rolled back to previous image: ${previousImage}`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Rollback failed: ${message}`);
      return false;
    }
  }
}
