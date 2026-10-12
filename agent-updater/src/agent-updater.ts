import type Dockerode from 'dockerode';
import type { HealthReporter } from './health-reporter';

export interface AgentUpdaterConfig {
  containerName: string;
  selfContainerName: string;
  imageName: string;
  // Port the sidecar's own trigger server listens on, used to verify a replacement before handing over.
  selfTriggerPort?: number;
  // Bounds for the replacement-serving poll; the defaults suit a real deployment, tests shrink them.
  selfVerify?: { maxAttempts: number; intervalMs: number };
  healthCheckMaxAttempts?: number;
  healthCheckIntervalMs?: number;
}

export interface UpdateCheckResult {
  upToDate: boolean;
  currentDigest?: string;
  targetDigest?: string;
  // Set when the check itself failed (registry or Docker unreachable): the caller must not treat this as "update available".
  checkFailed?: boolean;
}

export interface UpdateResult {
  success: boolean;
  previousImage?: string;
  newImage?: string;
  error?: string;
  rolledBack?: boolean;
}

export interface SelfRecreateResult {
  recreated: boolean;
  /** Why the recreate was skipped when recreated is false and nothing failed. */
  reason?: string;
  error?: string;
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

  /** True when the running image already matches the target (manager-supplied or configured). */
  async isUpToDate(targetImage?: string): Promise<UpdateCheckResult> {
    try {
      const container = this.docker.getContainer(this.config.containerName);
      const containerInfo = await container.inspect();

      const image = this.docker.getImage(containerInfo.Image);
      const imageInfo = await image.inspect();
      const currentDigest = this.extractDigest(
        imageInfo.RepoDigests?.[0] ?? containerInfo.Image
      );

      const remoteImage = this.docker.getImage(targetImage ?? this.config.imageName);
      const distribution = await remoteImage.distribution();
      const remoteDigest = distribution.Descriptor?.digest as string | undefined;

      if (!remoteDigest) {
        return { upToDate: true, currentDigest };
      }

      const upToDate = currentDigest === remoteDigest;
      return { upToDate, currentDigest, targetDigest: remoteDigest };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Failed to check for update: ${message}`);
      return { upToDate: false, checkFailed: true };
    }
  }

  /** Pull new image, stop old container, recreate with same config, verify health. Rolls back on failure. */
  async performUpdate(targetImage?: string): Promise<UpdateResult> {
    const image = targetImage ?? this.config.imageName;
    let previousImage: string | undefined;
    let containerInfo: Dockerode.ContainerInspectInfo | undefined;
    let teardownCompleted = false;

    try {
      const container = this.docker.getContainer(this.config.containerName);
      containerInfo = await container.inspect();
      // Pin by digest or image ID: after the pull the old tag resolves to the
      // new image, which would make rollback a no-op.
      previousImage = await this.resolvePreviousImageRef(containerInfo);

      console.info(`Pulling new image: ${image}`);
      await this.pullImage(image);

      console.info(`Stopping container: ${this.config.containerName}`);
      await container.stop();
      await container.remove();
      teardownCompleted = true;

      console.info(`Creating container: ${this.config.containerName}`);
      const newContainer = await this.recreateContainer(containerInfo, image);
      await newContainer.start();

      const wait = await this.resolveHealthWaitParams(image);
      const healthy = await this.waitForHealthy(newContainer, wait.maxAttempts, wait.intervalMs);
      if (!healthy) {
        console.info('Docker health check failed, rolling back to previous image');
        const rolledBack = await this.rollback(newContainer, containerInfo, previousImage);
        return {
          success: false,
          previousImage,
          newImage: image,
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
          newImage: image,
          error: 'Agent HTTP health check failed after update',
          rolledBack,
        };
      }

      console.info(`Successfully updated to ${image}`);
      return {
        success: true,
        previousImage,
        newImage: image,
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
          newImage: image,
          error: message,
          rolledBack,
        };
      }

      return {
        success: false,
        previousImage,
        newImage: image,
        error: message,
      };
    }
  }

  /**
   * Hand the sidecar's own container to a new image: docker's stop waits for this process to exit, so the handover renames the live container out of the canonical name and starts a replacement under it.
   * No rollback: a failed recreate leaves the old sidecar running under its restart policy.
   */
  async recreateSelf(newImage?: string): Promise<SelfRecreateResult> {
    const image = newImage ?? this.config.imageName;
    const targetDigest = image.includes('@') ? image.split('@')[1] : undefined;
    try {
      const container = this.docker.getContainer(this.config.selfContainerName);
      const containerInfo = await container.inspect();
      const runningDigest = await this.resolveRunningDigest(containerInfo);
      if (targetDigest && runningDigest === targetDigest) {
        console.info('Sidecar already runs the target digest, self-recreate skipped');
        return { recreated: false, reason: 'sidecar already runs the target digest' };
      }

      console.info(`Pulling new sidecar image: ${image}`);
      await this.pullImage(image);
      // The retired container must not be resurrected by its restart policy once this process exits.
      await container.update({ RestartPolicy: { Name: 'no' } }).catch((error) => {
        console.error('Disabling the retired sidecar restart policy failed:', error instanceof Error ? error.message : error);
      });
      const retiredName = `${this.config.selfContainerName}-old`;
      console.info(`Renaming current sidecar container to ${retiredName}`);
      await container.rename({ name: retiredName });
      let newContainer: Dockerode.Container;
      try {
        console.info(`Creating replacement sidecar container: ${this.config.selfContainerName}`);
        newContainer = await this.docker.createContainer(
          this.buildContainerOptions(image, containerInfo, this.config.selfContainerName),
        );
      } catch (error) {
        await this.renameRetiredBack(container);
        throw error;
      }
      try {
        await newContainer.start();
      } catch (error) {
        // The stopped replacement holds the canonical name: remove it or the rename-back collides.
        await newContainer.remove({ force: true }).catch(() => {});
        await this.renameRetiredBack(container);
        throw error;
      }
      if (!(await this.waitForReplacementServing(newContainer))) {
        console.error('Replacement sidecar did not start serving, rolling the handover back');
        await newContainer.stop().catch(() => {});
        await newContainer.remove({ force: true }).catch(() => {});
        await this.renameRetiredBack(container);
        return { recreated: false, error: 'Replacement sidecar did not start serving the trigger endpoint' };
      }
      console.info(`Sidecar recreated from ${image}: the new container takes over`);
      return { recreated: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Sidecar self-recreate failed: ${message}`);
      return { recreated: false, error: message };
    }
  }

  private async renameRetiredBack(retired: Dockerode.Container): Promise<void> {
    try {
      await retired.rename({ name: this.config.selfContainerName });
    } catch (error) {
      console.error('Renaming the retired sidecar back to its canonical name failed:', error instanceof Error ? error.message : error);
    }
  }

  private async waitForReplacementServing(replacement: Dockerode.Container): Promise<boolean> {
    const triggerPort = this.config.selfTriggerPort ?? 9091;
    const maxAttempts = this.config.selfVerify?.maxAttempts ?? 20;
    const intervalMs = this.config.selfVerify?.intervalMs ?? 500;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const info = await replacement.inspect();
        const ipAddress = Object.values(info.NetworkSettings.Networks)[0]?.IPAddress;
        if (ipAddress) {
          const response = await fetch(`http://${ipAddress}:${triggerPort}/trigger`, { signal: AbortSignal.timeout(2000) });
          // 405 Method Not Allowed proves the replacement's trigger server is up: GET is rejected before auth.
          if (response.status === 405) return true;
        }
      } catch {
        // Not up yet: keep polling until the window closes.
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    return false;
  }

  /**
   * Remove the container a previous self-recreate retired. Best-effort and
   * quiet: a leftover keeps serving with the old image only until this runs.
   */
  async removeRetiredSelf(): Promise<void> {
    const retiredName = `${this.config.selfContainerName}-old`;
    try {
      const container = this.docker.getContainer(retiredName);
      await container.inspect();
      await container.stop().catch(() => {});
      await container.remove();
      console.info(`Removed retired sidecar container ${retiredName}`);
    } catch {
      // No leftover: the common case after a clean recreate or a fresh deploy.
    }
  }

  private async resolveRunningDigest(containerInfo: Dockerode.ContainerInspectInfo): Promise<string> {
    try {
      const imageInfo = await this.docker.getImage(containerInfo.Image).inspect();
      const digestRef = imageInfo.RepoDigests?.[0];
      if (digestRef) {
        return this.extractDigest(digestRef);
      }
    } catch {
    }
    return this.extractDigest(containerInfo.Image);
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
    }
    return containerInfo.Image;
  }

  private async resolveHealthWaitParams(image: string): Promise<HealthWaitParams> {
    let derived: HealthWaitParams;
    try {
      const imageInfo = await this.docker.getImage(image).inspect();
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
    info: Dockerode.ContainerInspectInfo,
    containerName: string = this.config.containerName,
  ): Dockerode.ContainerCreateOptions {
    return {
      name: containerName,
      Image: image,
      // CI stamps AGENT_VERSION into the image. Carrying the old one would
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
    previousInfo: Dockerode.ContainerInspectInfo,
    image: string
  ): Promise<Dockerode.Container> {
    const createOptions = this.buildContainerOptions(image, previousInfo);
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
