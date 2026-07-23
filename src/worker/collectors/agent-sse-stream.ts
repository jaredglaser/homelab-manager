/**
 * Owns the full agent SSE ingest loop shared by every streaming worker collector
 * (Docker stats, ZFS iostat, container inventory events): URL join, auth header,
 * response validation, redirect guard, frame assembly, heartbeat/comment
 * tolerance, named-event skipping, JSON parsing, and abort handling.
 *
 * Row shaping and per-event validation (zod schemas, error-event detection)
 * stay with each collector; this module only guarantees that what it yields
 * is the parsed JSON body of a `data: ` SSE field.
 */

export class AgentSseStreamError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly agentUrl?: string,
  ) {
    super(message);
    this.name = 'AgentSseStreamError';
  }
}

/** Minimal fetch shape the module needs; avoids requiring test doubles to match `typeof fetch` exactly (e.g. its `preconnect` static). */
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export interface AgentSseConnectOptions {
  /** Base agent URL, e.g. `http://192.168.1.10:9090` (trailing slash tolerated). */
  agentUrl: string;
  /** Endpoint path to append, e.g. `/stats/stream`. */
  path: string;
  signer: () => Promise<string>;
  signal: AbortSignal;
  /** Injectable fetch for testing. Defaults to global fetch. */
  fetchFn?: FetchFn;
}

/**
 * Joins an agent base URL with an endpoint path via `new URL()` so a trailing
 * slash on the configured agent URL (e.g. `http://host:9090/`) doesn't produce
 * a doubled or malformed path. Falls back to naive concatenation if the base
 * URL fails to parse (defensive; `ManagedHost.agentUrl` is normally validated
 * at enrollment, but worker config can be edited directly in the DB).
 */
function joinAgentUrl(agentUrl: string, path: string): string {
  try {
    const parsed = new URL(agentUrl);
    parsed.pathname = parsed.pathname.replace(/\/$/, '') + path;
    return parsed.toString();
  } catch {
    return `${agentUrl}${path}`;
  }
}

/**
 * Connects to an agent SSE endpoint and returns an async generator over the
 * parsed JSON payload of each `data: ` frame. The returned promise resolves
 * only after the response is validated (status, redirect, body present), so
 * callers can treat a resolved connect as "healthy" for their own backoff
 * bookkeeping before consuming the first frame.
 *
 * `redirect: 'manual'` plus the opaqueredirect/3xx check guards against an
 * agent URL that has been repointed (accidentally or maliciously) at a
 * redirecting endpoint, which could otherwise leak the bearer token to an
 * unintended host via the redirected request.
 */
export async function connectAgentSseStream(
  options: AgentSseConnectOptions,
): Promise<AsyncGenerator<unknown, void, void>> {
  const url = joinAgentUrl(options.agentUrl, options.path);
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const response = await fetchFn(url, {
    headers: { Authorization: `Bearer ${await options.signer()}` },
    signal: options.signal,
    redirect: 'manual',
  });

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new AgentSseStreamError('Agent URL returned an unexpected redirect', response.status, url);
  }
  if (!response.ok) {
    throw new AgentSseStreamError(`Agent returned ${response.status}: ${response.statusText}`, response.status, url);
  }
  if (!response.body) {
    throw new AgentSseStreamError('Agent response has no body', undefined, url);
  }

  return readFrames(response.body, options.signal);
}

async function* readFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<unknown, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const messages = buffer.split('\n\n');
      // Keep the last incomplete chunk in the buffer for the next read.
      buffer = messages.pop() ?? '';

      for (const message of messages) {
        if (signal.aborted) break;
        if (!message.trim()) continue;

        const lines = message.split('\n');
        // Named events (e.g. "event: containers") carry a different payload shape
        // than default stats/event frames; only default `data:` frames are stats.
        if (lines.some((line) => line.startsWith('event:'))) continue;

        const dataLine = lines.find((line) => line.startsWith('data: '));
        // No `data:` field: a heartbeat comment frame (bare `:` line, sent by the
        // #322 agent-side keepalive fix) or some other non-data SSE field. Both
        // are silently skipped rather than logged; they are expected traffic.
        if (!dataLine) continue;

        const jsonStr = dataLine.slice(6);
        try {
          yield JSON.parse(jsonStr);
        } catch {
          console.error(`[AgentSseStream] Dropped malformed SSE frame: ${jsonStr.slice(0, 100)}`);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
