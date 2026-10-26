import type { ImageRelease } from '@/types/image-updates';

const REQUEST_TIMEOUT_MS = 10_000;
const RELEASES_PER_PAGE = 50;
const MAX_RELEASES = 100;
const MAX_PAGES = MAX_RELEASES / RELEASES_PER_PAGE;
const GITHUB_API_HOST = 'api.github.com';

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
 * Anonymous GitHub API calls are rate limited to 60/hour per IP, so callers
 * cache aggressively.
 */
export async function fetchGitHubReleases(sourceRepo: string): Promise<ImageRelease[]> {
  const [owner, repo, ...rest] = sourceRepo.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new ChangelogError(
      'The source repository "' + sourceRepo + '" is not a valid GitHub owner/repo pair, so release notes cannot be fetched.',
    );
  }

  const releases: GitHubRelease[] = [];
  let url: string | null = 'https://' + GITHUB_API_HOST + '/repos/' + owner + '/' + repo + '/releases?per_page=' + RELEASES_PER_PAGE;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (response.status === 404) {
      throw new ChangelogError('No releases are published at github.com/' + sourceRepo + ', so there are no release notes to show.');
    }
    if (response.status === 403 || response.status === 429) {
      throw new ChangelogError('GitHub API rate limit reached. Try again later.');
    }
    if (!response.ok) {
      console.error('[image-updates] GitHub releases API returned ' + response.status + ' for ' + owner + '/' + repo);
      throw new ChangelogError('GitHub failed to return release notes, so the changelog is unavailable right now.');
    }

    const body = (await response.json()) as GitHubRelease[];
    releases.push(...body);
    if (releases.length >= MAX_RELEASES) break;
    url = nextReleasesPage(response.headers.get('link'));
  }

  return releases
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

function nextReleasesPage(header: string | null): string | null {
  const match = header?.match(/<([^>]+)>\s*;\s*rel="next"/);
  if (!match) return null;
  const next = new URL(match[1], 'https://' + GITHUB_API_HOST);
  if (next.host !== GITHUB_API_HOST) return null;
  return next.toString();
}