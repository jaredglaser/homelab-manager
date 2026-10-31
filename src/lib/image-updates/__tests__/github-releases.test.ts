import { describe, expect, test } from 'bun:test';
import { ChangelogError, fetchGitHubReleases } from '../github-releases';
import { jsonResponse, withFetch } from '@/lib/test/fetch-mock';

const RELEASE = {
  tag_name: 'v1.1.0',
  name: 'Version 1.1.0',
  published_at: '2026-01-15T10:00:00Z',
  html_url: 'https://github.com/o/r/releases/v1.1.0',
  body: '## Changes\n- fixed a thing',
  prerelease: false,
  draft: false,
};

function page(tagPrefix: string, count: number): unknown[] {
  return Array.from({ length: count }, (_, i) => ({ ...RELEASE, tag_name: tagPrefix + i }));
}

describe('fetchGitHubReleases', () => {
  test('maps releases to the wire shape, newest first as served', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      expect(String(url)).toBe('https://api.github.com/repos/o/r/releases?per_page=50');
      return Promise.resolve(jsonResponse([RELEASE, { ...RELEASE, tag_name: 'v1.0.0', name: null, body: null }]));
    });
    try {
      const releases = await fetchGitHubReleases('o/r');
      expect(releases).toHaveLength(2);
      expect(releases[0]).toEqual({
        tagName: 'v1.1.0',
        name: 'Version 1.1.0',
        publishedAt: '2026-01-15T10:00:00Z',
        url: 'https://github.com/o/r/releases/v1.1.0',
        body: '## Changes\n- fixed a thing',
        prerelease: false,
      });
      expect(releases[1].name).toBeNull();
      expect(releases[1].body).toBeNull();
      expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ Accept: 'application/vnd.github+json' });
    } finally {
      restore();
    }
  });

  test('follows the Link rel=next header for a second page', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target.includes('page=2')) {
        return Promise.resolve(jsonResponse(page('v2.', 30)));
      }
      return Promise.resolve(new Response(JSON.stringify(page('v1.', 50)), {
        status: 200,
        headers: { Link: '<https://api.github.com/repos/o/r/releases?per_page=50&page=2>; rel="next"' },
      }));
    });
    try {
      const releases = await fetchGitHubReleases('o/r');
      expect(releases).toHaveLength(80);
      expect(releases[49].tagName).toBe('v1.49');
      expect(releases[50].tagName).toBe('v2.0');
      expect(fetchMock.mock.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  test('caps the fetch at MAX_RELEASES without a third page', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target.includes('page=2')) {
        return Promise.resolve(jsonResponse(page('v2.', 60)));
      }
      return Promise.resolve(new Response(JSON.stringify(page('v1.', 50)), {
        status: 200,
        headers: { Link: '<https://api.github.com/repos/o/r/releases?per_page=50&page=2>; rel="next"' },
      }));
    });
    try {
      const releases = await fetchGitHubReleases('o/r');
      expect(releases).toHaveLength(100);
      expect(fetchMock.mock.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  test('a cross-host Link header is not followed', async () => {
    const { restore, fetchMock } = withFetch(() =>
      Promise.resolve(new Response(JSON.stringify(page('v1.', 50)), {
        status: 200,
        headers: { Link: '<https://evil.example/repos/o/r/releases?page=2>; rel="next"' },
      })),
    );
    try {
      const releases = await fetchGitHubReleases('o/r');
      expect(releases).toHaveLength(50);
      expect(fetchMock.mock.calls.length).toBe(1);
      expect(String(fetchMock.mock.calls[0][0])).not.toContain('evil.example');
    } finally {
      restore();
    }
  });

  test('drafts and tagless entries are skipped', async () => {
    const { restore } = withFetch(() =>
      Promise.resolve(jsonResponse([
        RELEASE,
        { ...RELEASE, draft: true, tag_name: 'v2.0.0' },
        { ...RELEASE, tag_name: null },
      ])),
    );
    try {
      const releases = await fetchGitHubReleases('o/r');
      expect(releases.map((r) => r.tagName)).toEqual(['v1.1.0']);
    } finally {
      restore();
    }
  });

  test('drafts do not consume the MAX_RELEASES cap', async () => {
    function mixedPage(valid: number, drafts: number, tagPrefix: string): unknown[] {
      const entries: unknown[] = [];
      for (let i = 0; i < valid; i++) entries.push({ ...RELEASE, tag_name: tagPrefix + i });
      for (let i = 0; i < drafts; i++) entries.push({ ...RELEASE, tag_name: 'draft-' + i, draft: true });
      return entries;
    }
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target.includes('page=2')) return Promise.resolve(jsonResponse(mixedPage(40, 0, 'v2.')));
      return Promise.resolve(new Response(JSON.stringify(mixedPage(60, 40, 'v1.')), {
        status: 200,
        headers: { Link: '<https://api.github.com/repos/o/r/releases?per_page=50&page=2>; rel="next"' },
      }));
    });
    try {
      const releases = await fetchGitHubReleases('o/r');
      expect(releases).toHaveLength(100);
      expect(releases.every((r) => !r.tagName.startsWith('draft-'))).toBe(true);
      expect(fetchMock.mock.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  test('404 names the repository in the error', async () => {
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({}, 404)));
    try {
      await expect(fetchGitHubReleases('o/r')).rejects.toThrow(
        new ChangelogError('No public releases are visible at github.com/o/r, so there are no release notes to show. A private repository looks the same from the outside; if the repository exists, publishing releases or making it public fixes this.'),
      );
    } finally {
      restore();
    }
  });

  test('a custom 404 message replaces the default', async () => {
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({}, 404)));
    try {
      await expect(fetchGitHubReleases('o/r', 'custom 404 copy')).rejects.toThrow(new ChangelogError('custom 404 copy'));
    } finally {
      restore();
    }
  });

  test('a timeout surfaces the retry-later copy', async () => {
    const { restore } = withFetch(() => Promise.reject(new DOMException('The operation was aborted', 'TimeoutError')));
    try {
      await expect(fetchGitHubReleases('o/r')).rejects.toThrow(
        new ChangelogError('GitHub took too long to answer, so release notes are unavailable right now. Try again in a moment.'),
      );
    } finally {
      restore();
    }
  });

  test('a network failure surfaces the check-your-network copy', async () => {
    const { restore } = withFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    try {
      await expect(fetchGitHubReleases('o/r')).rejects.toThrow(
        new ChangelogError('Could not reach GitHub to fetch release notes. Check your network and try again.'),
      );
    } finally {
      restore();
    }
  });

  test('a malformed body surfaces the unexpected-response copy', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response('<html>not json</html>', { status: 200 })));
    try {
      await expect(fetchGitHubReleases('o/r')).rejects.toThrow(
        new ChangelogError('GitHub returned an unexpected response, so release notes are unavailable right now.'),
      );
    } finally {
      restore();
    }
  });

  test('a redirect off api.github.com is refused', async () => {
    const evil = {
      status: 200,
      ok: true,
      url: 'https://evil.example/repos/o/r/releases',
      headers: new Headers(),
      json: async () => [],
    } as unknown as Response;
    const { restore } = withFetch(() => Promise.resolve(evil));
    try {
      await expect(fetchGitHubReleases('o/r')).rejects.toThrow(
        new ChangelogError('GitHub redirected release notes to another server, so they were not fetched.'),
      );
    } finally {
      restore();
    }
  });

  test('a same-host redirect (renamed repo) succeeds', async () => {
    const redirected = {
      status: 200,
      ok: true,
      url: 'https://api.github.com/repos/o/r2/releases?per_page=50',
      headers: new Headers(),
      json: async () => [RELEASE],
    } as unknown as Response;
    const { restore } = withFetch(() => Promise.resolve(redirected));
    try {
      const releases = await fetchGitHubReleases('o/r');
      expect(releases).toHaveLength(1);
    } finally {
      restore();
    }
  });

  test('rate limit surfaces a retry-later message', async () => {
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({}, 403)));
    try {
      await expect(fetchGitHubReleases('o/r')).rejects.toThrow(
        new ChangelogError('GitHub API rate limit reached. Try again later.'),
      );
    } finally {
      restore();
    }
  });

  test('other failures surface the changelog-unavailable message', async () => {
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({}, 500)));
    try {
      await expect(fetchGitHubReleases('o/r')).rejects.toThrow(
        new ChangelogError('GitHub failed to return release notes, so the changelog is unavailable right now.'),
      );
    } finally {
      restore();
    }
  });

  test('a malformed source repo throws without a network call', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(jsonResponse([])));
    try {
      await expect(fetchGitHubReleases('https://github.com/o/r')).rejects.toThrow(
        new ChangelogError('The source repository "https://github.com/o/r" is not a valid GitHub owner/repo pair, so release notes cannot be fetched.'),
      );
      await expect(fetchGitHubReleases('o/r/extra/deep')).rejects.toThrow(ChangelogError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});