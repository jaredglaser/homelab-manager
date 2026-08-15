import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolContext } from '@/lib/mcp/context';
import {
  zEntityId,
  zTime,
  parseEntityId,
  resolveWindow,
  hasScope,
  iso,
  truncateText,
  encodeCursor,
  decodeCursor,
  McpToolError,
  ok,
  fail,
} from '@/lib/mcp/shared';
import type { ResolvedWindow } from '@/lib/mcp/shared';

const AGENT_FETCH_TIMEOUT_MS = 20_000;
/** Bounds memory while reading an agent response; well above any legitimate history/search payload. */
const AGENT_BODY_MAX_BYTES = 20_000_000;

const GET_LOGS_DEFAULT_SINCE_SECONDS = 900;
const GET_LOGS_MAX_SPAN_SECONDS = 7 * 86400;

const SEARCH_LOGS_DEFAULT_SINCE_SECONDS = 3600;
const SEARCH_LOGS_MAX_SPAN_SECONDS = 7 * 86400;
const SEARCH_LOGS_TIME_BUDGET_MS = 2000;
const SEARCH_LOGS_BUDGET_CHECK_INTERVAL = 512;
/** Caps the text handed to regex.test() so a pathological pattern can't hang on one long line. */
const SEARCH_LOGS_REGEX_TEST_MAX_CHARS = 10_000;

interface OutLine {
  at: string | null;
  stream: 'stdout' | 'stderr';
  text: string;
  truncated: boolean;
}

const zRawLogLine = z.object({
  at: z.string().nullable(),
  stream: z.enum(['stdout', 'stderr']),
  text: z.string(),
});

type RawLogLine = z.infer<typeof zRawLogLine>;

function parseNdjsonLines(body: string): RawLogLine[] {
  if (body.length === 0) return [];
  const lines: RawLogLine[] = [];
  for (const raw of body.split('\n')) {
    if (raw.length === 0) continue;
    const parsed = zRawLogLine.safeParse(JSON.parse(raw));
    if (parsed.success) lines.push(parsed.data);
  }
  return lines;
}

function buildHistoryPath(containerId: string, sinceSeconds: number, untilSeconds: number, maxLines: number): string {
  const params = new URLSearchParams({
    sinceSeconds: String(sinceSeconds),
    untilSeconds: String(untilSeconds),
    maxLines: String(maxLines),
  });
  return `/logs/${encodeURIComponent(containerId)}/history?${params.toString()}`;
}

/** Reads the body as a stream, stopping once maxBytes is exceeded, so a misbehaving agent can't force unbounded buffering. */
async function readCappedBody(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  } catch {
    return '';
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buf.subarray(0, maxBytes).toString('utf8');
}

async function agentFailureToToolError(res: Response): Promise<McpToolError> {
  const body = await readCappedBody(res, 2048);
  if (res.status === 404) {
    return new McpToolError('unknown_container', body || `No container found for that entity id (agent returned 404)`);
  }
  return new McpToolError('agent_error', body || `Agent returned HTTP ${res.status}`);
}

async function fetchAgentHistory(
  ctx: McpToolContext,
  host: string,
  containerId: string,
  sinceSeconds: number,
  untilSeconds: number,
  maxLines: number,
): Promise<{ ok: true; res: Response } | { ok: false; result: CallToolResult }> {
  const path = buildHistoryPath(containerId, sinceSeconds, untilSeconds, maxLines);
  let res: Response;
  try {
    res = await ctx.callAgent(host, path, { signal: AbortSignal.timeout(AGENT_FETCH_TIMEOUT_MS) });
  } catch (err) {
    if (err instanceof McpToolError) return { ok: false, result: fail(err) };
    return { ok: false, result: fail(new McpToolError('host_unreachable', `Could not reach the agent on host '${host}'`)) };
  }
  if (!res.ok) {
    return { ok: false, result: fail(await agentFailureToToolError(res)) };
  }
  return { ok: true, res };
}

