import { describe, expect, test } from 'bun:test';
import { checkImageUpdate, fetchRemoteManifestDigest, isRegistryAllowed, listRegistryTags, parseExtraRegistries, RegistryCheckError, sourceRepoFromLabels } from '../registry-client';
import { HUB_PROBE, hubTokenFlow, jsonResponse, withFetch } from '@/lib/test/fetch-mock';

const SOURCE_LABEL = 'org.opencontainers.image.source';

describe('sourceRepoFromLabels', () => {
  test('extracts owner/repo from a github.com source label', () => {
    expect(sourceRepoFromLabels({ [SOURCE_LABEL]: 'https://github.com/louislam/uptime-kuma' })).toBe('louislam/uptime-kuma');
  });

  test('strips a .git suffix and query strings', () => {
    expect(sourceRepoFromLabels({ [SOURCE_LABEL]: 'https://github.com/o/r.git' })).toBe('o/r');
    expect(sourceRepoFromLabels({ [SOURCE_LABEL]: 'https://github.com/o/r/tree/main' })).toBe('o/r');
  });

  test('returns null for non-github or missing labels', () => {
    expect(sourceRepoFromLabels({ [SOURCE_LABEL]: 'https://gitlab.com/o/r' })).toBeNull();
    expect(sourceRepoFromLabels({})).toBeNull();
  });
});

