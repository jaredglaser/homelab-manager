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
export async function fetchGitHubReleases(
  sourceRepo: string,
  notFoundMessage = 'No public releases are visible at github.com/' + sourceRepo +
    ', so there are no release notes to show. A private repository looks the same from the outside; if the repository exists, publishing releases or making it public fixes this.',
): Promise<ImageRelease[]> {
  const [owner, repo, ...rest] = sourceRepo.split('/');
  if (!owner || !repo || rest.length > 0) {
    throw new ChangelogError(
      'The source repository "' + sourceRepo + '" is not a valid GitHub owner/repo pair, so release notes cannot be fetched.',
    );
  }

  const releases: GitHubRelease[] = [];
  let url: string | null = 'https://' + GITHUB_API_HOST + '/repos/' + owner + '/' + repo + '/releases?per_page=' + RELEASES_PER_PAGE;
  for (let page = 0; page < MAX_PAGES && url; page++) {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new ChangelogError('GitHub took too long to answer, so release notes are unavailable right now. Try again in a moment.');
      }
      throw new ChangelogError('Could not reach GitHub to fetch release notes. Check your network and try again.');
    }
    // Renamed repositories 301 within api.github.com; anything that lands off-host is untrusted.
    // Mocked responses carry an empty url, which is not a redirect.
    if (response.url !== '' && new URL(response.url).host !== GITHUB_API_HOST) {
      throw new ChangelogError('GitHub redirected release notes to another server, so they were not fetched.');
    }

    if (response.status === 404) {
      throw new ChangelogError(notFoundMessage);
    }
    if (response.status === 403 || response.status === 429) {
      throw new ChangelogError('GitHub API rate limit reached. Try again later.');
    }
    if (!response.ok) {
      console.error('[image-updates] GitHub releases API returned ' + response.status + ' for ' + owner + '/' + repo);
      throw new ChangelogError('GitHub failed to return release notes, so the changelog is unavailable right now.');
    }

    let body: GitHubRelease[];
    try {
      body = (await response.json()) as GitHubRelease[];
    } catch {
      throw new ChangelogError('GitHub returned an unexpected response, so release notes are unavailable right now.');
    }
    for (const release of body) {
      if (!release.draft && release.tag_name) releases.push(release);
    }
    if (releases.length >= MAX_RELEASES) break;
    url = nextReleasesPage(response.headers.get('link'));
  }

  return releases
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