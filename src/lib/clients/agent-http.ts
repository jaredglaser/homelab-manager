// Bun fetch pinned 1.4.2 ignores a node:https Agent dispatcher but honors its native tls option.
export interface AgentTlsContext {
  /** PEM of the pinned per-host certificate; null or absent means no pinning. */
  caCertPem?: string | null;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface RequestInitWithTls extends RequestInit {
  tls?: { ca: string; rejectUnauthorized: boolean };
}

export async function agentFetch(
  url: string,
  init: RequestInit,
  tls: AgentTlsContext = {},
  fetchImpl: FetchFn = fetch,
): Promise<Response> {
  const caCertPem = tls.caCertPem?.trim();
  if (!caCertPem || !isHttps(url)) {
    return fetchImpl(url, init);
  }
  const initWithTls: RequestInitWithTls = { ...init, tls: { ca: caCertPem, rejectUnauthorized: true } };
  return fetchImpl(url, initWithTls as RequestInit);
}

function isHttps(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}
