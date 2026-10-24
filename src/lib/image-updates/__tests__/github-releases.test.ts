import { describe, expect, mock, test } from 'bun:test';
import { ChangelogError, fetchGitHubReleases } from '../github-releases';

function withFetch(impl: (url: string) => Promise<Response>): { restore: () => void; fetchMock: ReturnType<typeof mock> } {
  const fetchMock = mock(impl);
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const RELEASE = {
  tag_name: 'v1.1.0',
  name: 'Version 1.1.0',
  published_at: '2026-01-15T10:00:00Z',
  html_url: 'https://github.com/o/r/releases/v1.1.0',
  body: '## Changes\n- fixed a thing',
  prerelease: false,
  draft: false,
};

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

  test('404 names the repository in the error', async () => {
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({}, 404)));
    try {
      await expect(fetchGitHubReleases('o/r')).rejects.toThrow('No releases published at github.com/o/r');
    } finally {
      restore();
    }
  });

  test('rate limit surfaces a retry-later message', async () => {
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({}, 403)));
    try {
      await expect(fetchGitHubReleases('o/r')).rejects.toThrow('rate limit');
    } finally {
      restore();
    }
  });

  test('malformed source repo throws without a network call', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(jsonResponse([])));
    try {
      await expect(fetchGitHubReleases('https://github.com/o/r')).rejects.toThrow(ChangelogError);
      await expect(fetchGitHubReleases('o/r/extra/deep')).rejects.toThrow(ChangelogError);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
