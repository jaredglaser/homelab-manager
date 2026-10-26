import type { DockerContainerEventRow, DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';
import { BoundedCache } from '@/lib/bounded-cache';
import type { ImageChangelog, ImageUpdateSummary } from '@/types/image-updates';
import { checkImageUpdate, sourceRepoFromLabels } from './registry-client';
import { fetchGitHubReleases } from './github-releases';

const SUMMARY_CACHE_TTL_MS = 5 * 60_000;
const CHANGELOG_CACHE_TTL_MS = 60 * 60_000;
const CACHE_MAX_ENTRIES = 300;

const summaryCache = new BoundedCache<ImageUpdateSummary[]>(CACHE_MAX_ENTRIES);
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

export async function getImageUpdateSummaries(stack: string, host: string): Promise<ImageUpdateSummary[]> {
  const cacheKey = host + '/' + stack;
  const cached = summaryCache.get(cacheKey);
  if (cached) return cached;

  const containers = await loadStackContainers(stack, host);
  const byImage = new Map<string, { labels: Record<string, string>; imageDigest: string | null }>();
  for (const container of containers) {
    const existing = byImage.get(container.image);
    if (!existing) {
      byImage.set(container.image, { labels: container.labels, imageDigest: container.imageDigest });
    } else {
      // Prefer the container whose labels carry the source repo, and the first
      // non-null digest seen (pre-039 rows carry null).
      if (!sourceRepoFromLabels(existing.labels) && sourceRepoFromLabels(container.labels)) {
        existing.labels = container.labels;
      }
      if (!existing.imageDigest && container.imageDigest) {
        existing.imageDigest = container.imageDigest;
      }
    }
  }

  const summaries = await Promise.all(
    [...byImage.entries()].map(([image, info]) => checkImageUpdate(image, info.labels, info.imageDigest)),
  );
  // Stable ordering: Map iteration is insertion order, which follows the
  // snapshot's arbitrary container order.
  summaries.sort((a, b) => a.image.localeCompare(b.image));
  // Failures stay uncached, matching the changelog path: a registry outage
  // must not pin its error in the panel for the full TTL.
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
    changelog.error = 'No GitHub source repository found for this image';
  } else {
    try {
      changelog.releases = await fetchGitHubReleases(sourceRepo);
    } catch (err) {
      changelog.error = err instanceof Error ? err.message : String(err);
    }
  }
  // Failures stay uncached: a rate-limit or hiccup must not pin the error in
  // the dialog for an hour after the API has recovered.
  if (changelog.error === null) {
    changelogCache.set(cacheKey, changelog, CHANGELOG_CACHE_TTL_MS);
  }
  return changelog;
}