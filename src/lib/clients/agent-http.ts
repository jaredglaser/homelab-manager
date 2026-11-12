// Bun fetch pinned 1.4.2 ignores a node:https Agent dispatcher but honors its native tls option.
export interface AgentTlsContext {
  /** PEM of the pinned per-host certificate. http/ws URLs ignore it. An https/wss URL without it refuses to connect. */
  caCertPem?: string | null;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

interface RequestInitWithTls extends RequestInit {
  tls?: { ca: string; rejectUnauthorized: boolean };
}

export const MISSING_PIN_RECOVERY_HINT = 'See the agent TLS recovery steps in the self-hosting guide.';

const MISSING_CERT_MESSAGE =
  `No pinned TLS certificate for this HTTPS agent URL, so the manager cannot verify the agent. ${MISSING_PIN_RECOVERY_HINT}`;

export function missingPinMessage(host: string): string {
  return `No pinned TLS certificate for host: ${host}. ${MISSING_PIN_RECOVERY_HINT}`;
}

/** True for URL schemes whose TLS handshake needs the pinned per-host certificate (https, wss). */
export function isTlsUrl(url: string): boolean {
  try {
    const protocol = new URL(url).protocol;
    return protocol === 'https:' || protocol === 'wss:';
  } catch {
    return false;
  }
}

/**
 * The only sanctioned way to fetch an agent URL. Every call site must pass an
 * explicit AgentTlsContext (the host's pinned certificate, or null for http
 * agent URLs) so a caller cannot silently skip TLS pinning: an https URL
 * without a pinned cert throws instead of failing TLS verification deep in
 * the stack while the adapter retries forever as a fake agent outage.
 */
export async function agentFetch(
  url: string,
  init: RequestInit,
  tls: AgentTlsContext,
  fetchImpl: FetchFn = fetch,
): Promise<Response> {
  const caCertPem = tls.caCertPem?.trim();
  if (!isTlsUrl(url)) {
    return fetchImpl(url, init);
  }
  if (!caCertPem) {
    throw new Error(MISSING_CERT_MESSAGE);
  }
  const initWithTls: RequestInitWithTls = { ...init, tls: { ca: caCertPem, rejectUnauthorized: true } };
  return fetchImpl(url, initWithTls as RequestInit);
}

interface AgentWebSocketOptions {
  headers?: Record<string, string>;
}

interface WebSocketOptionsWithTls extends AgentWebSocketOptions {
  tls?: { ca: string; rejectUnauthorized: boolean };
}

/**
 * WebSocket counterpart of agentFetch for the server-to-agent hop (exec
 * terminal bridge). Same invariant: a wss agent URL requires the host's pinned
 * certificate, passed explicitly, or the handshake is refused up front. Bun's
 * WebSocket accepts the header/tls options object. The DOM lib types only
 * allow protocol strings, hence the cast.
 */
export function openAgentWebSocket(url: string, options: AgentWebSocketOptions, tls: AgentTlsContext): WebSocket {
  const caCertPem = tls.caCertPem?.trim();
  if (!isTlsUrl(url)) {
    // Only pass the options object when there are headers: DOM-standard WebSocket
    // constructors interpret a second argument as a protocols list, and Bun's
    // header object is only meaningful when headers are actually set.
    const hasHeaders = options.headers !== undefined && Object.keys(options.headers).length > 0;
    return hasHeaders ? new WebSocket(url, options as unknown as string[]) : new WebSocket(url);
  }
  if (!caCertPem) {
    throw new Error(MISSING_CERT_MESSAGE);
  }
  const optionsWithTls: WebSocketOptionsWithTls = {
    ...options,
    tls: { ca: caCertPem, rejectUnauthorized: true },
  };
  return new WebSocket(url, optionsWithTls as unknown as string[]);
}
