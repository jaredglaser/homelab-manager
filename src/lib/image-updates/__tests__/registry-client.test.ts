import { describe, expect, mock, test } from 'bun:test';
import { checkImageUpdate, fetchRemoteManifestDigest, sourceRepoFromLabels } from '../registry-client';

function withFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): { restore: () => void; fetchMock: ReturnType<typeof mock> } {
  const fetchMock = mock(impl);
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, fetchMock };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

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
      const summary = await checkImageUpdate('ghcr.io/owner/app:1.0', {});
      expect(summary.updateAvailable).toBe(true);
      expect(summary.latestMatchingTag).toBe('1.0.5');
      expect(summary.latestOverallTag).toBe('1.1.0');
      expect(fetchMock.mock.calls.length).toBe(3);
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

  test('a realm pointing at another host is rejected', async () => {
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
      expect(summary.error).toContain('unexpected host');
      expect(fetchMock.mock.calls.length).toBe(1);
    } finally {
      restore();
    }
  });

  test('v2 tag listing follows Link pagination', async () => {
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
      expect(String(url)).toBe('https://ghcr.io/v2/owner/app/manifests/latest');
      return Promise.resolve(new Response(null, {
        status: 200,
        headers: { 'Docker-Content-Digest': 'sha256:' + 'c'.repeat(64) },
      }));
    });
    try {
      const digest = await fetchRemoteManifestDigest('ghcr.io', 'owner/app', 'latest');
      expect(digest).toBe('sha256:' + 'c'.repeat(64));
      expect(fetchMock.mock.calls[0][1]?.method).toBe('HEAD');
    } finally {
      restore();
    }
  });

  test('a vanished tag returns null', async () => {
    const { restore } = withFetch(() => Promise.resolve(new Response(null, { status: 404 })));
    try {
      expect(await fetchRemoteManifestDigest('ghcr.io', 'owner/app', 'latest')).toBeNull();
    } finally {
      restore();
    }
  });

  test('docker.io HEADs registry-1.docker.io, not the Hub API', async () => {
    const { restore } = withFetch((url) => {
      if (String(url).endsWith('/v2/')) return Promise.resolve(new Response(null, { status: 200 }));
      expect(String(url)).toBe('https://registry-1.docker.io/v2/library/redis/manifests/latest');
      return Promise.resolve(new Response(null, { status: 200, headers: { 'Docker-Content-Digest': 'sha256:' + 'd'.repeat(64) } }));
    });
    try {
      expect(await fetchRemoteManifestDigest('docker.io', 'library/redis', 'latest')).toBe('sha256:' + 'd'.repeat(64));
    } finally {
      restore();
    }
  });
});

describe('checkImageUpdate: floating tags', () => {
  test('a moved digest flags an update without listing tags', async () => {
    const { restore, fetchMock } = withFetch((url) => {
      if (String(url) === 'https://ghcr.io/v2/') return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(null, { status: 200, headers: { 'Docker-Content-Digest': 'sha256:' + 'b'.repeat(64) } }));
    });
    try {
      const summary = await checkImageUpdate('myapp:latest', {}, 'sha256:' + 'a'.repeat(64));
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
      const summary = await checkImageUpdate('myapp:latest', {}, 'sha256:' + 'a'.repeat(64));
      expect(summary.updateAvailable).toBe(false);
    } finally {
      restore();
    }
  });

  test('no local digest stays inconclusive without any registry call', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(new Response(null, { status: 200 })));
    try {
      const summary = await checkImageUpdate('myapp:latest', {}, null);
      expect(summary.updateAvailable).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  test('a HEAD failure lands in error, not a throw', async () => {
    const { restore } = withFetch(() => Promise.reject(new Error('registry down')));
    try {
      const summary = await checkImageUpdate('myapp:latest', {}, 'sha256:' + 'a'.repeat(64));
      expect(summary.updateAvailable).toBeNull();
      expect(summary.error).toContain('registry down');
    } finally {
      restore();
    }
  });
});