describe('parseExtraRegistries', () => {
  test('parses a comma list with trimmed whitespace and dropped empties', () => {
    expect(parseExtraRegistries(' nas.lan:5000 , registry.home.arpa ,,')).toEqual(['nas.lan:5000', 'registry.home.arpa']);
  });

  test('returns an empty list for unset and empty values', () => {
    expect(parseExtraRegistries(undefined)).toEqual([]);
    expect(parseExtraRegistries('')).toEqual([]);
    expect(parseExtraRegistries('  ')).toEqual([]);
  });

  test('malformed entries throw with the fix-it copy', () => {
    let message: string | undefined;
    try {
      parseExtraRegistries('nas lan:5000');
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toBe(
      'IMAGE_UPDATE_EXTRA_REGISTRIES entry "nas lan:5000" is not a valid registry host. ' +
        'Use comma-separated hostnames with an optional port, for example IMAGE_UPDATE_EXTRA_REGISTRIES="nas.lan:5000,registry.home.arpa"',
    );
  });

  test('rejects multiple ports and URL schemes', () => {
    expect(() => parseExtraRegistries('nas.lan:5000:6000')).toThrow();
    expect(() => parseExtraRegistries('https://nas.lan')).toThrow();
  });
});

describe('isRegistryAllowed', () => {
  test('default allowlist covers the built-in registries', () => {
    expect(isRegistryAllowed('docker.io')).toBe(true);
    expect(isRegistryAllowed('ghcr.io')).toBe(true);
    expect(isRegistryAllowed('registry.k8s.io')).toBe(true);
    expect(isRegistryAllowed('lscr.io')).toBe(true);
  });

  test('unknown registries are blocked unless listed as extras', () => {
    expect(isRegistryAllowed('nas.lan:5000')).toBe(false);
    expect(isRegistryAllowed('NAS.LAN:5000', new Set(['nas.lan:5000']))).toBe(true);
    expect(isRegistryAllowed('registry.home.arpa', new Set(['registry.home.arpa']))).toBe(true);
  });
});

describe('checkImageUpdate', () => {
  test('docker.io version pin: newer matching tag flags an update', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      expect(String(url)).toContain('hub.docker.com/v2/repositories/library/redis/tags');
      return Promise.resolve(jsonResponse({
        results: [{ name: '7' }, { name: '7.4.1' }, { name: '7.10' }, { name: '8.0.0' }, { name: 'latest' }],
        next: null,
      }));
    });
    try {
      const summary = await checkImageUpdate('redis:7', {});
      expect(summary.updateAvailable).toBe(true);
      expect(summary.latestMatchingTag).toBe('7.10');
      expect(summary.latestOverallTag).toBe('8.0.0');
      expect(summary.currentTag).toBe('7');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('a :2 pin never flags 3.0 as a matching update', async () => {
    const { restore } = withFetch(() =>
      Promise.resolve(jsonResponse({ results: [{ name: '2.0.0' }, { name: '3.0.0' }], next: null })),
    );
    try {
      const summary = await checkImageUpdate('redis:2', {});
      expect(summary.updateAvailable).toBe(false);
      expect(summary.latestMatchingTag).toBe('2.0.0');
      expect(summary.latestOverallTag).toBe('3.0.0');
    } finally {
      restore();
    }
  });

  test('up-to-date pin reports false with the same latest matching tag', async () => {
    const { restore } = withFetch(() =>
      Promise.resolve(jsonResponse({ results: [{ name: '2.0.0' }], next: null })),
    );
    try {
      const summary = await checkImageUpdate('redis:2', {});
      expect(summary.updateAvailable).toBe(false);
      expect(summary.latestMatchingTag).toBe('2.0.0');
    } finally {
      restore();
    }
  });

  test('floating tag reports unknown update state without a registry call', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(jsonResponse({})));
    try {
      const summary = await checkImageUpdate('myapp:latest', {});
      expect(summary.updateAvailable).toBeNull();
      expect(summary.currentTag).toBe('latest');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('a registry outside the allowlist errors without any fetch', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(jsonResponse({})));
    try {
      const summary = await checkImageUpdate('nas.lan:5000/app:1.0', {});
      expect(summary.error).toBe(
        'Registry nas.lan:5000 is not on the allowed registries list. ' +
          'Add it to IMAGE_UPDATE_EXTRA_REGISTRIES to check updates for its images.',
      );
      expect(summary.updateAvailable).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('index.docker.io spellings resolve to the docker.io hub path', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      expect(String(url)).toContain('hub.docker.com/v2/repositories/library/redis/tags');
      return Promise.resolve(jsonResponse({ results: [{ name: '7' }, { name: '7.10' }], next: null }));
    });
    try {
      const summary = await checkImageUpdate('index.docker.io/redis:7', {});
      expect(summary.updateAvailable).toBe(true);
      expect(summary.latestMatchingTag).toBe('7.10');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('ghcr.io performs the anonymous token dance and lists tags', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target === 'https://ghcr.io/v2/') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        }));
      }
      if (target.startsWith('https://ghcr.io/token')) {
        return Promise.resolve(jsonResponse({ token: 'tok' }));
      }
      return Promise.resolve(jsonResponse({ tags: ['1.0.0', '1.0.5', '1.1.0'] }));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/dance:1.0', {});
      expect(summary.updateAvailable).toBe(true);
      expect(summary.latestMatchingTag).toBe('1.0.5');
      expect(summary.latestOverallTag).toBe('1.1.0');
      expect(fetchMock.mock.calls.length).toBe(3);
    } finally {
      restore();
    }
  });

  test('lscr.io follows the ghcr.io delegated token realm for a floating tag', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target === 'https://lscr.io/v2/') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        }));
      }
      if (target.startsWith('https://ghcr.io/token')) {
        return Promise.resolve(jsonResponse({ token: 'tok' }));
      }
      expect(target).toBe('https://lscr.io/v2/linuxserver/nginx/manifests/latest');
      return Promise.resolve(new Response(null, { status: 200, headers: { 'Docker-Content-Digest': 'sha256:' + 'e'.repeat(64) } }));
    });
    try {
      const summary = await checkImageUpdate('lscr.io/linuxserver/nginx:latest', {}, 'sha256:' + 'a'.repeat(64));
      expect(summary.updateAvailable).toBe(true);
      const targets = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(targets[0]).toBe('https://lscr.io/v2/');
      expect(targets[1]).toContain('https://ghcr.io/token');
      expect(targets[2]).toBe('https://lscr.io/v2/linuxserver/nginx/manifests/latest');
      expect(fetchMock.mock.calls.length).toBe(3);
    } finally {
      restore();
    }
  });

  test('a non-lscr.io base with a ghcr.io realm is rejected as an unexpected host', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      if (String(url) === 'https://quay.io/v2/') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    try {
      const summary = await checkImageUpdate('quay.io/owner/app:1.0', {});
      expect(summary.error).toBe(
        'Registry quay.io pointed its token endpoint at an unexpected host, so the update check stopped for safety.',
      );
      expect(fetchMock.mock.calls.length).toBe(1);
    } finally {
      restore();
    }
  });

  test('variant constraint only matches the same variant', async () => {
    const { restore } = withFetch(() =>
      Promise.resolve(jsonResponse({ results: [{ name: '7.4.1-alpine' }, { name: '7.4.1' }], next: null })),
    );
    try {
      const summary = await checkImageUpdate('redis:7-alpine', {});
      expect(summary.updateAvailable).toBe(true);
      expect(summary.latestMatchingTag).toBe('7.4.1-alpine');
    } finally {
      restore();
    }
  });

  test('registry failure lands in error, not a throw', async () => {
    const { restore } = withFetch(() => Promise.reject(new Error('network down')));
    try {
      const summary = await checkImageUpdate('redis:7', {});
      expect(summary.updateAvailable).toBeNull();
      expect(summary.error).toContain('network down');
    } finally {
      restore();
    }
  });

  test('missing repo (404) yields no tags and no update', async () => {
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({}, 404)));
    try {
      const summary = await checkImageUpdate('redis:7', {});
      expect(summary.updateAvailable).toBe(false);
      expect(summary.latestMatchingTag).toBeNull();
      expect(summary.error).toBeNull();
    } finally {
      restore();
    }
  });

  test('prerelease tags are not recommended as updates for a stable pin', async () => {
    const { restore } = withFetch(() =>
      Promise.resolve(jsonResponse({ results: [{ name: '8.0.0' }, { name: '8.1.0-rc.1' }], next: null })),
    );
    try {
      const summary = await checkImageUpdate('redis:8', {});
      expect(summary.updateAvailable).toBe(false);
      expect(summary.latestMatchingTag).toBe('8.0.0');
    } finally {
      restore();
    }
  });

  test('a realm pointing at another host surfaces the safety stop message', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      if (String(url) === 'https://ghcr.io/v2/') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="http://169.254.169.254/token",service="ghcr.io"' },
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/other:1.0', {});
      expect(summary.error).toBe(
        'Registry ghcr.io pointed its token endpoint at an unexpected host, so the update check stopped for safety.',
      );
      expect(fetchMock.mock.calls.length).toBe(1);
    } finally {
      restore();
    }
  });

  test('a probe that offers no token flow reports the no-anonymous-access copy', async () => {
    const { restore } = withFetch(() =>
      Promise.resolve(new Response(null, { status: 403 })),
    );
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/app:1.0', {});
      expect(summary.error).toBe(
        'Registry ghcr.io does not allow anonymous tag access, so its update state cannot be checked.',
      );
    } finally {
      restore();
    }
  });

  test('a redirecting probe surfaces the no-anonymous-access message without following', async () => {
    const { restore, fetchMock } = withFetch(() =>
      Promise.resolve(new Response(null, { status: 302, headers: { Location: 'https://evil.example/v2/' } })),
    );
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/redir:1.0', {});
      expect(summary.error).toBe(
        'Registry ghcr.io does not allow anonymous tag access, so its update state cannot be checked.',
      );
      expect(fetchMock.mock.calls.length).toBe(1);
    } finally {
      restore();
    }
  });

  test('a redirecting tag page surfaces the list-tags failure without following', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      if (String(url) === 'https://ghcr.io/v2/') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(null, { status: 302, headers: { Location: 'https://evil.example/tags' } }));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/redir:1.0', {});
      expect(summary.error).toBe(
        "Registry ghcr.io failed to list tags for owner/redir, so this image's update state cannot be checked.",
      );
      expect(fetchMock.mock.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  test('a failing token endpoint surfaces the failed-token-issuance message', async () => {
    const { restore } = withFetch((url) => {
      const target = String(url);
      if (target === 'https://ghcr.io/v2/') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        }));
      }
      return Promise.resolve(jsonResponse({}, 500));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/badtoken:1.0', {});
      expect(summary.error).toBe(
        'Registry ghcr.io failed to issue a read token, so its update state cannot be checked.',
      );
    } finally {
      restore();
    }
  });

  test('a token response without a token surfaces the no-usable-token message', async () => {
    const { restore } = withFetch((url) => {
      const target = String(url);
      if (target === 'https://ghcr.io/v2/') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/notoken:1.0', {});
      expect(summary.error).toBe(
        'Registry ghcr.io did not return a usable read token, so its update state cannot be checked.',
      );
    } finally {
      restore();
    }
  });

  test('v2 tag listing follows relative Link pagination', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target.endsWith('/v2/')) {
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (target.includes('last=')) {
        return Promise.resolve(jsonResponse({ tags: ['1.2.0'] }));
      }
      return Promise.resolve(new Response(JSON.stringify({ tags: ['1.0.0', '1.1.0'] }), {
        status: 200,
        headers: { Link: '</v2/owner/app/tags/list?n=1000&last=1.1.0>; rel="next"' },
      }));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/paged:1', {});
      expect(summary.latestMatchingTag).toBe('1.2.0');
      expect(summary.updateAvailable).toBe(true);
      expect(fetchMock.mock.calls.length).toBe(3);
    } finally {
      restore();
    }
  });

  test('v2 pagination follows an absolute same-host Link', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target.endsWith('/v2/')) return Promise.resolve(new Response(null, { status: 200 }));
      if (target.includes('last=')) return Promise.resolve(jsonResponse({ tags: ['1.2.0'] }));
      return Promise.resolve(new Response(JSON.stringify({ tags: ['1.1.0'] }), {
        status: 200,
        headers: { Link: '<https://ghcr.io/v2/owner/app/tags/list?n=1000&last=1.1.0>; rel="next"' },
      }));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/paged:1', {});
      expect(summary.latestMatchingTag).toBe('1.2.0');
      expect(fetchMock.mock.calls.length).toBe(3);
    } finally {
      restore();
    }
  });

  test('a Link header with only rel=prev stops pagination', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target.endsWith('/v2/')) return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ tags: ['1.0.0'] }), {
        status: 200,
        headers: { Link: '</v2/owner/app/tags/list?last=1.0.0>; rel="prev"' },
      }));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/prevonly:1', {});
      expect(summary.latestMatchingTag).toBe('1.0.0');
      expect(fetchMock.mock.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  test('v2 pagination never fetches a cross-host Link and never leaks the token', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target === 'https://ghcr.io/v2/') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        }));
      }
      if (target.startsWith('https://ghcr.io/token')) {
        return Promise.resolve(jsonResponse({ token: 'tok' }));
      }
      return Promise.resolve(new Response(JSON.stringify({ tags: ['1.1.0'] }), {
        status: 200,
        headers: { Link: '<https://evil.example/v2/owner/app/tags/list?last=1.1.0>; rel="next"' },
      }));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/paged:1', {});
      expect(summary.error).toBe(
        'Registry ghcr.io sent the next page from a different host, so the tag list stopped early.',
      );
      for (const [calledUrl, init] of fetchMock.mock.calls) {
        const target = String(calledUrl);
        expect(target).not.toContain('evil.example');
        if (init?.headers && 'Authorization' in (init.headers as Record<string, string>)) {
          expect(target.startsWith('https://ghcr.io/')).toBe(true);
        }
      }
    } finally {
      restore();
    }
  });

  test('hub pagination never fetches a cross-host next url', async () => {
    const { restore, fetchMock } = withFetch(() =>
      Promise.resolve(jsonResponse({
        results: [{ name: '7' }],
        next: 'https://evil.example/v2/repositories/library/redis/tags?page=2',
      })),
    );
    try {
      const summary = await checkImageUpdate('redis:7', {});
      expect(summary.error).toBe('Docker Hub sent the next page from a different host, so the tag list stopped early.');
      expect(fetchMock.mock.calls.length).toBe(1);
      expect(String(fetchMock.mock.calls[0][0])).not.toContain('evil.example');
    } finally {
      restore();
    }
  });

  test('hub pagination follows an absolute same-host next url', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target.includes('page=2')) {
        return Promise.resolve(jsonResponse({ results: [{ name: '7.10' }], next: null }));
      }
      return Promise.resolve(jsonResponse({
        results: [{ name: '7' }],
        next: 'https://hub.docker.com/v2/repositories/library/redis/tags?page=2&page_size=100',
      }));
    });
    try {
      const summary = await checkImageUpdate('redis:7', {});
      expect(summary.latestMatchingTag).toBe('7.10');
      expect(summary.updateAvailable).toBe(true);
      expect(fetchMock.mock.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  test('an exhausted tag listing budget rejects before any fetch', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(jsonResponse({})));
    try {
      await expect(listRegistryTags('ghcr.io', 'owner/app', { deadline: Date.now() - 1 })).rejects.toThrow(
        'Listing tags from ghcr.io took too long, so the update state could not be checked.',
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('a hub tag listing failure surfaces its exact message', async () => {
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({}, 500)));
    try {
      const summary = await checkImageUpdate('redis:7', {});
      expect(summary.error).toBe(
        "Docker Hub failed to list tags for library/redis, so this image's update state cannot be checked.",
      );
    } finally {
      restore();
    }
  });

  test('a v2 tag listing failure surfaces its exact message', async () => {
    const { restore } = withFetch((url) => {
      if (String(url) === 'https://ghcr.io/v2/') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(jsonResponse({}, 500));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/owner/applist:1.0', {});
      expect(summary.error).toBe(
        "Registry ghcr.io failed to list tags for owner/applist, so this image's update state cannot be checked.",
      );
    } finally {
      restore();
    }
  });

  test('source label is carried through to the summary', async () => {
    const { restore } = withFetch(() => Promise.resolve(jsonResponse({ results: [], next: null })));
    try {
      const summary = await checkImageUpdate('redis:7', { [SOURCE_LABEL]: 'https://github.com/redis/redis' });
      expect(summary.sourceRepo).toBe('redis/redis');
    } finally {
      restore();
    }
  });
});

describe('fetchRemoteManifestDigest', () => {
  test('returns the Docker-Content-Digest of a HEAD request', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      const target = String(url);
      if (target === 'https://ghcr.io/v2/') return Promise.resolve(new Response(null, { status: 200 }));
      expect(target).toBe('https://ghcr.io/v2/owner/app/manifests/latest');
      return Promise.resolve(new Response(null, {
        status: 200,
        headers: { 'Docker-Content-Digest': 'sha256:' + 'c'.repeat(64) },
      }));
    });
    try {
      const digest = await fetchRemoteManifestDigest('ghcr.io', 'owner/app', 'latest');
      expect(digest).toBe('sha256:' + 'c'.repeat(64));
      expect(fetchMock.mock.calls[1][1]?.method).toBe('HEAD');
    } finally {
      restore();
    }
  });

  test('a vanished tag returns null', async () => {
    const { restore } = withFetch((url) => {
      if (String(url) === 'https://ghcr.io/v2/') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(null, { status: 404 }));
    });
    try {
      expect(await fetchRemoteManifestDigest('ghcr.io', 'owner/app', 'latest')).toBeNull();
    } finally {
      restore();
    }
  });

  test('docker.io HEADs registry-1.docker.io through the auth.docker.io realm', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(jsonResponse({})));
    hubTokenFlow(fetchMock, 'sha256:' + 'd'.repeat(64));
    try {
      expect(await fetchRemoteManifestDigest('docker.io', 'library/redis', 'latest')).toBe('sha256:' + 'd'.repeat(64));
      const targets = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(targets[0]).toBe(HUB_PROBE);
      expect(targets[1]).toContain('https://auth.docker.io/token');
      expect(targets[2]).toBe('https://registry-1.docker.io/v2/library/redis/manifests/latest');
      const head = fetchMock.mock.calls[2];
      expect((head[1]?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    } finally {
      restore();
    }
  });

  test('a registry-1.docker.io realm outside the delegated hosts is rejected', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      if (String(url) === HUB_PROBE) {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://evil.example/token"' },
        }));
      }
      return Promise.resolve(jsonResponse({}));
    });
    try {
      await expect(fetchRemoteManifestDigest('docker.io', 'library/other', 'latest')).rejects.toThrow(
        'Registry docker.io pointed its token endpoint at an unexpected host, so the update check stopped for safety.',
      );
      expect(fetchMock.mock.calls.length).toBe(1);
    } finally {
      restore();
    }
  });
});

