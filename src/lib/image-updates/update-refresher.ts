import type { DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';
import type { ImageUpdateCheckRepository, ImageUpdateCheckRow } from '@/lib/database/repositories/image-update-check-repository';
import { checkAndPersistImage } from './check-run';
import { groupStackContainersByImage } from './snapshot-groups';
import { imageUpdateBroadcastService, type ImageUpdateChangedEvent } from '@/lib/stacks/image-update-broadcast-service';
import { clearImageUpdateSummaryCache } from './image-update-service';

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

/** Next tick runs one interval after the newest persisted checked_at, so restarts do not reset its phase. */
export class ImageUpdateRefresher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private starting = false;

  constructor(private readonly deps: ImageUpdateRefresherDeps) {}

  /** Idempotent. Runs a catch-up tick only when rows are missing or stale, then schedules from the wall clock. */
  async start(): Promise<void> {
    if (this.timer !== null || this.starting) return;
    this.starting = true;
    try {
      const rows = await this.deps.repo.getAll();
      const cutoff = new Date(Date.now() - this.deps.intervalMs);
      const stale = rows.length === 0 || rows.some((row) => row.checkedAt < cutoff);
      if (stale) {
        await this.tickAndReschedule();
        return;
      }
      this.scheduleFrom(rows);
    } finally {
      this.starting = false;
    }
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
      this.tickAndReschedule().catch((err: unknown) => {
        console.error('[image-updates] scheduled tick failed:', err);
      });
    }, delayMs);
  }

  private async tickAndReschedule(): Promise<RefreshTickResult | null> {
    this.timer = null;
    const anchor = Date.now();
    try {
      return await this.tick();
    } finally {
      this.schedule(Math.max(0, anchor + this.deps.intervalMs - Date.now()));
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
      const prior = byKey.get(group.host + '/' + group.image) ?? null;
      const outcome = await checkAndPersistImage(group, prior, this.deps.repo, now);
      if (outcome.summary.error !== null) {
        failed++;
      } else {
        checked++;
      }
      if (outcome.changed) {
        changed++;
        changedEvents.push({
          stack: group.stack,
          host: group.host,
          image: group.image,
          updateAvailable: outcome.summary.updateAvailable,
          latestMatchingTag: outcome.summary.latestMatchingTag,
        });
      }
    }

    await this.deps.repo.deleteMissing(groups.map((group) => ({ host: group.host, image: group.image })));
    clearImageUpdateSummaryCache();
    if (changedEvents.length > 0) {
      imageUpdateBroadcastService.publish(changedEvents);
    }
    return { checked, changed, failed };
  }
}
