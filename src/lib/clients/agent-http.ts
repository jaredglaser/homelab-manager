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

export const MISSING_PIN_CLOSE_REASON = `No pinned TLS certificate. ${MISSING_PIN_RECOVERY_HINT}`;

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
 * The only sanctioned way to fetch an agent URL. An https URL with no pinned cert throws here
 * instead of failing TLS verification deeper in the stack, which the caller retries as a fake
 * agent outage.
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
 * WebSocket counterpart of agentFetch with the same wss-pinning invariant. Bun accepts the
 * header/tls options object here, and the DOM lib types only allow protocol strings, hence the cast.
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