describe('checkImageUpdate: floating tags', () => {
  test('a moved docker.io digest flags an update through the full token flow', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(jsonResponse({})));
    hubTokenFlow(fetchMock, 'sha256:' + 'b'.repeat(64));
    try {
      const summary = await checkImageUpdate('myhub:latest', {}, 'sha256:' + 'a'.repeat(64));
      expect(summary.updateAvailable).toBe(true);
      expect(fetchMock.mock.calls.length).toBe(3);
    } finally {
      restore();
    }
  });

  test('a matching docker.io digest reports up to date', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(jsonResponse({})));
    hubTokenFlow(fetchMock, 'sha256:' + 'a'.repeat(64));
    try {
      const summary = await checkImageUpdate('myhub:latest', {}, 'sha256:' + 'a'.repeat(64));
      expect(summary.updateAvailable).toBe(false);
    } finally {
      restore();
    }
  });

  test('a moved ghcr.io digest flags an update without listing tags', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      if (String(url) === 'https://ghcr.io/v2/') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(null, { status: 200, headers: { 'Docker-Content-Digest': 'sha256:' + 'b'.repeat(64) } }));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/myorg/myapp:latest', {}, 'sha256:' + 'a'.repeat(64));
      expect(summary.updateAvailable).toBe(true);
      expect(fetchMock.mock.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  test('a matching digest reports up to date', async () => {
    const { restore } = withFetch((url) => {
      if (String(url) === 'https://ghcr.io/v2/') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(null, { status: 200, headers: { 'Docker-Content-Digest': 'sha256:' + 'a'.repeat(64) } }));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/myorg/myapp:latest', {}, 'sha256:' + 'a'.repeat(64));
      expect(summary.updateAvailable).toBe(false);
    } finally {
      restore();
    }
  });

  test('no local digest stays inconclusive without any registry call', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response(null, { status: 200 })));
    try {
      const summary = await checkImageUpdate('ghcr.io/myorg/myapp:latest', {}, null);
      expect(summary.updateAvailable).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('a HEAD failure lands in error, not a throw', async () => {
    const { restore } = withFetch(() => Promise.reject(new Error('registry down')));
    try {
      const summary = await checkImageUpdate('ghcr.io/myorg/myapp:latest', {}, 'sha256:' + 'a'.repeat(64));
      expect(summary.updateAvailable).toBeNull();
      expect(summary.error).toContain('registry down');
    } finally {
      restore();
    }
  });

  test('a failing digest HEAD surfaces the unknown-update-state message', async () => {
    const { restore } = withFetch((url) => {
      if (String(url) === 'https://ghcr.io/v2/') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(null, { status: 500 }));
    });
    try {
      const summary = await checkImageUpdate('ghcr.io/myorg/myapp:latest', {}, 'sha256:' + 'a'.repeat(64));
      expect(summary.error).toBe(
        'Registry ghcr.io failed to read the digest for myorg/myapp:latest, so the update state is unknown.',
      );
    } finally {
      restore();
    }
  });
});

