import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpToolContext } from '@/lib/mcp/context';

const MAX_RESULT_BYTES = 256_000;
const DEFAULT_WINDOW = { from: new Date('2026-08-14T12:00:00.000Z'), to: new Date('2026-08-15T12:00:00.000Z'), spanSeconds: 86400 };

class MockMcpToolError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function mockParseEntityId(entityId: string): { host: string; containerId: string } {
  const idx = entityId.indexOf('/');
  return { host: entityId.slice(0, idx), containerId: entityId.slice(idx + 1) };
}

function mockHasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required) || scopes.includes('mcp:read');
}

function mockIso(value: Date | number): string {
  return new Date(value).toISOString();
}

function mockTruncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

function mockOk<T>(structured: T) {
  const json = JSON.stringify(structured);
  if (Buffer.byteLength(json, 'utf8') > MAX_RESULT_BYTES) {
    throw new Error(`Result exceeds ${MAX_RESULT_BYTES} bytes`);
  }
  return { content: [{ type: 'text' as const, text: json }], structuredContent: structured };
}

function mockFail(err: MockMcpToolError) {
  return { isError: true, content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }] };
}

const resolveWindowMock = mock((_input: { since?: string; until?: string }, _opts: { defaultSinceSeconds: number; maxSpanSeconds: number }) => DEFAULT_WINDOW);

mock.module('@/lib/mcp/shared', () => ({
  zEntityId: (() => {
    const { z } = require('zod');
    return z.string().regex(/^[^/\s]+\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, { message: 'Expected an entity id' });
  })(),
  zTime: (() => {
    const { z } = require('zod');
    const RELATIVE_TIME = /^(\d{1,6})([smhd])$/;
    return z.string().refine((v: string) => RELATIVE_TIME.test(v) || !Number.isNaN(Date.parse(v)), { message: 'Expected an ISO 8601 timestamp or a relative duration' });
  })(),
  parseEntityId: mockParseEntityId,
  resolveWindow: resolveWindowMock,
  hasScope: mockHasScope,
  iso: mockIso,
  truncateText: mockTruncateText,
  McpToolError: MockMcpToolError,
  ok: mockOk,
  fail: mockFail,
}));

const getContainerEventsMock = mock(async (_pool: unknown, _host: string, _containerId: string, _from: Date, _to: Date, _limit: number): Promise<unknown[]> => []);
const getContainerSnapshotMock = mock(async (_pool: unknown, _host: string, _containerId: string): Promise<unknown> => null);
const getDeployHistoryForStackMock = mock(async (_pool: unknown, _stack: string, _host: string | null, _limit: number): Promise<unknown[]> => []);

mock.module('@/lib/mcp/queries', () => ({
  getContainerEvents: getContainerEventsMock,
  getContainerSnapshot: getContainerSnapshotMock,
  getDeployHistoryForStack: getDeployHistoryForStackMock,
}));

const getByIdMock = mock(async (_id: number): Promise<unknown> => null);

mock.module('@/lib/database/repositories/deploy-repository', () => ({
  DeployRepository: mock().mockImplementation(() => ({ getById: getByIdMock })),
}));

const { registerEventTools } = await import('@/lib/mcp/tools/events');

function makeEventRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    at: new Date('2026-08-15T11:58:40.010Z'),
    host: 'nuc1',
    containerId: '9f2c1ab34de5',
    eventType: 'upsert',
    state: 'restarting',
    name: 'plex',
    image: 'lscr.io/linuxserver/plex:1.41.0',
    startedAt: new Date('2026-08-15T11:58:39.000Z'),
    finishedAt: new Date('2026-08-15T11:58:38.000Z'),
    exitCode: 137,
    composeProject: 'media',
    serviceKey: 'plex',
    ...overrides,
  };
}

function makeSnapshotRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    at: new Date('2026-08-14T22:10:04.221Z'),
    host: 'nuc1',
    containerId: '9f2c1ab34de5',
    eventType: 'upsert',
    state: 'running',
    name: 'plex',
    image: 'lscr.io/linuxserver/plex:1.41.0',
    composeProject: 'media',
    serviceKey: 'plex',
    startedAt: new Date('2026-08-14T22:10:03.000Z'),
    finishedAt: null,
    exitCode: null,
    ...overrides,
  };
}

function makeDeployRecord(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 812,
    stack: 'media',
    host: 'nuc1',
    commitSha: '3f9a1c7e5b2d4a8f0c6e1b9d7a3f5c2e4b8d0a6f',
    composeHash: 'sha256:compose',
    envHash: 'sha256:env',
    status: 'succeeded',
    trigger: 'git_push',
    action: 'deploy',
    forceRecreate: false,
    logs: null,
    createdAt: new Date('2026-08-15T11:57:02.881Z'),
    postSuccess: null,
    ...overrides,
  };
}

function makeCtx(scopes: string[] = ['mcp:events:read']): McpToolContext {
  return {
    pool: {} as McpToolContext['pool'],
    scopes,
    callAgent: mock(async () => new Response('ok')),
  };
}

