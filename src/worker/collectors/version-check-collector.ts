import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import { SETTINGS_KEYS } from '@/lib/constants/settings-keys';
import { SettingsRepository } from '@/lib/database/repositories/settings-repository';
import { abortableSleep, isAbortError } from '@/lib/utils/abortable-sleep';
import { parseDockerImage } from '@/lib/utils/docker-image';
import { fetchGitHubReleases, parseGitHubRepoUrl } from '@/lib/utils/github-api';
import type { GitHubRepo } from '@/lib/utils/github-api';
import { BaseCollector } from './base-collector';

export class VersionCheckCollector extends BaseCollector {
  readonly name = 'VersionCheck';
  private readonly settingsRepo: SettingsRepository;
  private readonly githubToken: string | undefined;
  private _triggerCheck = false;
  private _cancelCheck = false;

  constructor(
    db: DatabaseClient,
    config: WorkerConfig,
    abortController?: AbortController,
  ) {
    super(db, config, abortController);
    this.settingsRepo = new SettingsRepository(db.getPool());
    this.githubToken = process.env.GITHUB_TOKEN || undefined;
  }

  handleCommand(command: string | null): void {
    if (command === 'start') {
      this._triggerCheck = true;
    } else if (command === 'stop') {
      this._cancelCheck = true;
    }
  }

  protected async collect(): Promise<void> {
    await this.runVersionCheck();

    while (!this.signal.aborted) {
      this._triggerCheck = false;
      this._cancelCheck = false;

      try {
        const sleepEnd = Date.now() + this.config.versionCheck.interval;
        while (Date.now() < sleepEnd && !this.signal.aborted && !this._triggerCheck) {
          await abortableSleep(Math.min(5000, sleepEnd - Date.now()), this.signal);
        }
      } catch (err) {
        if (isAbortError(err)) return;
        throw err;
      }

      if (this._triggerCheck && !this.signal.aborted) {
        await this.runVersionCheck();
      }
    }
  }

  private async updateStatus(status: string, progress?: string): Promise<void> {
    try {
      await this.settingsRepo.set(SETTINGS_KEYS.versionCheck.status, status);
      if (progress !== undefined) {
        await this.settingsRepo.set(SETTINGS_KEYS.versionCheck.progress, progress);
      }
      await this.settingsRepo.set(SETTINGS_KEYS.versionCheck.command, '');
    } catch {
      // Non-critical
    }
  }

  private async runVersionCheck(): Promise<void> {
    console.info('[VersionCheck] Starting version check');
    await this.updateStatus('running', '0/0');

    try {
      const images = await this.repository.getUniqueDockerImages();
      if (images.length === 0) {
        console.info('[VersionCheck] No Docker images found, skipping');
        await this.updateStatus('idle');
        return;
      }

      const uniqueImages = new Map<string, string>();
      for (const { image, entity } of images) {
        if (!uniqueImages.has(image)) {
          uniqueImages.set(image, entity);
        }
      }

      const total = uniqueImages.size;
      let checked = 0;

      console.info(`[VersionCheck] Checking ${total} unique images`);

      for (const [image, entity] of uniqueImages) {
        if (this.signal.aborted || this._cancelCheck) {
          console.info('[VersionCheck] Cancelled');
          await this.updateStatus('idle');
          return;
        }

        await this.updateStatus('running', `${checked}/${total}`);

        try {
          await this.checkImage(image, entity);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[VersionCheck] Error checking ${image}: ${errMsg}`);
        }

        checked++;
      }

      await this.updateStatus('idle', `${total}/${total}`);
      await this.settingsRepo.set(SETTINGS_KEYS.versionCheck.lastRun, new Date().toISOString());
      console.info(`[VersionCheck] Completed, checked ${total} images`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[VersionCheck] Failed: ${errMsg}`);
      await this.updateStatus('idle');
    }
  }

  private async checkImage(image: string, entity: string): Promise<void> {
    const parsed = parseDockerImage(image);

    let githubRepo: GitHubRepo | null = null;
    let repoSource: string | null = null;

    // Check manual override first
    const override = await this.repository.getEntityMetadataValue('docker', entity, 'github_repo_override');
    if (override) {
      githubRepo = parseGitHubRepoUrl(override);
      if (githubRepo) repoSource = 'manual';
    }

    // Try OCI labels cached in entity_metadata
    if (!githubRepo) {
      const cachedSource = await this.repository.getEntityMetadataValue('docker', entity, 'oci_image_source');
      if (cachedSource) {
        githubRepo = parseGitHubRepoUrl(cachedSource);
        if (githubRepo) repoSource = 'oci_label';
      }
    }

    if (!githubRepo) {
      await this.repository.upsertContainerVersion(
        image, parsed.tag, null, false, null, null, [],
      );
      return;
    }

    const result = await fetchGitHubReleases(githubRepo, this.githubToken, this.signal);

    if (result.rateLimited) {
      console.info('[VersionCheck] Rate limited, waiting for reset');
      await this.updateStatus('rate_limited');

      if (result.rateLimit?.resetAt) {
        const waitMs = (result.rateLimit.resetAt * 1000) - Date.now() + 5000;
        if (waitMs > 0 && waitMs < 7200_000) {
          try {
            await abortableSleep(waitMs, this.signal);
          } catch {
            return;
          }
          return this.checkImage(image, entity);
        }
      }
      return;
    }

    const latestTag = result.releases.length > 0 ? result.releases[0].tag : null;
    const updateAvailable = latestTag !== null && latestTag !== parsed.tag;

    await this.repository.upsertContainerVersion(
      image,
      parsed.tag,
      latestTag,
      updateAvailable,
      `${githubRepo.owner}/${githubRepo.repo}`,
      repoSource,
      result.releases,
    );
  }
}
