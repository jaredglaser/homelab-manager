import type { DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';
import type { ImageUpdateCheckRepository, ImageUpdateCheckRow } from '@/lib/database/repositories/image-update-check-repository';
import { checkImageUpdateWithMeta } from './registry-client';
import { groupStackContainersByImage } from './snapshot-groups';
import { imageUpdateBroadcastService, type ImageUpdateChangedEvent } from '@/lib/stacks/image-update-broadcast-service';

export interface ImageUpdateRefresherDeps {
  repo: ImageUpdateCheckRepository;
  loadContainers: () => Promise<DockerContainerEventUpsertRow[]>;
  intervalMs: number;
}

export interface RefreshTickResult {
  checked: number;
  changed: number;
  failed: number;
}

/**
 * Clock-anchored scheduled refresher: the next tick runs one interval after
 * the newest persisted checked_at, never interval-after-restart. A runtime
 * setInterval would reset its phase on every deploy and stretch the real
 * cadence toward twice the interval when deploys are frequent.
 */
export class ImageUpdateRefresher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private readonly deps: ImageUpdateRefresherDeps) {}

  /** Idempotent. Runs a catch-up tick only when rows are missing or stale, then schedules from the wall clock. */
  async start(): Promise<void> {
    if (this.timer !== null) return;
    const rows = await this.deps.repo.getAll();
    const cutoff = new Date(Date.now() - this.deps.intervalMs);
    const stale = rows.length === 0 || rows.some((row) => row.checkedAt < cutoff);
    if (stale) {
      await this.tickAndReschedule();
      return;
    }
    this.scheduleFrom(rows);
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Reentrancy-guarded. Returns null when a previous tick is still running. */
  async tick(): Promise<RefreshTickResult | null> {
    if (this.running) return null;
    this.running = true;
    try {
      return await this.runTick();
    } finally {
      this.running = false;
    }
  }

  private scheduleFrom(rows: ImageUpdateCheckRow[]): void {
    const latest = rows.reduce((max, row) => Math.max(max, row.checkedAt.getTime()), 0);
    this.schedule(Math.max(0, latest + this.deps.intervalMs - Date.now()));
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      void this.tickAndReschedule();
    }, delayMs);
  }

  private async tickAndReschedule(): Promise<RefreshTickResult | null> {
    this.timer = null;
    try {
      return await this.tick();
    } finally {
      this.schedule(this.deps.intervalMs);
    }
  }

  private async runTick(): Promise<RefreshTickResult> {
    const containers = await this.deps.loadContainers();
    const groups = groupStackContainersByImage(containers);
    const rows = await this.deps.repo.getAll();
    const byKey = new Map(rows.map((row) => [row.host + '/' + row.image, row]));
    const now = new Date();

    let checked = 0;
    let changed = 0;
    let failed = 0;
    const changedEvents: ImageUpdateChangedEvent[] = [];

    for (const group of groups) {
      const prior = byKey.get(group.host + '/' + group.image);
      try {
        const { summary, etag } = await checkImageUpdateWithMeta(
          group.image,
          group.labels,
          group.imageDigest,
          prior?.etag ?? null,
        );
        if (summary.error !== null) {
          failed++;
          await this.deps.repo.upsertFailure(group.host, group.image, summary.error, now);
          continue;
        }
        checked++;
        await this.deps.repo.upsertSuccess({
          host: group.host,
          image: group.image,
          currentTag: summary.currentTag,
          latestMatchingTag: summary.latestMatchingTag,
          latestOverallTag: summary.latestOverallTag,
          updateAvailable: summary.updateAvailable,
          sourceRepo: summary.sourceRepo,
          etag,
          checkedAt: now,
        });
        if (prior && (prior.updateAvailable !== summary.updateAvailable || prior.latestMatchingTag !== summary.latestMatchingTag)) {
          changed++;
          changedEvents.push({
            stack: group.stack,
            host: group.host,
            image: group.image,
            updateAvailable: summary.updateAvailable,
            latestMatchingTag: summary.latestMatchingTag,
          });
        }
      } catch (err) {
        failed++;
        await this.deps.repo.upsertFailure(
          group.host,
          group.image,
          err instanceof Error ? err.message : String(err),
          now,
        );
      }
    }

    await this.deps.repo.deleteMissing(groups.map((group) => ({ host: group.host, image: group.image })));
    if (changedEvents.length > 0) {
      imageUpdateBroadcastService.publish(changedEvents);
    }
    return { checked, changed, failed };
  }
}
