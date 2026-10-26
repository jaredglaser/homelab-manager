import { mock } from 'bun:test';

export function withFetch(impl: (url: string | URL, init?: RequestInit) => Promise<Response>): {
  restore: () => void;
  fetchMock: ReturnType<typeof mock>;
} {
  const fetchMock = mock(impl);
  const original = globalThis.fetch;
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { restore: () => { globalThis.fetch = original; }, fetchMock };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

export const HUB_PROBE = 'https://registry-1.docker.io/v2/';
const HUB_REALM_HEADER = 'Bearer realm="https://auth.docker.io/token",service="registry.docker.io"';

export function hubTokenFlow(fetchMock: ReturnType<typeof mock>, manifestDigest: string | null): void {
  fetchMock.mockImplementation((url) => {
    const target = String(url);
    if (target === HUB_PROBE) {
      return Promise.resolve(new Response(null, { status: 401, headers: { 'WWW-Authenticate': HUB_REALM_HEADER } }));
    }
    if (target.startsWith('https://auth.docker.io/token')) {
      return Promise.resolve(jsonResponse({ token: 'tok' }));
    }
    if (manifestDigest === null) return Promise.resolve(new Response(null, { status: 404 }));
    return Promise.resolve(new Response(null, { status: 200, headers: { 'Docker-Content-Digest': manifestDigest } }));
  });
}