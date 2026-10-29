import type { DockerContainerEventRow, DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';
import { BoundedCache } from '@/lib/bounded-cache';
import type { ImageChangelog, ImageUpdateSummary } from '@/types/image-updates';
import { checkImageUpdateWithMeta, sourceRepoFromLabels } from './registry-client';
import { fetchGitHubReleases } from './github-releases';
import { groupStackContainersByImage } from './snapshot-groups';
import { DEFAULT_REFRESH_INTERVAL_MS, loadImageUpdateRefresherConfig, staleThresholdMs } from './refresher-config';
import type { ImageUpdateCheckRepository, ImageUpdateCheckRow } from '@/lib/database/repositories/image-update-check-repository';

const SUMMARY_CACHE_TTL_MS = 5 * 60_000;
const CHANGELOG_CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX_ENTRIES = 300;

const summaryCache = new BoundedCache<ImageUpdateSummary[]>(CACHE_MAX_ENTRIES);

/** Drops every cached summary so the next read reflects freshly persisted rows. */
export function clearImageUpdateSummaryCache(): void {
  summaryCache.clear();
}
const changelogCache = new BoundedCache<ImageChangelog>(CACHE_MAX_ENTRIES);

async function loadStackContainers(stack: string, host: string): Promise<DockerContainerEventUpsertRow[]> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { DockerContainerEventRepository } = await import(
    '@/lib/database/repositories/docker-container-event-repository'
  );
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  const repo = new DockerContainerEventRepository(client.getPool());
  const rows: DockerContainerEventRow[] = await repo.getCurrentSnapshot();
  return rows.filter(
    (row): row is DockerContainerEventUpsertRow =>
      row.eventType === 'upsert' && row.host === host && row.composeProject === stack,
  );
}

async function loadCheckRepository(): Promise<ImageUpdateCheckRepository> {
  const { loadDatabaseConfig } = await import('@/lib/config/database-config');
  const { databaseConnectionManager } = await import('@/lib/clients/database-client');
  const { ImageUpdateCheckRepository } = await import(
    '@/lib/database/repositories/image-update-check-repository'
  );
  const config = loadDatabaseConfig();
  const client = await databaseConnectionManager.getClient(config);
  return new ImageUpdateCheckRepository(client.getPool());
}

function rowToSummary(row: ImageUpdateCheckRow): ImageUpdateSummary {
  return {
    image: row.image,
    currentTag: row.currentTag,
    latestMatchingTag: row.latestMatchingTag,
    latestOverallTag: row.latestOverallTag,
    updateAvailable: row.updateAvailable,
    sourceRepo: row.sourceRepo,
    error: row.error,
    checkedAt: row.checkedAt.toISOString(),
  };
}

export async function getImageUpdateSummaries(stack: string, host: string): Promise<ImageUpdateSummary[]> {
  const cacheKey = host + '/' + stack;
  const cached = summaryCache.get(cacheKey);
  if (cached) return cached;

  const containers = await loadStackContainers(stack, host);
  const groups = groupStackContainersByImage(containers);
  if (groups.length === 0) {
    const empty: ImageUpdateSummary[] = [];
    summaryCache.set(cacheKey, empty, SUMMARY_CACHE_TTL_MS);
    return empty;
  }

  const now = new Date();
  const checkRepo = await loadCheckRepository();
  // Persisted rows are the fast path. A read failure falls through to the live check.
  let rowsByImage = new Map<string, ImageUpdateCheckRow>();
  try {
    const rows = await checkRepo.getByHost(host);
    rowsByImage = new Map(rows.map((row) => [row.image, row]));
  } catch (err) {
    console.error('[image-updates] failed to read persisted update checks, falling back to a live check:', err);
  }

  // A malformed interval fails the refresher at startup but must not take panel reads down with it.
  let intervalMs = DEFAULT_REFRESH_INTERVAL_MS;
  try {
    intervalMs = loadImageUpdateRefresherConfig().intervalMs;
  } catch {
    intervalMs = DEFAULT_REFRESH_INTERVAL_MS;
  }
  const freshCutoff = now.getTime() - staleThresholdMs({ intervalMs });
  const allFresh = groups.every((group) => {
    const row = rowsByImage.get(group.image);
    return row !== undefined && row.error === null && row.checkedAt.getTime() > freshCutoff;
  });

  if (allFresh) {
    const summaries = groups.map((group) => rowToSummary(rowsByImage.get(group.image)!));
    summaries.sort((a, b) => a.image.localeCompare(b.image));
    summaryCache.set(cacheKey, summaries, SUMMARY_CACHE_TTL_MS);
    return summaries;
  }

  const results = await Promise.all(
    groups.map((group) =>
      checkImageUpdateWithMeta(group.image, group.labels, group.imageDigest, rowsByImage.get(group.image)?.etag ?? null),
    ),
  );
  const summaries = results.map((result) => ({
    ...result.summary,
    checkedAt: now.toISOString(),
  }));
  summaries.sort((a, b) => a.image.localeCompare(b.image));

  // Write-through is best effort. A failed persist must not break the read.
  try {
    for (let i = 0; i < results.length; i++) {
      const { summary, etag } = results[i];
      if (summary.error !== null) {
        await checkRepo.upsertFailure(host, summary.image, summary.error, now);
      } else {
        await checkRepo.upsertSuccess({
          host,
          image: summary.image,
          currentTag: summary.currentTag,
          latestMatchingTag: summary.latestMatchingTag,
          latestOverallTag: summary.latestOverallTag,
          updateAvailable: summary.updateAvailable,
          sourceRepo: summary.sourceRepo,
          etag,
          checkedAt: now,
        });
      }
    }
  } catch (err) {
    console.error('[image-updates] failed to persist update checks:', err);
  }

  // Failures stay uncached: caching would pin a registry outage's error in the panel for the full TTL.
  if (summaries.every((summary) => summary.error === null)) {
    summaryCache.set(cacheKey, summaries, SUMMARY_CACHE_TTL_MS);
  }
  return summaries;
}

export async function getImageChangelog(stack: string, host: string, image: string): Promise<ImageChangelog> {
  const cacheKey = host + '/' + stack + '|' + image;
  const cached = changelogCache.get(cacheKey);
  if (cached) return cached;

  const containers = await loadStackContainers(stack, host);
  const labels =
    containers.find((c) => c.image === image && sourceRepoFromLabels(c.labels))?.labels
    ?? containers.find((c) => c.image === image)?.labels
    ?? {};
  const sourceRepo = sourceRepoFromLabels(labels);

  const changelog: ImageChangelog = { image, sourceRepo, releases: [], error: null };
  if (!sourceRepo) {
    changelog.error = 'No GitHub source repository found for this image.';
  } else {
    try {
      changelog.releases = await fetchGitHubReleases(sourceRepo);
    } catch (err) {
      changelog.error = err instanceof Error ? err.message : String(err);
    }
  }
  // Failures stay uncached: caching would pin a rate-limit error in the dialog for the full hour.
  if (changelog.error === null) {
    changelogCache.set(cacheKey, changelog, CHANGELOG_CACHE_TTL_MS);
  }
  return changelog;
}
