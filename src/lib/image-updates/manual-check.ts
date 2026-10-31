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
  /** Images whose verdict moved in this run, so a single-image caller can scope the count. */
  changedImages?: string[];
}

/** One manual check per (host, stack) at a time; concurrent callers join the running one. */
interface InFlightRun {
  promise: Promise<ManualCheckResult>;
  generation: number;
  image: string | undefined;
}
const inFlight = new Map<string, InFlightRun>();
const generations = new Map<string, number>();

/**
 * Bumps the per-stack check generation: in-flight runs started before the bump
 * are stale, so a scheduled post-update check chains after them instead of
 * joining a run that read the pre-update snapshot.
 */
export function bumpCheckGeneration(host: string, stack: string): void {
  const key = host + '/' + stack;
  generations.set(key, (generations.get(key) ?? 0) + 1);
}

function scopeResult(result: ManualCheckResult, image: string | undefined): ManualCheckResult {
  if (image === undefined) return result;
  const summaries = result.summaries.filter((summary) => summary.image === image);
  return {
    summaries,
    checked: summaries.filter((summary) => summary.error === null).length,
    changed: (result.changedImages ?? []).filter((changed) => changed === image).length,
    failed: summaries.filter((summary) => summary.error !== null).length,
    changedImages: (result.changedImages ?? []).filter((changed) => changed === image),
  };
}

export async function runManualImageUpdateCheck(stack: string, host: string, image?: string): Promise<ManualCheckResult> {
  const key = host + '/' + stack;
  const generation = generations.get(key) ?? 0;
  const existing = inFlight.get(key);
  if (existing && existing.generation === generation && (existing.image === undefined || existing.image === image)) {
    return scopeResult(await existing.promise, image);
  }
  if (existing) {
    // A stale-generation or different-scope run: let it settle, then run fresh.
    await existing.promise.catch(() => {});
  }
  const current = inFlight.get(key);
  if (current && current.generation === generation && (current.image === undefined || current.image === image)) {
    return scopeResult(await current.promise, image);
  }
  const run = performCheck(stack, host, image).finally(() => {
    if (inFlight.get(key)?.promise === run) inFlight.delete(key);
  });
  inFlight.set(key, { promise: run, generation, image });
  return scopeResult(await run, image);
}

async function performCheck(stack: string, host: string, image?: string): Promise<ManualCheckResult> {
  const containers = await loadStackContainers(stack, host);
  const groups = groupStackContainersByImage(containers);
  const target = image === undefined ? groups : groups.filter((group) => group.image === image);

  const repo = await loadCheckRepository();
  const rows = await repo.getByStack(host, stack);
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
    changedImages: changedEvents.map((event) => event.image),
  };
}