const logLineOutputShape = z.object({
  at: z.string().nullable(),
  stream: z.enum(['stdout', 'stderr']),
  text: z.string(),
  truncated: z.boolean(),
});

const GET_LOGS_DESCRIPTION = `Read a bounded slice of one container's log history. Prefer \`search_logs\` whenever you are looking for something specific such as an error string, an exception class, or a request id: \`search_logs\` greps on the server and returns only matching lines, while this tool returns every line in the window and will burn your context on a chatty container. Use \`get_logs\` to read the lines around a timestamp you have already identified, or when you genuinely need continuous output. Lines are returned oldest first within a page, but pages walk backwards in time: the first page is the end of the window, and \`nextCursor\` fetches the slice immediately before it. Logs are read live from the host agent, so a destroyed container or an offline host returns an error instead of history; the monitor keeps no copy.`;

interface GetLogsCursor {
  v: 1;
  e: string;
  before: string;
  since: number;
}

const getLogsInputShape = {
  entityId: zEntityId,
  since: zTime.optional(),
  until: zTime.optional(),
  limit: z.number().int().min(1).max(1000).default(200),
  stream: z.enum(['stdout', 'stderr', 'all']).default('all'),
  maxLineChars: z.number().int().min(80).max(4000).default(512),
  cursor: z.string().optional(),
};

const getLogsOutputShape = {
  entityId: z.string(),
  window: z.object({ from: z.string(), to: z.string() }),
  lines: z.array(logLineOutputShape),
  count: z.number(),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  truncationReason: z.enum(['line_limit', 'unparsable_timestamp_boundary']).nullable(),
};

function registerGetLogs(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'get_logs',
    {
      title: 'Get container logs',
      description: GET_LOGS_DESCRIPTION,
      inputSchema: getLogsInputShape,
      outputSchema: getLogsOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const { host, containerId } = parseEntityId(input.entityId);

      let cursor: GetLogsCursor | undefined;
      if (input.cursor !== undefined) {
        try {
          cursor = decodeCursor<GetLogsCursor>(input.cursor);
        } catch (err) {
          if (err instanceof McpToolError) return fail(err);
          throw err;
        }
        if (cursor.e !== input.entityId) {
          return fail(new McpToolError('invalid_cursor', 'Cursor was issued for a different entityId'));
        }
      }

      let sinceSeconds: number;
      let untilSeconds: number;
      let windowFrom: Date;
      let windowTo: Date;

      if (cursor) {
        const beforeMs = Date.parse(cursor.before);
        if (!Number.isInteger(cursor.since) || cursor.since < 0 || Number.isNaN(beforeMs)) {
          return fail(new McpToolError('invalid_cursor', 'Cursor contains an invalid window boundary'));
        }
        sinceSeconds = cursor.since;
        untilSeconds = Math.ceil(beforeMs / 1000);
        if (untilSeconds <= sinceSeconds) {
          return fail(new McpToolError('invalid_cursor', 'Cursor window is empty or inverted'));
        }
        const cursorSpanSeconds = untilSeconds - sinceSeconds;
        if (cursorSpanSeconds > GET_LOGS_MAX_SPAN_SECONDS) {
          return fail(
            new McpToolError(
              'window_too_large',
              `The cursor window spans ${cursorSpanSeconds}s, which exceeds the ${GET_LOGS_MAX_SPAN_SECONDS}s cap for this tool`,
            ),
          );
        }
        windowFrom = new Date(sinceSeconds * 1000);
        windowTo = new Date(untilSeconds * 1000);
      } else {
        let window: ResolvedWindow;
        try {
          window = resolveWindow(
            { since: input.since, until: input.until },
            { defaultSinceSeconds: GET_LOGS_DEFAULT_SINCE_SECONDS, maxSpanSeconds: GET_LOGS_MAX_SPAN_SECONDS },
          );
        } catch (err) {
          if (err instanceof McpToolError) return fail(err);
          throw err;
        }
        sinceSeconds = Math.floor(window.from.getTime() / 1000);
        untilSeconds = Math.ceil(window.to.getTime() / 1000);
        windowFrom = window.from;
        windowTo = window.to;
      }

      const fetched = await fetchAgentHistory(ctx, host, containerId, sinceSeconds, untilSeconds, input.limit);
      if (!fetched.ok) return fetched.result;

      const body = await readCappedBody(fetched.res, AGENT_BODY_MAX_BYTES);
      let rawLines = parseNdjsonLines(body);

      if (cursor) {
        // A null-at line has no reliable position to dedupe by, so drop it past page one.
        const before = cursor.before;
        rawLines = rawLines.filter((l) => l.at !== null && l.at < before);
      }

      const filteredLines = input.stream === 'all' ? rawLines : rawLines.filter((l) => l.stream === input.stream);

      const outLines: OutLine[] = filteredLines.map((l) => {
        const t = truncateText(l.text, input.maxLineChars);
        return { at: l.at, stream: l.stream, text: t.text, truncated: t.truncated };
      });

      let hasMore = false;
      let nextCursor: string | null = null;
      let truncationReason: 'line_limit' | 'unparsable_timestamp_boundary' | null = null;

      // Based on the raw fetch, not outLines: a stream filter can leave far fewer lines
      // than input.limit even when the agent's tail hit the cap and older data remains.
      if (rawLines.length === input.limit) {
        const oldestRaw = rawLines[0];
        if (oldestRaw.at !== null) {
          hasMore = true;
          truncationReason = 'line_limit';
          nextCursor = encodeCursor({ v: 1, e: input.entityId, before: oldestRaw.at, since: sinceSeconds });
        } else {
          truncationReason = 'unparsable_timestamp_boundary';
        }
      }

      return ok({
        entityId: input.entityId,
        window: { from: iso(windowFrom), to: iso(windowTo) },
        lines: outLines,
        count: outLines.length,
        hasMore,
        nextCursor,
        truncationReason,
      });
    },
  );
}

