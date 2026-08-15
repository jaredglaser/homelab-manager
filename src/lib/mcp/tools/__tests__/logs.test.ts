import { describe, it, expect, mock, spyOn, afterEach } from 'bun:test';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpToolContext } from '@/lib/mcp/context';
import { registerLogTools } from '@/lib/mcp/tools/logs';

interface RawLine {
  at: string | null;
  stream: 'stdout' | 'stderr';
  text: string;
}

function ndjson(lines: RawLine[]): string {
  if (lines.length === 0) return '';
  return `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`;
}

interface RegisteredTool {
  config: {
    title?: string;
    description?: string;
    inputSchema?: z.ZodRawShape;
    outputSchema?: z.ZodRawShape;
    annotations?: Record<string, unknown>;
  };
  handler: (args: unknown, extra: unknown) => Promise<CallToolResult>;
}

function createFakeServer() {
  const tools = new Map<string, RegisteredTool>();
  const server = {
    registerTool: (name: string, config: RegisteredTool['config'], handler: RegisteredTool['handler']) => {
      tools.set(name, { config, handler });
    },
  };
  return { server: server as unknown as McpServer, tools };
}

function makeCtx(callAgent: McpToolContext['callAgent'], scopes: string[] = ['mcp:logs:read']): McpToolContext {
  return {
    pool: {} as McpToolContext['pool'],
    scopes,
    callAgent,
  };
}

function parseInput(shape: z.ZodRawShape | undefined, raw: Record<string, unknown>): unknown {
  return z.object(shape ?? {}).parse(raw);
}

function registerTools(callAgent: McpToolContext['callAgent'], scopes: string[] = ['mcp:logs:read']) {
  const { server, tools } = createFakeServer();
  const ctx = makeCtx(callAgent, scopes);
  registerLogTools(server, ctx);
  return { tools, ctx };
}

function structured(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent).toBeDefined();
  expect(result.content[0]).toEqual({ type: 'text', text: JSON.stringify(result.structuredContent) });
  return result.structuredContent as Record<string, unknown>;
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const first = result.content[0] as { type: 'text'; text: string };
  return first.text;
}

