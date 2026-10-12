import { describe, test, expect, mock } from 'bun:test';
import { resolveAgentImageDigest } from '@/lib/hosts/agent-image-digest';

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
