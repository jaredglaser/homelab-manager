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

/** The refusal agentFetch throws when a TLS agent URL has no pinned certificate. */
export class AgentTlsPinMissingError extends Error {
  readonly code = 'pin_missing' as const;

  constructor() {
    super(MISSING_CERT_MESSAGE);
    this.name = 'AgentTlsPinMissingError';
  }
}

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
    throw new AgentTlsPinMissingError();
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
    throw new AgentTlsPinMissingError();
  }
  const optionsWithTls: WebSocketOptionsWithTls = {
    ...options,
    tls: { ca: caCertPem, rejectUnauthorized: true },
  };
  return new WebSocket(url, optionsWithTls as unknown as string[]);
}

/** True for the refusal agentFetch throws when a TLS agent URL has no pinned certificate. */
export function isMissingPinError(err: unknown): boolean {
  return err instanceof AgentTlsPinMissingError;
}

const CERTIFICATE_REJECTION_CODES: ReadonlySet<string> = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_REVOKED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/** True when TLS verification refused the certificate the agent presented, read off the error's code and never its message. */
export function isCertificateRejectionError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && CERTIFICATE_REJECTION_CODES.has(code);
}

/** The plain-HTTP sibling of a TLS agent URL, which is the address an agent without a certificate serves. */
export function toPlainHttpUrl(parsed: URL): string {
  const http = new URL(parsed.toString());
  http.protocol = 'http:';
  return http.toString().replace(/\/$/, '');
}

// A proxy's error page can stand in for the agent's reply, and the whole body would reach the operator's row.
const MAX_AGENT_FAILURE_DETAIL_CHARS = 300;
export const MAX_AGENT_FAILURE_BODY_BYTES = 8192;

export async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } catch {
    return text;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

// Control characters include newlines, so a plain-text body cannot start a forged log line.
export function singleLine(text: string): string {
  const flat = text.replace(/\p{Cc}+/gu, ' ').trim();
  return flat.length > MAX_AGENT_FAILURE_DETAIL_CHARS ? `${flat.slice(0, MAX_AGENT_FAILURE_DETAIL_CHARS)}...` : flat;
}
