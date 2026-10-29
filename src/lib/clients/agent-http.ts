// Bun fetch pinned 1.4.2 ignores a node:https Agent dispatcher but honors its native tls option.
export interface AgentTlsContext {
  /** PEM of the pinned per-host certificate. http URLs ignore it. An https URL without it refuses to connect. */
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
  if (!isHttps(url)) {
    return fetchImpl(url, init);
  }
  if (!caCertPem) {
    throw new Error('No pinned TLS certificate for this HTTPS agent URL: run TLS enrollment for the host, then retry');
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
