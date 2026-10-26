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