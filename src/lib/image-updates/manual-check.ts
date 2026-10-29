import type { ImageUpdateSummary } from '@/types/image-updates';
import { clearImageUpdateSummaryCache, loadCheckRepository, loadStackContainers } from './image-update-service';
import { groupStackContainersByImage } from './snapshot-groups';
import { checkAndPersistImage } from './check-run';
import { imageUpdateBroadcastService, type ImageUpdateChangedEvent } from '@/lib/stacks/image-update-broadcast-service';

export interface ManualCheckResult {
  summaries: ImageUpdateSummary[];
  checked: number;
  changed: number;
  failed: number;
}

/** One manual check per (host, stack, image) at a time; concurrent callers join the running one. */
const inFlight = new Map<string, Promise<ManualCheckResult>>();

/** How long a completed update waits before re-checking the stack's images, so the container snapshot carries the recreated containers. */
const POST_UPDATE_CHECK_DELAY_MS = 5_000;

/**
 * Re-check a stack's images (or a single image) on demand, writing through to
 * the persisted rows and broadcasting changed verdicts. Unlike the scheduled
 * refresher it does not touch rows for other stacks' images.
 */
export async function runManualImageUpdateCheck(stack: string, host: string, image?: string): Promise<ManualCheckResult> {
  const key = host + '/' + stack + '|' + (image ?? '');
  const existing = inFlight.get(key);
  if (existing) return existing;
  const run = performCheck(stack, host, image).finally(() => {
    inFlight.delete(key);
  });
  inFlight.set(key, run);
  return run;
}

async function performCheck(stack: string, host: string, image?: string): Promise<ManualCheckResult> {
  const containers = await loadStackContainers(stack, host);
  const groups = groupStackContainersByImage(containers);
  const target = image === undefined ? groups : groups.filter((group) => group.image === image);

  const repo = await loadCheckRepository();
  const rows = await repo.getByHost(host);
  const rowsByImage = new Map(rows.map((row) => [row.image, row]));
  const now = new Date();

  const outcomes = await Promise.all(
    target.map((group) => checkAndPersistImage(group, rowsByImage.get(group.image) ?? null, repo, now)),
  );

  clearImageUpdateSummaryCache();
  const changedEvents: ImageUpdateChangedEvent[] = [];
  for (const outcome of outcomes) {
    if (outcome.changed) {
      changedEvents.push({
        stack,
        host,
        image: outcome.summary.image,
        updateAvailable: outcome.summary.updateAvailable,
        latestMatchingTag: outcome.summary.latestMatchingTag,
      });
    }
  }
  if (changedEvents.length > 0) {
    imageUpdateBroadcastService.publish(changedEvents);
  }

  const summaries = outcomes.map((outcome) => ({ ...outcome.summary, checkedAt: now.toISOString() }));
  summaries.sort((a, b) => a.image.localeCompare(b.image));
  return {
    summaries,
    checked: outcomes.filter((outcome) => outcome.summary.error === null).length,
    changed: changedEvents.length,
    failed: outcomes.filter((outcome) => outcome.summary.error !== null).length,
  };
}

/**
 * Fire-and-forget re-check after a successful image update, so the panel
 * converges to what was actually pulled instead of waiting out the refresher
 * interval. The delay lets the container snapshot carry the recreated containers.
 */
export function schedulePostUpdateCheck(stack: string, host: string, delayMs: number = POST_UPDATE_CHECK_DELAY_MS): void {
  setTimeout(() => {
    void runManualImageUpdateCheck(stack, host)
      .catch((err: unknown) => {
        console.error(`[image-updates] post-update check failed for ${host}/${stack}:`, err);
      });
  }, delayMs);
}