async function connectedClient(ctx: McpToolContext) {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerEventTools(server, ctx);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

beforeEach(() => {
  resolveWindowMock.mockClear();
  resolveWindowMock.mockImplementation(() => DEFAULT_WINDOW);
  getContainerEventsMock.mockClear();
  getContainerEventsMock.mockImplementation(async () => []);
  getContainerSnapshotMock.mockClear();
  getContainerSnapshotMock.mockImplementation(async () => null);
  getDeployHistoryForStackMock.mockClear();
  getDeployHistoryForStackMock.mockImplementation(async () => []);
  getByIdMock.mockClear();
  getByIdMock.mockImplementation(async () => null);
});

afterEach(() => {
  mock.restore();
});

describe('registerEventTools', () => {
  it('registers no tools when the context lacks mcp:events:read and mcp:read', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:hosts:read']));
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
  });

  it('registers both tools when mcp:events:read is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:events:read']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_container_events', 'get_deploy_history']);
  });

  it('registers both tools when the umbrella mcp:read scope is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:read']));
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(2);
  });
});

describe('get_container_events', () => {
  it('returns mapped events newest first, requesting limit+1 rows', async () => {
    getContainerEventsMock.mockImplementation(async () => [
      makeEventRow(),
      { at: new Date('2026-08-15T01:00:00.000Z'), host: 'nuc1', containerId: '9f2c1ab34de5', eventType: 'destroy' },
    ]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container_events', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBeUndefined();
    expect(getContainerEventsMock).toHaveBeenCalledWith(expect.anything(), 'nuc1', '9f2c1ab34de5', DEFAULT_WINDOW.from, DEFAULT_WINDOW.to, 51);

    const structured = result.structuredContent as { entityId: string; window: Record<string, string>; events: Array<Record<string, unknown>>; count: number; hasMore: boolean };
    expect(structured.entityId).toBe('nuc1/9f2c1ab34de5');
    expect(structured.window).toEqual({ from: '2026-08-14T12:00:00.000Z', to: '2026-08-15T12:00:00.000Z' });
    expect(structured.count).toBe(2);
    expect(structured.hasMore).toBe(false);
    expect(structured.events[0]).toEqual({
      at: '2026-08-15T11:58:40.010Z',
      eventType: 'upsert',
      state: 'restarting',
      name: 'plex',
      image: 'lscr.io/linuxserver/plex:1.41.0',
      startedAt: '2026-08-15T11:58:39.000Z',
      finishedAt: '2026-08-15T11:58:38.000Z',
      exitCode: 137,
      stack: 'media',
      service: 'plex',
    });
    expect(structured.events[1]).toEqual({
      at: '2026-08-15T01:00:00.000Z',
      eventType: 'destroy',
      state: null,
      name: null,
      image: null,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
      stack: null,
      service: null,
    });
  });

  it('returns count 0 and hasMore false when the query returns nothing', async () => {
    getContainerEventsMock.mockImplementation(async () => []);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container_events', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ count: 0, hasMore: false, events: [] });
  });

  it('caps at limit and reports hasMore when more rows exist', async () => {
    getContainerEventsMock.mockImplementation(async () => [makeEventRow(), makeEventRow({ at: new Date('2026-08-15T11:00:00.000Z') })]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container_events', arguments: { entityId: 'nuc1/9f2c1ab34de5', limit: 1 } });

    const structured = result.structuredContent as { events: unknown[]; count: number; hasMore: boolean };
    expect(structured.events).toHaveLength(1);
    expect(structured.count).toBe(1);
    expect(structured.hasMore).toBe(true);
    expect(getContainerEventsMock).toHaveBeenCalledWith(expect.anything(), 'nuc1', '9f2c1ab34de5', expect.anything(), expect.anything(), 2);
  });

  it('rejects a limit above the cap', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container_events', arguments: { entityId: 'nuc1/9f2c1ab34de5', limit: 500 } });

    expect(result.isError).toBe(true);
  });

  it('rejects a malformed entity id', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container_events', arguments: { entityId: 'no-slash-here' } });

    expect(result.isError).toBe(true);
  });

  it('surfaces an invalid_window error from resolveWindow as a tool error', async () => {
    resolveWindowMock.mockImplementation(() => {
      throw new MockMcpToolError('invalid_window', 'from must be before to');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container_events', arguments: { entityId: 'nuc1/9f2c1ab34de5', since: '1h', until: '2h' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('invalid_window');
  });

  it('surfaces a downstream query failure as an error result', async () => {
    getContainerEventsMock.mockImplementation(async () => {
      throw new Error('connection refused');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_container_events', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBe(true);
  });
});

describe('get_deploy_history', () => {
  it('resolves by stack name alone, with host null in the response', async () => {
    getDeployHistoryForStackMock.mockImplementation(async () => [makeDeployRecord()]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { stack: 'media' } });

    expect(result.isError).toBeUndefined();
    expect(getDeployHistoryForStackMock).toHaveBeenCalledWith(expect.anything(), 'media', null, 11);

    const structured = result.structuredContent as { stack: string; host: string | null; deploys: Array<Record<string, unknown>>; count: number; hasMore: boolean };
    expect(structured.stack).toBe('media');
    expect(structured.host).toBeNull();
    expect(structured.count).toBe(1);
    expect(structured.hasMore).toBe(false);
    expect(structured.deploys[0]).toEqual({
      id: 812,
      stack: 'media',
      host: 'nuc1',
      commitSha: '3f9a1c7e5b2d4a8f0c6e1b9d7a3f5c2e4b8d0a6f',
      status: 'succeeded',
      trigger: 'git_push',
      action: 'deploy',
      forceRecreate: false,
      composeHash: 'sha256:compose',
      envHash: 'sha256:env',
      createdAt: '2026-08-15T11:57:02.881Z',
      logsOmitted: true,
      logs: null,
      logsTruncated: false,
    });
  });

  it('resolves by stack plus host, passing host through to the query', async () => {
    getDeployHistoryForStackMock.mockImplementation(async () => []);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { stack: 'media', host: 'nuc1' } });

    expect(result.isError).toBeUndefined();
    expect(getDeployHistoryForStackMock).toHaveBeenCalledWith(expect.anything(), 'media', 'nuc1', 11);
    expect((result.structuredContent as { host: string | null }).host).toBe('nuc1');
  });

  it('resolves stack and host from an entity id', async () => {
    getContainerSnapshotMock.mockImplementation(async () => makeSnapshotRow());
    getDeployHistoryForStackMock.mockImplementation(async () => [makeDeployRecord()]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBeUndefined();
    expect(getContainerSnapshotMock).toHaveBeenCalledWith(expect.anything(), 'nuc1', '9f2c1ab34de5');
    expect(getDeployHistoryForStackMock).toHaveBeenCalledWith(expect.anything(), 'media', 'nuc1', 11);
    expect(result.structuredContent).toMatchObject({ stack: 'media', host: 'nuc1' });
  });

  it('looks up a single record by deployId and honors includeLogs with truncation', async () => {
    getByIdMock.mockImplementation(async () => makeDeployRecord({ logs: 'x'.repeat(9000) }));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { deployId: 812, includeLogs: true } });

    expect(result.isError).toBeUndefined();
    expect(getByIdMock).toHaveBeenCalledWith(812);
    const structured = result.structuredContent as { deploys: Array<{ logs: string; logsOmitted: boolean; logsTruncated: boolean }>; count: number; hasMore: boolean };
    expect(structured.count).toBe(1);
    expect(structured.hasMore).toBe(false);
    expect(structured.deploys[0]!.logsOmitted).toBe(false);
    expect(structured.deploys[0]!.logsTruncated).toBe(true);
    expect(structured.deploys[0]!.logs).toHaveLength(8000);
    expect(getDeployHistoryForStackMock).not.toHaveBeenCalled();
  });

  it('deployId lookup ignores window/limit and omits logs by default', async () => {
    getByIdMock.mockImplementation(async () => makeDeployRecord());

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { deployId: 812 } });

    const structured = result.structuredContent as { deploys: Array<{ logsOmitted: boolean; logs: unknown }> };
    expect(structured.deploys[0]!.logsOmitted).toBe(true);
    expect(structured.deploys[0]!.logs).toBeNull();
  });

  it('caps at limit and reports hasMore when more rows exist', async () => {
    getDeployHistoryForStackMock.mockImplementation(async () => [makeDeployRecord({ id: 1 }), makeDeployRecord({ id: 2 })]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { stack: 'media', limit: 1 } });

    const structured = result.structuredContent as { deploys: unknown[]; count: number; hasMore: boolean };
    expect(structured.deploys).toHaveLength(1);
    expect(structured.count).toBe(1);
    expect(structured.hasMore).toBe(true);
  });

  it('rejects a limit above the cap', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { stack: 'media', limit: 500 } });

    expect(result.isError).toBe(true);
  });

  it('rejects when none of entityId, stack, or deployId are provided', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: {} });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_stack');
  });

  it('rejects when more than one of entityId, stack, or deployId are provided', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { stack: 'media', deployId: 812 } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_stack');
  });

  it('returns unknown_stack when deployId matches no record', async () => {
    getByIdMock.mockImplementation(async () => null);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { deployId: 999 } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_stack');
  });

  it('returns unknown_stack when the entity id resolves to a container with no compose project', async () => {
    getContainerSnapshotMock.mockImplementation(async () => makeSnapshotRow({ composeProject: null }));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_stack');
  });

  it('returns unknown_stack when the entity id has no snapshot row', async () => {
    getContainerSnapshotMock.mockImplementation(async () => null);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { entityId: 'nuc1/9f2c1ab34de5' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_stack');
  });

  it('surfaces a downstream query failure as an error result', async () => {
    getDeployHistoryForStackMock.mockImplementation(async () => {
      throw new Error('connection refused');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_deploy_history', arguments: { stack: 'media' } });

    expect(result.isError).toBe(true);
  });
});
