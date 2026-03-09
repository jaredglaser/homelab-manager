import { describe, it, expect, afterEach } from 'bun:test';
import { parseGitHubRepoUrl, extractGitHubRepo, fetchGitHubReleases } from '../github-api';
import type { GitHubRepo } from '../github-api';

describe('parseGitHubRepoUrl', () => {
  it('extracts owner/repo from HTTPS URL', () => {
    expect(parseGitHubRepoUrl('https://github.com/linuxserver/docker-sonarr')).toEqual({
      owner: 'linuxserver',
      repo: 'docker-sonarr',
    });
  });

  it('handles trailing slash', () => {
    expect(parseGitHubRepoUrl('https://github.com/linuxserver/docker-sonarr/')).toEqual({
      owner: 'linuxserver',
      repo: 'docker-sonarr',
    });
  });

  it('handles .git suffix', () => {
    expect(parseGitHubRepoUrl('https://github.com/linuxserver/docker-sonarr.git')).toEqual({
      owner: 'linuxserver',
      repo: 'docker-sonarr',
    });
  });

  it('returns null for non-GitHub URLs', () => {
    expect(parseGitHubRepoUrl('https://gitlab.com/foo/bar')).toBeNull();
  });

  it('returns null for invalid input', () => {
    expect(parseGitHubRepoUrl('')).toBeNull();
    expect(parseGitHubRepoUrl('not-a-url')).toBeNull();
  });

  it('handles URLs with extra path segments', () => {
    expect(parseGitHubRepoUrl('https://github.com/owner/repo/tree/main')).toEqual({
      owner: 'owner',
      repo: 'repo',
    });
  });
});

describe('extractGitHubRepo', () => {
  it('extracts from OCI source label', () => {
    const labels = { 'org.opencontainers.image.source': 'https://github.com/linuxserver/docker-sonarr' };
    expect(extractGitHubRepo(labels)).toEqual({
      owner: 'linuxserver',
      repo: 'docker-sonarr',
    });
  });

  it('returns null when no relevant labels', () => {
    expect(extractGitHubRepo({})).toBeNull();
    expect(extractGitHubRepo({ 'com.docker.compose.service': 'web' })).toBeNull();
  });
});

describe('fetchGitHubReleases', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const repo: GitHubRepo = { owner: 'nginx', repo: 'nginx' };

  it('should return releases filtering out prereleases', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { tag_name: 'v1.26', name: 'v1.26', body: 'Stable', published_at: '2024-01-01', html_url: 'https://github.com/nginx/nginx/releases/v1.26', prerelease: false },
      { tag_name: 'v1.27-rc1', name: 'v1.27-rc1', body: 'RC', published_at: '2024-02-01', html_url: 'url2', prerelease: true },
      { tag_name: 'v1.25', name: 'v1.25', body: 'Old stable', published_at: '2023-06-01', html_url: 'url3', prerelease: false },
    ]), {
      status: 200,
      headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
    })) as unknown as typeof fetch;

    const result = await fetchGitHubReleases(repo);

    expect(result.rateLimited).toBe(false);
    expect(result.releases).toHaveLength(2);
    expect(result.releases[0].tag).toBe('v1.26');
    expect(result.releases[0].name).toBe('v1.26');
    expect(result.releases[0].body).toBe('Stable');
    expect(result.releases[1].tag).toBe('v1.25');
    expect(result.rateLimit).toEqual({ remaining: 59, resetAt: 1700000000 });
  });

  it('should return rateLimited true for 403 response', async () => {
    globalThis.fetch = (async () => new Response('Forbidden', {
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700001000' },
    })) as unknown as typeof fetch;

    const result = await fetchGitHubReleases(repo);

    expect(result.rateLimited).toBe(true);
    expect(result.releases).toEqual([]);
    expect(result.rateLimit!.remaining).toBe(0);
  });

  it('should return rateLimited true for 429 response', async () => {
    globalThis.fetch = (async () => new Response('Too Many Requests', {
      status: 429,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700001000' },
    })) as unknown as typeof fetch;

    const result = await fetchGitHubReleases(repo);

    expect(result.rateLimited).toBe(true);
    expect(result.releases).toEqual([]);
  });

  it('should return empty releases for non-ok response', async () => {
    globalThis.fetch = (async () => new Response('Not Found', {
      status: 404,
      headers: { 'x-ratelimit-remaining': '58', 'x-ratelimit-reset': '1700000000' },
    })) as unknown as typeof fetch;

    const result = await fetchGitHubReleases(repo);

    expect(result.rateLimited).toBe(false);
    expect(result.releases).toEqual([]);
  });

  it('should pass auth token as Bearer header', async () => {
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
      });
    }) as unknown as typeof fetch;

    await fetchGitHubReleases(repo, 'ghp_test123');

    expect((capturedHeaders as Record<string, string>).Authorization).toBe('Bearer ghp_test123');
  });

  it('should not include Authorization header when no token', async () => {
    let capturedHeaders: HeadersInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
      });
    }) as unknown as typeof fetch;

    await fetchGitHubReleases(repo);

    expect((capturedHeaders as Record<string, string>).Authorization).toBeUndefined();
  });

  it('should forward signal to fetch', async () => {
    let capturedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
      });
    }) as unknown as typeof fetch;

    const controller = new AbortController();
    await fetchGitHubReleases(repo, undefined, controller.signal);

    expect(capturedSignal).toBe(controller.signal);
    controller.abort();
  });

  it('should use tag_name as name fallback when name is null', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([
      { tag_name: 'v1.0', name: null, body: null, published_at: '2024-01-01', html_url: 'url', prerelease: false },
    ]), {
      status: 200,
      headers: { 'x-ratelimit-remaining': '59', 'x-ratelimit-reset': '1700000000' },
    })) as unknown as typeof fetch;

    const result = await fetchGitHubReleases(repo);

    expect(result.releases[0].name).toBe('v1.0');
    expect(result.releases[0].body).toBe('');
  });
});