describe('registerLogTools', () => {
  it('registers no tools when the token lacks mcp:logs:read and mcp:read', () => {
    const { tools } = registerTools(mock(async () => new Response('')), []);
    expect(tools.size).toBe(0);
  });

  it('registers get_logs and search_logs when scoped mcp:logs:read', () => {
    const { tools } = registerTools(mock(async () => new Response('')), ['mcp:logs:read']);
    expect(tools.has('get_logs')).toBe(true);
    expect(tools.has('search_logs')).toBe(true);
  });

  it('registers both tools when scoped only via the blanket mcp:read scope', () => {
    const { tools } = registerTools(mock(async () => new Response('')), ['mcp:read']);
    expect(tools.has('get_logs')).toBe(true);
    expect(tools.has('search_logs')).toBe(true);
  });

  it('marks both log tools read-only, non-destructive, idempotent, and open-world', () => {
    const { tools } = registerTools(mock(async () => new Response('')));
    for (const name of ['get_logs', 'search_logs']) {
      const annotations = tools.get(name)!.config.annotations;
      expect(annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
    }
  });
});

describe('get_logs', () => {
  it('fetches the container history and returns lines oldest first', async () => {
    const body = ndjson([
      { at: '2026-08-15T11:59:57.100000000Z', stream: 'stdout', text: 'starting up' },
      { at: '2026-08-15T11:59:58.200000000Z', stream: 'stderr', text: 'ECONNREFUSED 10.0.0.4:5432' },
      { at: '2026-08-15T11:59:59.300000000Z', stream: 'stdout', text: 'retrying' },
    ]);
    const callAgent = mock(async (_host: string, _path: string, _init?: RequestInit) => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;

    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/9f2c1ab34de5' });
    const result = structured(await getLogs.handler(input, {}));

    expect(callAgent.mock.calls.length).toBe(1);
    const [host, path, init] = callAgent.mock.calls[0] as [string, string, RequestInit];
    expect(host).toBe('nuc1');
    expect(path).toMatch(/^\/logs\/9f2c1ab34de5\/history\?/);
    expect(path).toContain('maxLines=200');
    expect((init.signal as AbortSignal) instanceof AbortSignal).toBe(true);

    expect(result.entityId).toBe('nuc1/9f2c1ab34de5');
    expect(result.count).toBe(3);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.truncationReason).toBeNull();
    const lines = result.lines as RawLine[];
    expect(lines[0].text).toBe('starting up');
    expect(lines[2].text).toBe('retrying');
  });

  it('caps at limit, flags hasMore, and returns a cursor to the previous page', async () => {
    const body = ndjson([
      { at: '2026-08-15T11:00:00.000000000Z', stream: 'stdout', text: 'line a' },
      { at: '2026-08-15T11:00:01.000000000Z', stream: 'stdout', text: 'line b' },
    ]);
    const callAgent = mock(async () => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;

    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', limit: 2 });
    const result = structured(await getLogs.handler(input, {}));

    expect(result.count).toBe(2);
    expect(result.hasMore).toBe(true);
    expect(result.truncationReason).toBe('line_limit');
    const cursorRaw = result.nextCursor as string;
    expect(typeof cursorRaw).toBe('string');
    const decoded = JSON.parse(Buffer.from(cursorRaw, 'base64url').toString('utf8'));
    expect(decoded).toEqual({ v: 1, e: 'nuc1/abc123456789', before: '2026-08-15T11:00:00.000000000Z', since: expect.any(Number) });
  });

  it('walks backwards with a cursor, dropping the repeated boundary line', async () => {
    const page1 = ndjson([{ at: '2026-08-15T11:30:00.000000000Z', stream: 'stdout', text: 'newest of page 2' }]);
    const page2 = ndjson([
      { at: '2026-08-15T11:29:58.000000000Z', stream: 'stdout', text: 'older line' },
      { at: '2026-08-15T11:30:00.000000000Z', stream: 'stdout', text: 'boundary duplicate' },
    ]);
    let call = 0;
    const callAgent = mock(async (_host: string, _path: string, _init?: RequestInit) => new Response(call++ === 0 ? page1 : page2, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;

    const first = structured(
      await getLogs.handler(parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', limit: 1, since: '2d' }), {}),
    );
    expect(first.hasMore).toBe(true);
    const cursor = first.nextCursor as string;

    const second = structured(
      await getLogs.handler(parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', limit: 1, cursor }), {}),
    );
    const [, secondPath] = callAgent.mock.calls[1] as [string, string, RequestInit];
    expect(secondPath).toContain('untilSeconds=');
    const secondLines = second.lines as RawLine[];
    expect(secondLines).toHaveLength(1);
    expect(secondLines[0].text).toBe('older line');
  });

  it('drops null-at lines on continuation pages instead of re-delivering them', async () => {
    const page1 = ndjson([
      { at: '2026-08-15T11:29:59.000000000Z', stream: 'stdout', text: 'oldest of page 1' },
      { at: null, stream: 'stdout', text: 'garbled boundary line' },
      { at: '2026-08-15T11:30:00.000000000Z', stream: 'stdout', text: 'newest of page 1' },
    ]);
    const page2 = ndjson([
      { at: null, stream: 'stdout', text: 'garbled boundary line' },
      { at: '2026-08-15T11:29:58.000000000Z', stream: 'stdout', text: 'older line' },
    ]);
    let call = 0;
    const callAgent = mock(async () => new Response(call++ === 0 ? page1 : page2, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;

    const first = structured(
      await getLogs.handler(parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', limit: 3, since: '2d' }), {}),
    );
    expect(first.hasMore).toBe(true);
    const cursor = first.nextCursor as string;

    const second = structured(
      await getLogs.handler(parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', limit: 3, cursor }), {}),
    );
    const secondLines = (second.lines as RawLine[]).map((l) => l.text);
    expect(secondLines).not.toContain('garbled boundary line');
    expect(secondLines).toEqual(['older line']);
  });

  it('rejects a cursor whose window exceeds the max span cap', async () => {
    const callAgent = mock(async () => new Response(''));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;

    const oversizedCursor = Buffer.from(
      JSON.stringify({ v: 1, e: 'nuc1/abc123456789', before: '2026-08-15T11:00:00.000000000Z', since: 0 }),
      'utf8',
    ).toString('base64url');

    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', cursor: oversizedCursor });
    const result = await getLogs.handler(input, {});
    expect(errorText(result)).toContain('window_too_large');
    expect(callAgent.mock.calls.length).toBe(0);
  });

  it('rejects a cursor with a non-finite or inverted window', async () => {
    const callAgent = mock(async () => new Response(''));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;

    const invertedCursor = Buffer.from(
      JSON.stringify({ v: 1, e: 'nuc1/abc123456789', before: '2026-08-15T11:00:00.000000000Z', since: 9999999999 }),
      'utf8',
    ).toString('base64url');

    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', cursor: invertedCursor });
    const result = await getLogs.handler(input, {});
    expect(errorText(result)).toContain('invalid_cursor');
    expect(callAgent.mock.calls.length).toBe(0);
  });

  it('rejects a cursor issued for a different entityId', async () => {
    const callAgent = mock(async () => new Response(''));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;

    const foreignCursor = Buffer.from(
      JSON.stringify({ v: 1, e: 'other-host/deadbeef0000', before: '2026-08-15T11:00:00.000000000Z', since: 1755255600 }),
      'utf8',
    ).toString('base64url');

    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', cursor: foreignCursor });
    const result = await getLogs.handler(input, {});
    expect(errorText(result)).toContain('invalid_cursor');
    expect(callAgent.mock.calls.length).toBe(0);
  });

  it('rejects a cursor that does not decode to JSON', async () => {
    const callAgent = mock(async () => new Response(''));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;

    const garbage = Buffer.from('this is not json', 'utf8').toString('base64url');
    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', cursor: garbage });
    const result = await getLogs.handler(input, {});
    expect(errorText(result)).toContain('invalid_cursor');
  });

  it('rejects malformed input at the schema boundary', () => {
    const { tools } = registerTools(mock(async () => new Response('')));
    const getLogs = tools.get('get_logs')!;
    const schema = z.object(getLogs.config.inputSchema ?? {});

    expect(() => schema.parse({ entityId: 'no-slash-here' })).toThrow();
    expect(() => schema.parse({ entityId: 'nuc1/abc' })).not.toThrow();
    expect(() => schema.parse({ entityId: 'nuc1/abc', limit: 0 })).toThrow();
    expect(() => schema.parse({ entityId: 'nuc1/abc', limit: 1001 })).toThrow();
  });

  it('maps a 404 from the agent to unknown_container', async () => {
    const callAgent = mock(async () => new Response('Container not found', { status: 404 }));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;
    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789' });
    const result = await getLogs.handler(input, {});
    expect(errorText(result)).toContain('unknown_container');
  });

  it('maps a 500 from the agent to agent_error', async () => {
    const callAgent = mock(async () => new Response('boom', { status: 500 }));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;
    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789' });
    const result = await getLogs.handler(input, {});
    expect(errorText(result)).toContain('agent_error');
  });

  it('maps a network failure reaching the agent to host_unreachable', async () => {
    const callAgent = mock(async () => {
      throw new Error('ECONNREFUSED');
    });
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;
    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789' });
    const result = await getLogs.handler(input, {});
    expect(errorText(result)).toContain('host_unreachable');
  });

  it('rejects an inverted window without calling the agent', async () => {
    const callAgent = mock(async () => new Response(''));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;
    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', since: '30s', until: '1h' });
    const result = await getLogs.handler(input, {});
    expect(errorText(result)).toContain('invalid_window');
    expect(callAgent.mock.calls.length).toBe(0);
  });

  it('rejects a window spanning more than 7 days', async () => {
    const callAgent = mock(async () => new Response(''));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;
    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', since: '8d' });
    const result = await getLogs.handler(input, {});
    expect(errorText(result)).toContain('window_too_large');
  });

  it('reports an unparsable timestamp boundary when the oldest line has no timestamp', async () => {
    const body = ndjson([
      { at: null, stream: 'stdout', text: 'no timestamp' },
      { at: '2026-08-15T11:00:01.000000000Z', stream: 'stdout', text: 'has timestamp' },
    ]);
    const callAgent = mock(async () => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;
    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', limit: 2 });
    const result = structured(await getLogs.handler(input, {}));
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.truncationReason).toBe('unparsable_timestamp_boundary');
  });

  it('filters by stream after fetching, but bases hasMore on the raw fetch so a narrow filter still offers a cursor', async () => {
    const body = ndjson([
      { at: '2026-08-15T11:00:00.000000000Z', stream: 'stdout', text: 'out 1' },
      { at: '2026-08-15T11:00:01.000000000Z', stream: 'stderr', text: 'err 1' },
      { at: '2026-08-15T11:00:02.000000000Z', stream: 'stdout', text: 'out 2' },
    ]);
    const callAgent = mock(async () => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;
    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', limit: 3, stream: 'stderr' });
    const result = structured(await getLogs.handler(input, {}));
    const lines = result.lines as RawLine[];
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('err 1');
    expect(result.hasMore).toBe(true);
    expect(result.truncationReason).toBe('line_limit');
    expect(typeof result.nextCursor).toBe('string');
  });

  it('truncates individual lines to maxLineChars', async () => {
    const longText = 'x'.repeat(200);
    const body = ndjson([{ at: '2026-08-15T11:00:00.000000000Z', stream: 'stdout', text: longText }]);
    const callAgent = mock(async () => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const getLogs = tools.get('get_logs')!;
    const input = parseInput(getLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', maxLineChars: 80 });
    const result = structured(await getLogs.handler(input, {}));
    const lines = result.lines as Array<RawLine & { truncated: boolean }>;
    expect(lines[0].text).toBe(longText.slice(0, 80));
    expect(lines[0].text).toHaveLength(80);
    expect(lines[0].truncated).toBe(true);
  });
});

describe('search_logs', () => {
  it('scans history and returns only matching lines with counts', async () => {
    const body = ndjson([
      { at: '2026-08-15T11:00:00.000000000Z', stream: 'stdout', text: 'connecting to db' },
      { at: '2026-08-15T11:00:01.000000000Z', stream: 'stderr', text: 'ECONNREFUSED 10.0.0.4:5432' },
      { at: '2026-08-15T11:00:02.000000000Z', stream: 'stdout', text: 'retry scheduled' },
      { at: '2026-08-15T11:00:03.000000000Z', stream: 'stderr', text: 'panic: fatal error' },
      { at: '2026-08-15T11:00:04.000000000Z', stream: 'stdout', text: 'exiting' },
    ]);
    const callAgent = mock(async () => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent, ['mcp:logs:read']);
    const searchLogs = tools.get('search_logs')!;

    const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'ECONNREFUSED|panic:' });
    const result = structured(await searchLogs.handler(input, {}));

    expect(result.matchCount).toBe(2);
    expect(result.returned).toBe(2);
    expect(result.scannedLines).toBe(5);
    expect(result.scanTruncated).toBe(false);
    expect(result.scannedFrom).toBe('2026-08-15T11:00:00.000000000Z');
    expect(result.stopReason).toBeNull();
    const matches = result.matches as Array<{ text: string }>;
    expect(matches[0].text).toBe('ECONNREFUSED 10.0.0.4:5432');
    expect(matches[1].text).toBe('panic: fatal error');
  });

  it('rejects an invalid regular expression', async () => {
    const callAgent = mock(async () => new Response(''));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: '(unterminated' });
    const result = await searchLogs.handler(input, {});
    expect(errorText(result)).toContain('invalid_pattern');
    expect(callAgent.mock.calls.length).toBe(0);
  });

  it('rejects malformed input at the schema boundary', () => {
    const { tools } = registerTools(mock(async () => new Response('')));
    const searchLogs = tools.get('search_logs')!;
    const schema = z.object(searchLogs.config.inputSchema ?? {});

    expect(() => schema.parse({ entityId: 'nuc1/abc', pattern: '' })).toThrow();
    expect(() => schema.parse({ entityId: 'nuc1/abc', pattern: 'ok', scanLines: 99 })).toThrow();
    expect(() => schema.parse({ entityId: 'nuc1/abc', pattern: 'ok', contextBefore: 6 })).toThrow();
  });

  it('caps returned matches at limit while matchCount reports the true total', async () => {
    const body = ndjson([
      { at: '2026-08-15T11:00:00.000000000Z', stream: 'stdout', text: 'error one' },
      { at: '2026-08-15T11:00:01.000000000Z', stream: 'stdout', text: 'error two' },
      { at: '2026-08-15T11:00:02.000000000Z', stream: 'stdout', text: 'error three' },
    ]);
    const callAgent = mock(async () => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'error', limit: 1 });
    const result = structured(await searchLogs.handler(input, {}));
    expect(result.matchCount).toBe(3);
    expect(result.returned).toBe(1);
    expect((result.matches as unknown[]).length).toBe(1);
    expect(result.stopReason).toBe('limit');
  });

  it('maps a 404 from the agent to unknown_container', async () => {
    const callAgent = mock(async () => new Response('nope', { status: 404 }));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'x' });
    const result = await searchLogs.handler(input, {});
    expect(errorText(result)).toContain('unknown_container');
  });

  it('maps a 500 from the agent to agent_error', async () => {
    const callAgent = mock(async () => new Response('boom', { status: 500 }));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'x' });
    const result = await searchLogs.handler(input, {});
    expect(errorText(result)).toContain('agent_error');
  });

  it('maps a network failure reaching the agent to host_unreachable', async () => {
    const callAgent = mock(async () => {
      throw new Error('ECONNREFUSED');
    });
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'x' });
    const result = await searchLogs.handler(input, {});
    expect(errorText(result)).toContain('host_unreachable');
  });

  it('rejects a window spanning more than 7 days', async () => {
    const callAgent = mock(async () => new Response(''));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'x', since: '8d' });
    const result = await searchLogs.handler(input, {});
    expect(errorText(result)).toContain('window_too_large');
  });

  it('rejects an inverted window without calling the agent', async () => {
    const callAgent = mock(async () => new Response(''));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'x', since: '30s', until: '1h' });
    const result = await searchLogs.handler(input, {});
    expect(errorText(result)).toContain('invalid_window');
    expect(callAgent.mock.calls.length).toBe(0);
  });

  it('attaches bounded before/after context around each match', async () => {
    const body = ndjson([
      { at: '2026-08-15T11:00:00.000000000Z', stream: 'stdout', text: 'line 0' },
      { at: '2026-08-15T11:00:01.000000000Z', stream: 'stdout', text: 'line 1' },
      { at: '2026-08-15T11:00:02.000000000Z', stream: 'stdout', text: 'MATCH' },
      { at: '2026-08-15T11:00:03.000000000Z', stream: 'stdout', text: 'line 3' },
      { at: '2026-08-15T11:00:04.000000000Z', stream: 'stdout', text: 'line 4' },
    ]);
    const callAgent = mock(async () => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, {
      entityId: 'nuc1/abc123456789',
      pattern: 'MATCH',
      contextBefore: 2,
      contextAfter: 1,
    });
    const result = structured(await searchLogs.handler(input, {}));
    const matches = result.matches as Array<{ before: Array<{ text: string }>; after: Array<{ text: string }> }>;
    expect(matches).toHaveLength(1);
    expect(matches[0].before.map((l) => l.text)).toEqual(['line 0', 'line 1']);
    expect(matches[0].after.map((l) => l.text)).toEqual(['line 3']);
  });

  it('only tests lines on the requested stream', async () => {
    const body = ndjson([
      { at: '2026-08-15T11:00:00.000000000Z', stream: 'stdout', text: 'error in stdout' },
      { at: '2026-08-15T11:00:01.000000000Z', stream: 'stderr', text: 'error in stderr' },
    ]);
    const callAgent = mock(async () => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'error', stream: 'stderr' });
    const result = structured(await searchLogs.handler(input, {}));
    expect(result.matchCount).toBe(1);
    const matches = result.matches as Array<{ text: string }>;
    expect(matches[0].text).toBe('error in stderr');
  });

  it('is case insensitive by default and case sensitive when requested', async () => {
    const body = ndjson([{ at: '2026-08-15T11:00:00.000000000Z', stream: 'stdout', text: 'an error occurred' }]);
    const callAgent = mock(async () => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;

    const insensitive = structured(
      await searchLogs.handler(parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'ERROR' }), {}),
    );
    expect(insensitive.matchCount).toBe(1);

    const sensitive = structured(
      await searchLogs.handler(
        parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'ERROR', caseSensitive: true }),
        {},
      ),
    );
    expect(sensitive.matchCount).toBe(0);
  });

  it('truncates match and context text to maxLineChars', async () => {
    const before = `before ${'y'.repeat(200)}`;
    const matchText = `MATCH ${'z'.repeat(200)}`;
    const body = ndjson([
      { at: '2026-08-15T11:00:00.000000000Z', stream: 'stdout', text: before },
      { at: '2026-08-15T11:00:01.000000000Z', stream: 'stdout', text: matchText },
    ]);
    const callAgent = mock(async () => new Response(body, { status: 200 }));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, {
      entityId: 'nuc1/abc123456789',
      pattern: 'MATCH',
      contextBefore: 1,
      maxLineChars: 80,
    });
    const result = structured(await searchLogs.handler(input, {}));
    const matches = result.matches as Array<{ text: string; truncated: boolean; before: Array<{ text: string; truncated: boolean }> }>;
    expect(matches[0].text).toHaveLength(80);
    expect(matches[0].truncated).toBe(true);
    expect(matches[0].before[0].text).toHaveLength(80);
    expect(matches[0].before[0].truncated).toBe(true);
  });

  it('reports scanTruncated when the agent returns exactly scanLines lines', async () => {
    const lines: RawLine[] = Array.from({ length: 100 }, (_, i) => ({
      at: `2026-08-15T11:00:${String(i).padStart(2, '0')}.000000000Z`,
      stream: 'stdout' as const,
      text: `line ${i}`,
    }));
    const callAgent = mock(async () => new Response(ndjson(lines), { status: 200 }));
    const { tools } = registerTools(callAgent);
    const searchLogs = tools.get('search_logs')!;
    const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'nomatch', scanLines: 100 });
    const result = structured(await searchLogs.handler(input, {}));
    expect(result.scannedLines).toBe(100);
    expect(result.scanTruncated).toBe(true);
  });

  describe('time budget', () => {
    afterEach(() => {
      spyOn(Date, 'now').mockRestore();
    });

    it('stops scanning once the wall-clock budget is exceeded and reports time_budget', async () => {
      const totalLines = 600;
      const lines: RawLine[] = Array.from({ length: totalLines }, (_, i) => ({
        at: `2026-08-15T${String(11 + Math.floor(i / 3600)).padStart(2, '0')}:${String(Math.floor(i / 60) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000000000Z`,
        stream: 'stdout' as const,
        text: `line ${i}`,
      }));
      const callAgent = mock(async () => new Response(ndjson(lines), { status: 200 }));
      const { tools } = registerTools(callAgent);
      const searchLogs = tools.get('search_logs')!;

      let calls = 0;
      spyOn(Date, 'now').mockImplementation(() => {
        calls += 1;
        return calls <= 2 ? 1_000 : 10_000;
      });

      const input = parseInput(searchLogs.config.inputSchema, { entityId: 'nuc1/abc123456789', pattern: 'line', scanLines: totalLines });
      const result = structured(await searchLogs.handler(input, {}));

      expect(result.stopReason).toBe('time_budget');
      expect(result.scannedLines).toBe(512);
      expect(result.scanTruncated).toBe(false);
      expect(result.scannedFrom).toBe(lines[0].at);
    });
  });
});
