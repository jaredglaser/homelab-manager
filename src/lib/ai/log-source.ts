import type { LogLine } from '@/types/ai';

/** Minimal fetch shape; keeps test doubles from having to match `typeof fetch` exactly. */
type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class LogHistoryError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'LogHistoryError';
  }
}

export interface FetchLogHistoryOptions {
  agentUrl: string;
  containerId: string;
  signer: () => Promise<string>;
  since: Date;
  until?: Date;
  maxLines?: number;
  signal?: AbortSignal;
  fetchFn?: FetchFn;
}

function joinAgentUrl(agentUrl: string, path: string): string {
  try {
    const parsed = new URL(agentUrl);
    parsed.pathname = parsed.pathname.replace(/\/$/, '') + path;
    return parsed.toString();
  } catch {
    return `${agentUrl}${path}`;
  }
}

/** Rejects anything that isn't the `{at, stream, text}` shape the agent documents. */
export function parseHistoryLine(raw: string): LogLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const candidate = parsed as { at?: unknown; stream?: unknown; text?: unknown };
  if (typeof candidate.text !== 'string') return null;
  const stream = candidate.stream === 'stderr' ? 'stderr' : 'stdout';
  const at = typeof candidate.at === 'number' && Number.isFinite(candidate.at) ? candidate.at : null;
  return { at, stream, text: candidate.text };
}

export function parseHistoryBody(body: string): LogLine[] {
  return body
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map(parseHistoryLine)
    .filter((line): line is LogLine => line !== null);
}

/**
 * Pulls a container's log history from its host agent for the profiling pass.
 * Buffers the whole response: the agent caps it at `maxLines`, and the profiler
 * needs the full set in hand to sample evenly across it.
 */
export async function fetchLogHistory(options: FetchLogHistoryOptions): Promise<LogLine[]> {
  const params = new URLSearchParams({
    sinceSeconds: String(Math.floor(options.since.getTime() / 1000)),
  });
  if (options.until) params.set('untilSeconds', String(Math.floor(options.until.getTime() / 1000)));
  if (options.maxLines !== undefined) params.set('maxLines', String(options.maxLines));

  const url = `${joinAgentUrl(options.agentUrl, `/logs/${options.containerId}/history`)}?${params}`;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const response = await fetchFn(url, {
    headers: { Authorization: `Bearer ${await options.signer()}` },
    signal: options.signal,
    redirect: 'manual',
  });

  if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
    throw new LogHistoryError('Agent URL returned an unexpected redirect', response.status);
  }
  if (!response.ok) {
    throw new LogHistoryError(`Agent returned ${response.status} for log history`, response.status);
  }

  return parseHistoryBody(await response.text());
}

const TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2}T\S+)\s(.*)$/s;

/**
 * Normalizes a live `/logs/:id` SSE frame into a `LogLine`.
 *
 * The agent's live stream leaves Docker's `timestamps: true` prefix on the
 * text, because the log viewer renders it; the analyst wants the timestamp as
 * a field and the container's own line as the text.
 */
export function normalizeLiveLogFrame(frame: unknown): LogLine | null {
  if (typeof frame !== 'object' || frame === null) return null;
  const candidate = frame as { stream?: unknown; text?: unknown };
  if (typeof candidate.text !== 'string') return null;
  const stream = candidate.stream === 'stderr' ? 'stderr' : 'stdout';

  const match = TIMESTAMP_PATTERN.exec(candidate.text);
  if (!match) return { at: null, stream, text: candidate.text };

  const parsedAt = new Date(match[1]).getTime();
  return {
    at: Number.isNaN(parsedAt) ? null : parsedAt,
    stream,
    text: match[2],
  };
}