const SEARCH_LOGS_DESCRIPTION = `Grep one container's log history on the server and get back only the matching lines. Reach for this on almost every log question: it scans up to \`scanLines\` lines server-side and returns at most \`limit\` matches, so a day of a chatty container costs a few hundred tokens instead of megabytes. Use it to find error text, exception classes, restart banners, or a request id, then read around a hit using \`contextBefore\` and \`contextAfter\` here, or by passing the hit's \`at\` timestamp to \`get_logs\`. \`pattern\` is a JavaScript regular expression, case insensitive unless you set \`caseSensitive\`. Do not pull a window with \`get_logs\` and scan it yourself when a pattern would do. Because the agent returns the newest lines in the window first, check \`scanTruncated\` and \`scannedFrom\` before concluding that something never appeared: they tell you how far back the scan actually reached.`;

const searchLogsInputShape = {
  entityId: zEntityId,
  pattern: z.string().min(1).max(256),
  caseSensitive: z.boolean().default(false),
  since: zTime.optional(),
  until: zTime.optional(),
  stream: z.enum(['stdout', 'stderr', 'all']).default('all'),
  limit: z.number().int().min(1).max(200).default(50),
  scanLines: z.number().int().min(100).max(50000).default(20000),
  contextBefore: z.number().int().min(0).max(5).default(0),
  contextAfter: z.number().int().min(0).max(5).default(0),
  maxLineChars: z.number().int().min(80).max(2000).default(300),
};

const searchLogsOutputShape = {
  entityId: z.string(),
  pattern: z.string(),
  window: z.object({ from: z.string(), to: z.string() }),
  matches: z.array(
    z.object({
      at: z.string().nullable(),
      stream: z.enum(['stdout', 'stderr']),
      text: z.string(),
      truncated: z.boolean(),
      before: z.array(logLineOutputShape),
      after: z.array(logLineOutputShape),
    }),
  ),
  returned: z.number(),
  matchCount: z.number(),
  scannedLines: z.number(),
  scanTruncated: z.boolean(),
  scannedFrom: z.string().nullable(),
  stopReason: z.enum(['limit', 'time_budget']).nullable(),
};

