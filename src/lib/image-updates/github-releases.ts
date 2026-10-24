import type { ImageRelease } from '@/types/image-updates';

const REQUEST_TIMEOUT_MS = 10_000;
const RELEASES_PER_PAGE = 50;
const MAX_RELEASES = 100;

/** Release notes could not be fetched; the message is shown in the dialog. */
export class ChangelogError extends Error {}

interface GitHubRelease {
  tag_name?: string;
  name?: string | null;
  published_at?: string | null;
  html_url?: string;
  body?: string | null;
  prerelease?: boolean;
  draft?: boolean;
}

/**
 * Fetch release notes from a GitHub repository's Releases API. Anonymous
 * requests are rate-limited to 60/hour per IP, so callers cache aggressively;
 * drafts are skipped and releases without a body still appear (the tag alone
 * is often the changelog line).
 */
export async function fetchGitHubReleases(sourceRepo: string): Promise<ImageRelease[]> {
  const [owner, repo, ...rest] = sourceRepo.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new ChangelogError(`"${sourceRepo}" is not an owner/repo pair`);
  }

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${RELEASES_PER_PAGE}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );

  if (response.status === 404) {
    throw new ChangelogError(`No releases published at github.com/${sourceRepo}`);
  }
  if (response.status === 403 || response.status === 429) {
    throw new ChangelogError('GitHub API rate limit reached; try again later');
  }
  if (!response.ok) {
    throw new ChangelogError(`GitHub API returned ${response.status}`);
  }

  const body = (await response.json()) as GitHubRelease[];
  return body
    .filter((release) => !release.draft && release.tag_name)
    .slice(0, MAX_RELEASES)
    .map((release) => ({
      tagName: release.tag_name as string,
      name: release.name ?? null,
      publishedAt: release.published_at ?? null,
      url: release.html_url ?? null,
      body: release.body ?? null,
      prerelease: release.prerelease ?? false,
    }));
}
