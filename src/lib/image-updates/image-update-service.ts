import type { DockerContainerEventRow, DockerContainerEventUpsertRow } from '@/lib/database/repositories/docker-container-event-repository';
import { BoundedCache } from '@/lib/bounded-cache';
import type { ImageChangelog, ImageUpdateSummary } from '@/types/image-updates';
import { checkImageUpdateWithMeta, declaredVersionFields, RELEASE_REPO_LABEL, resolveReleaseRepo } from './registry-client';
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

/** Drops one stack's cached summary; a no-op when nothing is cached. */
export function invalidateImageUpdateSummaryCache(host: string, stack: string): void {
  summaryCache.delete(host + '/' + stack);
}
const changelogCache = new BoundedCache<ImageChangelog>(CACHE_MAX_ENTRIES);

export async function loadStackContainers(stack: string, host: string): Promise<DockerContainerEventUpsertRow[]> {
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

export async function loadCheckRepository(): Promise<ImageUpdateCheckRepository> {
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
    const rows = await checkRepo.getByStack(host, stack);
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
  // Per-group classification: an errored row keeps its last good tags, so it
  // stays serveable within the freshness window instead of forcing live
  // registry checks for the whole stack. A first-ever failure (NULL tags)
  // has nothing to serve and still live-checks.
  const serveable = (row: ImageUpdateCheckRow | undefined) =>
    row !== undefined && row.checkedAt.getTime() > freshCutoff && (row.error === null || row.currentTag !== null);
  const persistedGroups = groups.filter((group) => serveable(rowsByImage.get(group.image)));
  const liveGroups = groups.filter((group) => !serveable(rowsByImage.get(group.image)));

  const persistedSummaries = persistedGroups.flatMap((group) => {
    const row = rowsByImage.get(group.image);
    return row ? [{ ...rowToSummary(row), ...declaredVersionFields(group.image, group.labels) }] : [];
  });

  if (liveGroups.length === 0) {
    persistedSummaries.sort((a, b) => a.image.localeCompare(b.image));
    summaryCache.set(cacheKey, persistedSummaries, SUMMARY_CACHE_TTL_MS);
    return persistedSummaries;
  }

  const results = await Promise.all(
    liveGroups.map((group) =>
      checkImageUpdateWithMeta(
        group.image,
        group.labels,
        group.imageDigest,
        rowsByImage.get(group.image)?.etag ?? null,
        rowsByImage.get(group.image)?.manifestDigest ?? null,
      ),
    ),
  );
  const liveSummaries = results.map((result) => ({
    ...result.summary,
    checkedAt: now.toISOString(),
  }));
  const summaries = [...persistedSummaries, ...liveSummaries];
  summaries.sort((a, b) => a.image.localeCompare(b.image));

  // Write-through is best effort. A failed persist must not break the read.
  try {
    for (let i = 0; i < results.length; i++) {
      const { summary, etag, digest } = results[i];
      if (summary.error !== null) {
        await checkRepo.upsertFailure(host, stack, summary.image, summary.error, now);
      } else {
        await checkRepo.upsertSuccess({
          host,
          stack,
          image: summary.image,
          currentTag: summary.currentTag,
          latestMatchingTag: summary.latestMatchingTag,
          latestOverallTag: summary.latestOverallTag,
          updateAvailable: summary.updateAvailable,
          sourceRepo: summary.sourceRepo,
          etag,
          manifestDigest: digest,
          checkedAt: now,
        });
      }
    }
  } catch (err) {
    console.error('[image-updates] failed to persist update checks:', err);
  }

  // A live failure stays uncached: caching would pin a registry outage's error
  // in the panel for the full TTL. Served last-good rows are cacheable.
  if (liveSummaries.every((summary) => summary.error === null)) {
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
    containers.find((c) => c.image === image && resolveReleaseRepo(c.labels).kind !== 'missing')?.labels
    ?? containers.find((c) => c.image === image)?.labels
    ?? {};
  const resolved = resolveReleaseRepo(labels);

  const changelog: ImageChangelog = {
    image,
    sourceRepo: resolved.kind === 'resolved' ? resolved.repo : null,
    releases: [],
    error: null,
  };
  switch (resolved.kind) {
    case 'resolved': {
      try {
        changelog.releases = await fetchGitHubReleases(
          resolved.repo,
          resolved.from === 'override'
            ? 'github.com/' + resolved.repo + ' is set in the "' + RELEASE_REPO_LABEL + '" label, but GitHub has no such public repository. Check the label value.'
            : undefined,
        );
      } catch (err) {
        changelog.error = err instanceof Error ? err.message : String(err);
      }
      if (changelog.error === null && changelog.releases.length === 0) {
        changelog.emptyStateMessage = resolved.from === 'override'
          ? 'GitHub publishes no releases at github.com/' + resolved.repo + ', the repository set in the "' + RELEASE_REPO_LABEL + '" label. Check the label value.'
          : 'No releases published at github.com/' + resolved.repo + ", the repository this image's source label points to." +
            ' If releases live in another repository, add the "' + RELEASE_REPO_LABEL + ': https://github.com/owner/repo" label to the service in your compose file and recreate the stack.';
      }
      break;
    }
    case 'invalid-url':
      changelog.error =
        'The "' + RELEASE_REPO_LABEL + '" label is set to "' + resolved.raw + '", which is not a full repository URL. Use a URL like https://github.com/owner/repo.';
      break;
    case 'unsupported-host':
      changelog.error = resolved.from === 'override'
        ? 'The "' + RELEASE_REPO_LABEL + '" label points at ' + resolved.host + ', but release notes are only fetched from GitHub right now.'
        : "This image's source label points at " + resolved.host + ', but release notes are only fetched from GitHub right now.';
      break;
    case 'missing':
      changelog.error =
        'No release repository is set for this image. Add the "' + RELEASE_REPO_LABEL + ': https://github.com/owner/repo" label to the service in your compose file and recreate the stack to see its release notes.';
      break;
  }
  // Failures and empty results stay uncached: a cached error pins a rate-limit
  // outage in the dialog for the full hour, and a cached empty result would
  // keep showing fix-it instructions after the operator has already added the
  // label the message asks for.
  if (changelog.error === null && changelog.releases.length > 0) {
    changelogCache.set(cacheKey, changelog, CHANGELOG_CACHE_TTL_MS);
  }
  return changelog;
}