interface MatchLine extends OutLine {
  before: OutLine[];
  after: OutLine[];
}

function registerSearchLogs(server: McpServer, ctx: McpToolContext): void {
  server.registerTool(
    'search_logs',
    {
      title: 'Search container logs',
      description: SEARCH_LOGS_DESCRIPTION,
      inputSchema: searchLogsInputShape,
      outputSchema: searchLogsOutputShape,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (input) => {
      const { host, containerId } = parseEntityId(input.entityId);

      let regex: RegExp;
      try {
        regex = new RegExp(input.pattern, input.caseSensitive ? '' : 'i');
      } catch (err) {
        return fail(new McpToolError('invalid_pattern', `Invalid pattern: ${err instanceof Error ? err.message : String(err)}`));
      }

      let window: ResolvedWindow;
      try {
        window = resolveWindow(
          { since: input.since, until: input.until },
          { defaultSinceSeconds: SEARCH_LOGS_DEFAULT_SINCE_SECONDS, maxSpanSeconds: SEARCH_LOGS_MAX_SPAN_SECONDS },
        );
      } catch (err) {
        if (err instanceof McpToolError) return fail(err);
        throw err;
      }

      const sinceSeconds = Math.floor(window.from.getTime() / 1000);
      const untilSeconds = Math.ceil(window.to.getTime() / 1000);

      const fetched = await fetchAgentHistory(ctx, host, containerId, sinceSeconds, untilSeconds, input.scanLines);
      if (!fetched.ok) return fetched.result;

      const body = await readCappedBody(fetched.res, AGENT_BODY_MAX_BYTES);
      const rawLines = parseNdjsonLines(body);

      const toOutLine = (line: RawLogLine): OutLine => {
        const t = truncateText(line.text, input.maxLineChars);
        return { at: line.at, stream: line.stream, text: t.text, truncated: t.truncated };
      };

      const startedAt = Date.now();
      let scannedCount = 0;
      let timedOut = false;
      let matchCount = 0;
      const matches: MatchLine[] = [];

      for (let i = 0; i < rawLines.length; i++) {
        if (i > 0 && i % SEARCH_LOGS_BUDGET_CHECK_INTERVAL === 0 && Date.now() - startedAt > SEARCH_LOGS_TIME_BUDGET_MS) {
          timedOut = true;
          break;
        }
        scannedCount = i + 1;

        const line = rawLines[i];
        if (input.stream !== 'all' && line.stream !== input.stream) continue;
        const testText =
          line.text.length > SEARCH_LOGS_REGEX_TEST_MAX_CHARS ? line.text.slice(0, SEARCH_LOGS_REGEX_TEST_MAX_CHARS) : line.text;
        if (!regex.test(testText)) continue;

        matchCount += 1;
        if (matches.length < input.limit) {
          const before: OutLine[] = [];
          for (let j = Math.max(0, i - input.contextBefore); j < i; j++) before.push(toOutLine(rawLines[j]));
          const after: OutLine[] = [];
          for (let j = i + 1; j < Math.min(rawLines.length, i + input.contextAfter + 1); j++) after.push(toOutLine(rawLines[j]));
          matches.push({ ...toOutLine(line), before, after });
        }
      }

      const stopReason: 'limit' | 'time_budget' | null = timedOut ? 'time_budget' : matchCount > input.limit ? 'limit' : null;

      return ok({
        entityId: input.entityId,
        pattern: input.pattern,
        window: { from: iso(window.from), to: iso(window.to) },
        matches,
        returned: matches.length,
        matchCount,
        scannedLines: scannedCount,
        scanTruncated: scannedCount === input.scanLines,
        scannedFrom: rawLines.length > 0 ? rawLines[0].at : null,
        stopReason,
      });
    },
  );
}

export function registerLogTools(server: McpServer, ctx: McpToolContext): void {
  if (!hasScope(ctx.scopes, 'mcp:logs:read')) return;
  registerGetLogs(server, ctx);
  registerSearchLogs(server, ctx);
}
