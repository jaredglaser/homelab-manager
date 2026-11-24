import { describe, test, expect, mock } from 'bun:test';
import { resolveAgentImageDigest, resolveAgentImageRelease } from '@/lib/hosts/agent-image-digest';
import { AGENT_SOURCE_HASH_LABEL } from '@homelab-manager/agent/types';

const REPO = 'ghcr.io/jaredglaser/homelab-manager-agent';
const DIGEST = 'sha256:' + 'a'.repeat(64);

function withFetch(impl: (url: string, init?: RequestInit) => Promise<Response>): { restore: () => void; fetchMock: ReturnType<typeof mock> } {
  const fetchMock = mock(impl);
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, fetchMock };
}

function manifestResponse(status: number, headers?: Record<string, string>, body?: string): Response {
  return new Response(body ?? '{}', { status, headers });
}

describe('resolveAgentImageDigest', () => {
  test('returns the Docker-Content-Digest header for a public image', async () => {
    const { restore, fetchMock } = withFetch(() =>
      Promise.resolve(manifestResponse(200, { 'Docker-Content-Digest': DIGEST })),
    );
    try {
      const digest = await resolveAgentImageDigest(`${REPO}:latest`);
      expect(digest).toBe(DIGEST);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://ghcr.io/v2/jaredglaser/homelab-manager-agent/manifests/latest',
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: expect.stringContaining('application/vnd.oci.image.index.v1+json') }),
        }),
      );
    } finally {
      restore();
    }
  });

  test('falls back to the manifest body digest field when the header is absent', async () => {
    const { restore } = withFetch(() =>
      Promise.resolve(manifestResponse(200, {}, JSON.stringify({ digest: DIGEST }))),
    );
    try {
      expect(await resolveAgentImageDigest(`${REPO}:v1.2.3`)).toBe(DIGEST);
    } finally {
      restore();
    }
  });

  test('rejects a digest-shaped value that is not a valid sha256', async () => {
    const { restore } = withFetch(() =>
      Promise.resolve(manifestResponse(200, { 'Docker-Content-Digest': 'sha256:zzz' })),
    );
    try {
      expect(await resolveAgentImageDigest(`${REPO}:latest`)).toBeNull();
    } finally {
      restore();
    }
  });

  test('retries a 401 with an anonymous pull token from the Bearer challenge', async () => {
    const token = 'tok-' + 'x'.repeat(8);
    const { restore, fetchMock } = withFetch((url, init) => {
      if (String(url).includes('/token?')) {
        return Promise.resolve(manifestResponse(200, {}, JSON.stringify({ token })));
      }
      const auth = (init?.headers as Record<string, string>).Authorization;
      if (!auth) {
        return Promise.resolve(manifestResponse(401, {
          'Www-Authenticate': `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:jaredglaser/homelab-manager-agent:pull"`,
        }));
      }
      expect(auth).toBe('Bearer ' + token);
      return Promise.resolve(manifestResponse(200, { 'Docker-Content-Digest': DIGEST }));
    });
    try {
      const digest = await resolveAgentImageDigest(`${REPO}:latest`);
      expect(digest).toBe(DIGEST);
      const tokenCall = fetchMock.mock.calls.find(([url]) => String(url).includes('/token?'));
      expect(tokenCall).toBeDefined();
      expect(String(tokenCall?.[0])).toBe(
        'https://ghcr.io/token?service=ghcr.io&scope=repository%3Ajaredglaser%2Fhomelab-manager-agent%3Apull',
      );
    } finally {
      restore();
    }
  });

  test('returns null when the token endpoint fails', async () => {
    const { restore } = withFetch((url) => {
      if (String(url).includes('/token?')) return Promise.resolve(manifestResponse(403));
      return Promise.resolve(manifestResponse(401, {
        'Www-Authenticate': 'Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:x:y"',
      }));
    });
    try {
      expect(await resolveAgentImageDigest(`${REPO}:latest`)).toBeNull();
    } finally {
      restore();
    }
  });

  test.each([
    [401, 'private image'],
    [403, 'forbidden'],
    [404, 'unknown tag'],
    [500, 'registry error'],
  ])('returns null on %i (%s)', async (status) => {
    const { restore } = withFetch(() => Promise.resolve(manifestResponse(status)));
    try {
      expect(await resolveAgentImageDigest(`${REPO}:latest`)).toBeNull();
    } finally {
      restore();
    }
  });

  test('returns null when the manifest request throws', async () => {
    const { restore } = withFetch(() => Promise.reject(new Error('ECONNREFUSED')));
    try {
      expect(await resolveAgentImageDigest(`${REPO}:latest`)).toBeNull();
    } finally {
      restore();
    }
  });

  test('returns null for a reference without a tag', async () => {
    const { restore, fetchMock } = withFetch(() => Promise.resolve(manifestResponse(200)));
    try {
      expect(await resolveAgentImageDigest(REPO)).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

async function sha256Of(text: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return 'sha256:' + Array.from(hash, (b) => b.toString(16).padStart(2, '0')).join('');
}

const PLATFORM_DIGEST = 'sha256:' + 'b'.repeat(64);
const SOURCE_HASH = 'e'.repeat(64);

async function registry(opts: { label?: string; tamper?: boolean; indexDigest?: string } = {}) {
  const config = JSON.stringify({ config: { Labels: opts.label === undefined ? {} : { [AGENT_SOURCE_HASH_LABEL]: opts.label } } });
  const configDigest = await sha256Of(config);
  const indexDigest = opts.indexDigest ?? DIGEST;
  return withFetch((url) => {
    const u = String(url);
    if (u.endsWith('/manifests/main')) {
      return Promise.resolve(manifestResponse(200, { 'Docker-Content-Digest': indexDigest }, JSON.stringify({
        manifests: [
          { digest: 'sha256:' + '9'.repeat(64), platform: { os: 'unknown', architecture: 'unknown' } },
          { digest: PLATFORM_DIGEST, platform: { os: 'linux', architecture: 'amd64' } },
        ],
      })));
    }
    if (u.endsWith(`/manifests/${PLATFORM_DIGEST}`)) {
      return Promise.resolve(manifestResponse(200, {}, JSON.stringify({ config: { digest: configDigest } })));
    }
    if (u.endsWith(`/blobs/${configDigest}`)) {
      return Promise.resolve(new Response(null, { status: 307, headers: { Location: 'https://pkg-containers.example/blob' } }));
    }
    if (u === 'https://pkg-containers.example/blob') {
      return Promise.resolve(new Response(opts.tamper ? config + ' ' : config, { status: 200 }));
    }
    return Promise.resolve(manifestResponse(404));
  });
}

describe('resolveAgentImageRelease', () => {
  test('reads the source hash label through the platform manifest and the redirected config blob', async () => {
    const { restore, fetchMock } = await registry({ label: SOURCE_HASH, indexDigest: 'sha256:' + '1'.repeat(64) });
    try {
      expect(await resolveAgentImageRelease(`${REPO}:main`)).toEqual({ digest: 'sha256:' + '1'.repeat(64), sourceHash: SOURCE_HASH });
      const storageCall = fetchMock.mock.calls.find(([url]) => String(url) === 'https://pkg-containers.example/blob');
      expect((storageCall?.[1] as RequestInit | undefined)?.headers).toBeUndefined();
    } finally {
      restore();
    }
  });

  test('reads a digest it has seen from the cache, with one registry call', async () => {
    const { restore, fetchMock } = await registry({ label: SOURCE_HASH, indexDigest: 'sha256:' + '2'.repeat(64) });
    try {
      await resolveAgentImageRelease(`${REPO}:main`);
      fetchMock.mockClear();
      expect(await resolveAgentImageRelease(`${REPO}:main`)).toEqual({ digest: 'sha256:' + '2'.repeat(64), sourceHash: SOURCE_HASH });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });

  test('keeps the digest with a null hash for an image built without the label', async () => {
    const { restore } = await registry({ indexDigest: 'sha256:' + '3'.repeat(64) });
    try {
      expect(await resolveAgentImageRelease(`${REPO}:main`)).toEqual({ digest: 'sha256:' + '3'.repeat(64), sourceHash: null });
    } finally {
      restore();
    }
  });

  test('ignores a config blob whose bytes do not match its digest', async () => {
    const { restore } = await registry({ label: SOURCE_HASH, tamper: true, indexDigest: 'sha256:' + '4'.repeat(64) });
    try {
      expect(await resolveAgentImageRelease(`${REPO}:main`)).toEqual({ digest: 'sha256:' + '4'.repeat(64), sourceHash: null });
    } finally {
      restore();
    }
  });

  test('rejects a label that is not a sha256 hex hash', async () => {
    const { restore } = await registry({ label: 'not-a-hash', indexDigest: 'sha256:' + '5'.repeat(64) });
    try {
      expect((await resolveAgentImageRelease(`${REPO}:main`))?.sourceHash).toBeNull();
    } finally {
      restore();
    }
  });

  test('returns null when the digest itself is unresolvable', async () => {
    const { restore } = withFetch(() => Promise.resolve(manifestResponse(404)));
    try {
      expect(await resolveAgentImageRelease(`${REPO}:main`)).toBeNull();
    } finally {
      restore();
    }
  });
});
