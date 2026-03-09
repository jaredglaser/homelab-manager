import type { GitHubRelease } from '@/types/container-versions';

export interface GitHubRepo {
  owner: string;
  repo: string;
}

export function parseGitHubRepoUrl(url: string): GitHubRepo | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'github.com') return null;
    const parts = parsed.pathname.replace(/\/+$/, '').replace(/\.git$/, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}

export function extractGitHubRepo(labels: Record<string, string>): GitHubRepo | null {
  const source = labels['org.opencontainers.image.source'];
  if (source) return parseGitHubRepoUrl(source);
  return null;
}

export interface GitHubRateLimitInfo {
  remaining: number;
  resetAt: number;
}

export interface FetchReleasesResult {
  releases: GitHubRelease[];
  rateLimit: GitHubRateLimitInfo | null;
  rateLimited: boolean;
}

export async function fetchGitHubReleases(
  repo: GitHubRepo,
  token?: string,
  signal?: AbortSignal,
): Promise<FetchReleasesResult> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(
    `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=20`,
    { headers, signal },
  );

  const rateLimit: GitHubRateLimitInfo = {
    remaining: parseInt(response.headers.get('x-ratelimit-remaining') ?? '0', 10),
    resetAt: parseInt(response.headers.get('x-ratelimit-reset') ?? '0', 10),
  };

  if (response.status === 403 || response.status === 429) {
    return { releases: [], rateLimit, rateLimited: true };
  }

  if (!response.ok) {
    return { releases: [], rateLimit, rateLimited: false };
  }

  const data = await response.json();
  const releases: GitHubRelease[] = data
    .filter((r: any) => !r.prerelease)
    .map((r: any) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      body: r.body || '',
      published_at: r.published_at,
      url: r.html_url,
    }));

  return { releases, rateLimit, rateLimited: false };
}
