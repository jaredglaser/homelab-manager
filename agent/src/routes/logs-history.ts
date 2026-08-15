import type Dockerode from 'dockerode';
import { extractTimestamp, parseMuxedChunk, parseTtyChunk } from '../lib/log-parse';
import { isContainerGone } from './stats';

/**
 * Ceiling on a single history request. A week of a chatty container is
 * unbounded; the caller down-samples anyway, so refusing to buffer more than
 * this is cheaper than streaming a gigabyte the analyst will discard.
 */
export const MAX_HISTORY_LINES = 50_000;
const DEFAULT_HISTORY_LINES = 5_000;

export interface HistoryQuery {
  sinceSeconds: number | null;
  untilSeconds: number | null;
  maxLines: number;
}

export class InvalidHistoryQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidHistoryQueryError';
  }
}

function parseNumeric(raw: string | null, label: string): number | null {
  if (raw === null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new InvalidHistoryQueryError(`Invalid ${label}: '${raw}'`);
  }
  return value;
}

export function parseHistoryQuery(params: URLSearchParams): HistoryQuery {
  const sinceSeconds = parseNumeric(params.get('sinceSeconds'), 'sinceSeconds');
  const untilSeconds = parseNumeric(params.get('untilSeconds'), 'untilSeconds');
  const rawMax = parseNumeric(params.get('maxLines'), 'maxLines');
  const maxLines = rawMax === null ? DEFAULT_HISTORY_LINES : Math.min(MAX_HISTORY_LINES, Math.floor(rawMax));
  if (maxLines < 1) {
    throw new InvalidHistoryQueryError(`Invalid maxLines: '${params.get('maxLines')}'`);
  }
  if (sinceSeconds !== null && untilSeconds !== null && untilSeconds < sinceSeconds) {
    throw new InvalidHistoryQueryError('untilSeconds must not precede sinceSeconds');
  }
  return { sinceSeconds, untilSeconds, maxLines };
}

/**
 * Fetch a bounded slice of a container's log history as newline-delimited JSON.
 *
 * Unlike `/logs/:id`, this does not follow: it answers once and closes, which
 * is what the log-analysis profiler needs when it reads a week of history to
 * author a container's analysis skill. Each line is
 * `{"at":<epoch ms|null>,"stream":"stdout"|"stderr","text":"..."}`.
 */
export async function handleLogHistory(
  docker: Dockerode,
  containerId: string,
  url: URL,
): Promise<Response> {
  let query: HistoryQuery;
  try {
    query = parseHistoryQuery(url.searchParams);
  } catch (error) {
    if (error instanceof InvalidHistoryQueryError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  try {
    const container = docker.getContainer(containerId);
    const info = await container.inspect();
    const isTty = info.Config?.Tty ?? false;

    const raw = await container.logs({
      follow: false,
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: query.maxLines,
      ...(query.sinceSeconds !== null ? { since: query.sinceSeconds } : {}),
      ...(query.untilSeconds !== null ? { until: query.untilSeconds } : {}),
    });

    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
    const parsed = isTty ? parseTtyChunk(buffer) : parseMuxedChunk(buffer).lines;

    const body = parsed
      .slice(-query.maxLines)
      .map((line) => {
        const stamp = extractTimestamp(line.text);
        const at = stamp === null ? null : new Date(stamp).getTime();
        // Docker prefixes each line with the timestamp we just read; strip it so
        // the consumer gets the container's own output and nothing of ours.
        const text = stamp === null ? line.text : line.text.slice(stamp.length + 1);
        return JSON.stringify({ at: Number.isNaN(at as number) ? null : at, stream: line.stream, text });
      })
      .join('\n');

    return new Response(body.length > 0 ? `${body}\n` : '', {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof Error && isContainerGone(error)) {
      return Response.json({ error: 'Container not found' }, { status: 404 });
    }
    console.error(`Failed to read log history for container ${containerId}:`, error);
    return Response.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
