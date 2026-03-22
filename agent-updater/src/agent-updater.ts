import type Dockerode from 'dockerode';

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

/** Polls GHCR for new image digests and recreates the agent container when updates are available. */
export class AgentUpdater {
  private docker: Dockerode;
  private config: AgentUpdaterConfig;

  constructor(docker: Dockerode, config: AgentUpdaterConfig) {
    this.docker = docker;
    this.config = config;
  }

  /** Check whether a newer image digest is available on the registry. */
  async checkForUpdate(): Promise<UpdateCheckResult> {
    try {
      const container = this.docker.getContainer(this.config.containerName);
      const containerInfo = await container.inspect();
      const currentDigest = this.extractDigest(containerInfo.Image);

      const image = this.docker.getImage(this.config.imageName);
      const distribution = await image.distribution();
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

    try {
      const container = this.docker.getContainer(this.config.containerName);
      const containerInfo = await container.inspect();
      previousImage = containerInfo.Config.Image;

      console.info(`Pulling new image: ${this.config.imageName}`);
      await this.pullImage(this.config.imageName);

      console.info(`Stopping container: ${this.config.containerName}`);
      await container.stop();
      await container.remove();

      console.info(`Creating container: ${this.config.containerName}`);
      const newContainer = await this.recreateContainer(containerInfo);
      await newContainer.start();

      const healthy = await this.waitForHealthy(
        newContainer,
        this.config.healthCheckMaxAttempts,
        this.config.healthCheckIntervalMs
      );
      if (!healthy) {
        console.info('Health check failed, rolling back to previous image');
        await this.rollback(newContainer, containerInfo, previousImage);
        return {
          success: false,
          previousImage,
          newImage: this.config.imageName,
          error: 'Health check failed after update',
          rolledBack: true,
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

  private async recreateContainer(
    previousInfo: Dockerode.ContainerInspectInfo
  ): Promise<Dockerode.Container> {
    const createOptions: Dockerode.ContainerCreateOptions = {
      name: this.config.containerName,
      Image: this.config.imageName,
      Env: previousInfo.Config.Env,
      HostConfig: previousInfo.HostConfig,
      ExposedPorts: previousInfo.Config.ExposedPorts,
      Labels: previousInfo.Config.Labels,
      NetworkingConfig: {
        EndpointsConfig: previousInfo.NetworkSettings.Networks as Record<
          string,
          Dockerode.EndpointSettings
        >,
      },
    };

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
        if (healthStatus === undefined) {
          // No healthcheck defined — consider running as healthy
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
    failedContainer: Dockerode.Container,
    previousInfo: Dockerode.ContainerInspectInfo,
    previousImage: string
  ): Promise<void> {
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

    const rollbackOptions: Dockerode.ContainerCreateOptions = {
      name: this.config.containerName,
      Image: previousImage,
      Env: previousInfo.Config.Env,
      HostConfig: previousInfo.HostConfig,
      ExposedPorts: previousInfo.Config.ExposedPorts,
      Labels: previousInfo.Config.Labels,
      NetworkingConfig: {
        EndpointsConfig: previousInfo.NetworkSettings.Networks as Record<
          string,
          Dockerode.EndpointSettings
        >,
      },
    };

    const rolledBackContainer = await this.docker.createContainer(rollbackOptions);
    await rolledBackContainer.start();
    console.info(`Rolled back to previous image: ${previousImage}`);
  }
}
