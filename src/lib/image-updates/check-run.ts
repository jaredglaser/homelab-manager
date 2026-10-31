import type { ImageUpdateCheckRepository, ImageUpdateCheckRow } from '@/lib/database/repositories/image-update-check-repository';
import type { StackImageGroup } from './snapshot-groups';
import { checkImageUpdateWithMeta } from './registry-client';
import type { ImageUpdateSummary } from '@/types/image-updates';

export interface ImageCheckOutcome {
  summary: ImageUpdateSummary;
  changed: boolean;
}

/**
 * Check one image against its registry and persist the verdict, mirroring the
 * scheduled refresher so manual and automatic checks produce identical rows:
 * a registry failure keeps the last good data and moves only the error
 * columns, while a DB write failure propagates to the caller.
 */
export async function checkAndPersistImage(
  group: StackImageGroup,
  prior: ImageUpdateCheckRow | null,
  repo: ImageUpdateCheckRepository,
  now: Date,
): Promise<ImageCheckOutcome> {
  let summary: ImageUpdateSummary;
  let etag: string | null = null;
  try {
    const result = await checkImageUpdateWithMeta(
      group.image,
      group.labels,
      group.imageDigest,
      prior?.etag ?? null,
    );
    summary = result.summary;
    etag = result.etag;
  } catch (err) {
    summary = {
      image: group.image,
      currentTag: null,
      latestMatchingTag: null,
      latestOverallTag: null,
      updateAvailable: null,
      sourceRepo: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (summary.error !== null) {
    await repo.upsertFailure(group.host, group.image, summary.error, now);
    return { summary, changed: false };
  }
  await repo.upsertSuccess({
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
  const changed = prior !== null
    && (prior.updateAvailable !== summary.updateAvailable || prior.latestMatchingTag !== summary.latestMatchingTag);
  return { summary, changed };
}