describe('getPullToken cache', () => {
  test('a cached token inside the 30 second expiry margin is refetched', async () => {
    const exp = Math.floor(Date.now() / 1000) + 10;
    const jwt = 'h.' + btoa(JSON.stringify({ exp })).replace(/\+/g, '-').replace(/\//g, '_') + '.s';
    let tokenRequests = 0;
    const { restore } = withFetch((url) => {
      const target = String(url);
      if (target === 'https://ghcr.io/v2/') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        }));
      }
      if (target.startsWith('https://ghcr.io/token')) {
        tokenRequests++;
        return Promise.resolve(jsonResponse({ token: jwt }));
      }
      return Promise.resolve(new Response(null, { status: 200, headers: { 'Docker-Content-Digest': 'sha256:' + 'f'.repeat(64) } }));
    });
    try {
      await fetchRemoteManifestDigest('ghcr.io', 'owner/expmargin', 'latest');
      await fetchRemoteManifestDigest('ghcr.io', 'owner/expmargin', 'latest');
      expect(tokenRequests).toBe(2);
    } finally {
      restore();
    }
  });

  test('an opaque token with a short expires_in is refetched inside the margin', async () => {
    let tokenRequests = 0;
    const { restore } = withFetch((url) => {
      const target = String(url);
      if (target === 'https://ghcr.io/v2/') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        }));
      }
      if (target.startsWith('https://ghcr.io/token')) {
        tokenRequests++;
        return Promise.resolve(jsonResponse({ token: 'opaque', expires_in: 10 }));
      }
      return Promise.resolve(new Response(null, { status: 200, headers: { 'Docker-Content-Digest': 'sha256:' + 'f'.repeat(64) } }));
    });
    try {
      await fetchRemoteManifestDigest('ghcr.io', 'owner/shortexp', 'latest');
      await fetchRemoteManifestDigest('ghcr.io', 'owner/shortexp', 'latest');
      expect(tokenRequests).toBe(2);
    } finally {
      restore();
    }
  });

  test('an opaque token with a long expires_in is reused', async () => {
    let tokenRequests = 0;
    const { restore } = withFetch((url) => {
      const target = String(url);
      if (target === 'https://ghcr.io/v2/') {
        return Promise.resolve(new Response(null, {
          status: 401,
          headers: { 'WWW-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' },
        }));
      }
      if (target.startsWith('https://ghcr.io/token')) {
        tokenRequests++;
        return Promise.resolve(jsonResponse({ token: 'opaque', expires_in: 300 }));
      }
      return Promise.resolve(new Response(null, { status: 200, headers: { 'Docker-Content-Digest': 'sha256:' + 'f'.repeat(64) } }));
    });
    try {
      await fetchRemoteManifestDigest('ghcr.io', 'owner/longexp', 'latest');
      await fetchRemoteManifestDigest('ghcr.io', 'owner/longexp', 'latest');
      expect(tokenRequests).toBe(1);
    } finally {
      restore();
    }
  });
});

describe('RegistryCheckError', () => {
  test('is an Error subclass', () => {
    expect(new RegistryCheckError('x')).toBeInstanceOf(Error);
  });
});