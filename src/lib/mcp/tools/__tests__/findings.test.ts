import { describe, it, expect, mock, beforeEach, afterEach } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpToolContext } from '@/lib/mcp/context';

const MAX_RESULT_BYTES = 256_000;
const DEFAULT_WINDOW = { from: new Date('2026-08-15T12:00:00.000Z'), to: new Date('2026-08-16T12:00:00.000Z'), spanSeconds: 86400 };

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

function mockHasExactScope(scopes: string[], required: string): boolean {
  return scopes.includes(required);
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
  hasExactScope: mockHasExactScope,
  iso: mockIso,
  truncateText: mockTruncateText,
  McpToolError: MockMcpToolError,
  ok: mockOk,
  fail: mockFail,
}));

const getContainerSnapshotMock = mock(async (_pool: unknown, _host: string, _containerId: string): Promise<unknown> => null);

mock.module('@/lib/mcp/queries', () => ({
  getContainerSnapshot: getContainerSnapshotMock,
}));

mock.module('@/lib/findings/types', () => {
  const { z } = require('zod');
  return {
    FINDING_SEVERITIES: ['info', 'warning', 'critical'],
    FINDING_STATUSES: ['open', 'resolved', 'dismissed'],
    FINDING_SUBJECT_KINDS: ['container', 'stack', 'host'],
    FINDING_EVIDENCE_KINDS: ['log_line', 'event', 'metric', 'deploy', 'note'],
    MAX_TITLE_CHARS: 200,
    MAX_DETAIL_CHARS: 4000,
    MAX_EVIDENCE_ITEMS: 10,
    MAX_EVIDENCE_SOURCE_CHARS: 200,
    MAX_ENTITY_IDS: 50,
    MAX_RESOLUTION_CHARS: 1000,
    zFindingFingerprint: z.string().min(3).max(120).regex(/^[a-z0-9][a-z0-9._:-]*$/, { message: 'invalid fingerprint' }),
  };
});

const recordMock = mock(async (_input: unknown): Promise<unknown> => null);
const listMock = mock(async (_options: unknown): Promise<unknown[]> => []);
const resolveMock = mock(async (_input: unknown): Promise<unknown> => null);

mock.module('@/lib/database/repositories/findings-repository', () => ({
  FindingsRepository: mock().mockImplementation(() => ({ record: recordMock, list: listMock, resolve: resolveMock })),
}));

const { registerFindingTools } = await import('@/lib/mcp/tools/findings');

interface FindingFixture {
  id: number;
  subjectKind: 'container' | 'stack' | 'host';
  subjectId: string;
  entityIds: string[];
  fingerprint: string;
  severity: 'info' | 'warning' | 'critical';
  status: 'open' | 'resolved' | 'dismissed';
  title: string;
  detail: string;
  evidence: Array<{ kind: string; at: Date | null; source: string; text: string; truncated: boolean }>;
  incidentIds: string[];
  runId: string | null;
  source: 'agent' | 'operator';
  occurrences: number;
  windowFrom: Date | null;
  windowTo: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
}

function makeFinding(overrides: Partial<FindingFixture> = {}): FindingFixture {
  return {
    id: 101,
    subjectKind: 'container',
    subjectId: 'nuc1/9f2c1ab34de5',
    entityIds: ['nuc1/9f2c1ab34de5'],
    fingerprint: 'postgres-connection-refused',
    severity: 'critical',
    status: 'open',
    title: 'Postgres refusing connections',
    detail: 'Every write since 11:58 fails with ECONNREFUSED.',
    evidence: [{ kind: 'log_line', at: new Date('2026-08-16T11:58:40.010Z'), source: 'stderr', text: 'connection refused', truncated: false }],
    incidentIds: ['inc-e-1'],
    runId: 'run-1',
    source: 'agent',
    occurrences: 1,
    windowFrom: new Date('2026-08-16T11:00:00.000Z'),
    windowTo: new Date('2026-08-16T12:00:00.000Z'),
    firstSeenAt: new Date('2026-08-16T11:58:40.010Z'),
    lastSeenAt: new Date('2026-08-16T11:58:40.010Z'),
    resolvedAt: null,
    resolution: null,
    ...overrides,
  };
}

function makeSnapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    at: new Date('2026-08-16T11:00:00.000Z'),
    host: 'nuc1',
    containerId: '9f2c1ab34de5',
    eventType: 'upsert',
    state: 'running',
    name: 'postgres',
    image: 'postgres:16',
    composeProject: 'media',
    serviceKey: 'postgres',
    ...overrides,
  };
}

function makeCtx(scopes: string[] = ['mcp:findings:read', 'mcp:findings:write']): McpToolContext {
  return {
    pool: {} as McpToolContext['pool'],
    scopes,
    callAgent: mock(async () => new Response('ok')),
  };
}

async function connectedClient(ctx: McpToolContext) {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerFindingTools(server, ctx);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

beforeEach(() => {
  resolveWindowMock.mockClear();
  resolveWindowMock.mockImplementation(() => DEFAULT_WINDOW);
  getContainerSnapshotMock.mockClear();
  getContainerSnapshotMock.mockImplementation(async () => makeSnapshotRow());
  recordMock.mockClear();
  recordMock.mockImplementation(async () => ({
    finding: makeFinding(),
    created: true,
    evidenceDropped: 0,
    evidenceTruncated: 0,
    detailTruncated: false,
  }));
  listMock.mockClear();
  listMock.mockImplementation(async () => []);
  resolveMock.mockClear();
  resolveMock.mockImplementation(async () => ({
    finding: makeFinding({ status: 'resolved', resolvedAt: new Date('2026-08-16T12:30:00.000Z'), resolution: 'rolled back the deploy' }),
    alreadyClosed: false,
  }));
});

afterEach(() => {
  mock.restore();
});

describe('registerFindingTools', () => {
  it('registers no tools when the context has neither findings scope nor mcp:read', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:hosts:read']));
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
  });

  it('registers only list_findings when mcp:findings:read is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:findings:read']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_findings']);
  });

  it('registers only the write tools when mcp:findings:write is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:findings:write']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['record_finding', 'resolve_finding']);
  });

  it('registers only list_findings when only the mcp:read umbrella scope is present, never the write tools', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:read']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['list_findings']);
  });

  it('registers all three tools when both findings scopes are present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:findings:read', 'mcp:findings:write']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['list_findings', 'record_finding', 'resolve_finding']);
  });
});

describe('record_finding', () => {
  it('records a new finding for a container subject and returns created true', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: {
        subjectId: 'nuc1/9f2c1ab34de5',
        fingerprint: 'postgres-connection-refused',
        severity: 'critical',
        title: 'Postgres refusing connections',
        evidence: [{ text: 'connection refused' }],
      },
    });

    expect(result.isError).toBeUndefined();
    expect(getContainerSnapshotMock).toHaveBeenCalledWith(expect.anything(), 'nuc1', '9f2c1ab34de5');
    expect(recordMock).toHaveBeenCalledTimes(1);
    const structured = result.structuredContent as { id: number; created: boolean; occurrences: number };
    expect(structured.id).toBe(101);
    expect(structured.created).toBe(true);
    expect(structured.occurrences).toBe(1);
  });

  it('surfaces the dedupe path: created false with the incremented occurrence count', async () => {
    recordMock.mockImplementation(async () => ({
      finding: makeFinding({ occurrences: 4 }),
      created: false,
      evidenceDropped: 0,
      evidenceTruncated: 0,
      detailTruncated: false,
    }));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: {
        subjectId: 'nuc1/9f2c1ab34de5',
        fingerprint: 'postgres-connection-refused',
        severity: 'critical',
        title: 'Postgres refusing connections again',
      },
    });

    const structured = result.structuredContent as { created: boolean; occurrences: number };
    expect(structured.created).toBe(false);
    expect(structured.occurrences).toBe(4);
  });

  it('reports evidence caps from the repository result', async () => {
    recordMock.mockImplementation(async () => ({
      finding: makeFinding(),
      created: true,
      evidenceDropped: 2,
      evidenceTruncated: 1,
      detailTruncated: true,
    }));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', fingerprint: 'postgres-connection-refused', severity: 'warning', title: 'x' },
    });

    const structured = result.structuredContent as { evidenceDropped: number; evidenceTruncated: number; detailTruncated: boolean };
    expect(structured.evidenceDropped).toBe(2);
    expect(structured.evidenceTruncated).toBe(1);
    expect(structured.detailTruncated).toBe(true);
  });

  it('passes null window fields to the repository when since/until are omitted', async () => {
    const { client } = await connectedClient(makeCtx());
    await client.callTool({
      name: 'record_finding',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', fingerprint: 'postgres-connection-refused', severity: 'info', title: 'x' },
    });

    expect(resolveWindowMock).not.toHaveBeenCalled();
    const input = recordMock.mock.calls[0]![0] as { windowFrom: Date | null; windowTo: Date | null };
    expect(input.windowFrom).toBeNull();
    expect(input.windowTo).toBeNull();
  });

  it('resolves the window through resolveWindow when since or until is provided', async () => {
    const { client } = await connectedClient(makeCtx());
    await client.callTool({
      name: 'record_finding',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', fingerprint: 'postgres-connection-refused', severity: 'info', title: 'x', since: '1h' },
    });

    expect(resolveWindowMock).toHaveBeenCalledTimes(1);
    const input = recordMock.mock.calls[0]![0] as { windowFrom: Date | null; windowTo: Date | null };
    expect(input.windowFrom).toEqual(DEFAULT_WINDOW.from);
    expect(input.windowTo).toEqual(DEFAULT_WINDOW.to);
  });

  it('unions subjectId into entityIds for a container subject', async () => {
    const { client } = await connectedClient(makeCtx());
    await client.callTool({
      name: 'record_finding',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', fingerprint: 'postgres-connection-refused', severity: 'info', title: 'x', entityIds: ['nuc1/othercontainer'] },
    });

    const input = recordMock.mock.calls[0]![0] as { entityIds: string[] };
    expect(input.entityIds).toEqual(['nuc1/othercontainer', 'nuc1/9f2c1ab34de5']);
  });

  it('accepts a host subject with no existence check', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: { subjectKind: 'host', subjectId: 'nuc1', fingerprint: 'disk-nearly-full', severity: 'warning', title: 'Disk nearly full' },
    });

    expect(result.isError).toBeUndefined();
    expect(getContainerSnapshotMock).not.toHaveBeenCalled();
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a fingerprint that fails the slug pattern', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', fingerprint: 'Postgres-Connection-Refused', severity: 'critical', title: 'x' },
    });

    expect(result.isError).toBe(true);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('rejects a title over the character cap', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', fingerprint: 'postgres-connection-refused', severity: 'critical', title: 'x'.repeat(201) },
    });

    expect(result.isError).toBe(true);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('rejects a detail over the character cap', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', fingerprint: 'postgres-connection-refused', severity: 'critical', title: 'x', detail: 'x'.repeat(4001) },
    });

    expect(result.isError).toBe(true);
  });

  it('rejects more than 10 evidence items', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: {
        subjectId: 'nuc1/9f2c1ab34de5',
        fingerprint: 'postgres-connection-refused',
        severity: 'critical',
        title: 'x',
        evidence: Array.from({ length: 11 }, (_, i) => ({ text: `line ${i}` })),
      },
    });

    expect(result.isError).toBe(true);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('rejects evidence text over 8000 characters', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: {
        subjectId: 'nuc1/9f2c1ab34de5',
        fingerprint: 'postgres-connection-refused',
        severity: 'critical',
        title: 'x',
        evidence: [{ text: 'x'.repeat(8001) }],
      },
    });

    expect(result.isError).toBe(true);
  });

  it('rejects an evidence source over 200 characters', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: {
        subjectId: 'nuc1/9f2c1ab34de5',
        fingerprint: 'postgres-connection-refused',
        severity: 'critical',
        title: 'x',
        evidence: [{ text: 'line', source: 'x'.repeat(201) }],
      },
    });

    expect(result.isError).toBe(true);
  });

  it('rejects an evidence "at" that is not an ISO timestamp', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: {
        subjectId: 'nuc1/9f2c1ab34de5',
        fingerprint: 'postgres-connection-refused',
        severity: 'critical',
        title: 'x',
        evidence: [{ text: 'line', at: '30m' }],
      },
    });

    expect(result.isError).toBe(true);
  });

  it('rejects more than 50 entityIds', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: {
        subjectId: 'nuc1/9f2c1ab34de5',
        fingerprint: 'postgres-connection-refused',
        severity: 'critical',
        title: 'x',
        entityIds: Array.from({ length: 51 }, (_, i) => `nuc1/c${i}`),
      },
    });

    expect(result.isError).toBe(true);
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('returns unknown_container when subjectId is not a valid container entity id', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: { subjectId: 'not-an-entity-id', fingerprint: 'postgres-connection-refused', severity: 'critical', title: 'x' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_container');
    expect(getContainerSnapshotMock).not.toHaveBeenCalled();
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('returns unknown_container when no snapshot exists for the entity id', async () => {
    getContainerSnapshotMock.mockImplementation(async () => null);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', fingerprint: 'postgres-connection-refused', severity: 'critical', title: 'x' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_container');
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('returns unknown_stack when a stack subjectId has no host/stack slash', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: { subjectKind: 'stack', subjectId: 'media', fingerprint: 'deploy-failing', severity: 'critical', title: 'x' },
    });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_stack');
    expect(recordMock).not.toHaveBeenCalled();
  });

  it('accepts a stack subjectId containing a slash', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: { subjectKind: 'stack', subjectId: 'nuc1/media', fingerprint: 'deploy-failing', severity: 'critical', title: 'x' },
    });

    expect(result.isError).toBeUndefined();
    expect(recordMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a downstream repository failure as an error result', async () => {
    recordMock.mockImplementation(async () => {
      throw new Error('connection refused');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'record_finding',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', fingerprint: 'postgres-connection-refused', severity: 'critical', title: 'x' },
    });

    expect(result.isError).toBe(true);
  });
});

describe('list_findings', () => {
  it('defaults to open status, no evidence, and a limit+1 fetch', async () => {
    listMock.mockImplementation(async () => [makeFinding()]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_findings', arguments: {} });

    expect(result.isError).toBeUndefined();
    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'open', limit: 21 }));
    const structured = result.structuredContent as { findings: Array<{ evidence: unknown[]; evidenceOmitted: boolean }>; count: number; hasMore: boolean; limitClamped: boolean };
    expect(structured.count).toBe(1);
    expect(structured.hasMore).toBe(false);
    expect(structured.limitClamped).toBe(false);
    expect(structured.findings[0]!.evidence).toEqual([]);
    expect(structured.findings[0]!.evidenceOmitted).toBe(true);
  });

  it('passes subjectId, entityId, fingerprint and severity filters through to the repository', async () => {
    const { client } = await connectedClient(makeCtx());
    await client.callTool({
      name: 'list_findings',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', entityId: 'nuc1/9f2c1ab34de5', fingerprint: 'postgres-connection-refused', severity: 'critical', status: 'any' },
    });

    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subjectId: 'nuc1/9f2c1ab34de5',
        entityId: 'nuc1/9f2c1ab34de5',
        fingerprint: 'postgres-connection-refused',
        severity: 'critical',
        status: 'any',
      }),
    );
  });

  it('truncates detail to 1000 characters when evidence is omitted', async () => {
    listMock.mockImplementation(async () => [makeFinding({ detail: 'x'.repeat(1500) })]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_findings', arguments: {} });

    const structured = result.structuredContent as { findings: Array<{ detail: string; detailTruncated: boolean }> };
    expect(structured.findings[0]!.detail).toHaveLength(1000);
    expect(structured.findings[0]!.detailTruncated).toBe(true);
  });

  it('includes evidence and clamps the limit to 10 when includeEvidence is set', async () => {
    listMock.mockImplementation(async () => [makeFinding()]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_findings', arguments: { includeEvidence: true, limit: 40 } });

    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 11 }));
    const structured = result.structuredContent as { findings: Array<{ evidence: unknown[]; evidenceOmitted: boolean }>; limitClamped: boolean };
    expect(structured.limitClamped).toBe(true);
    expect(structured.findings[0]!.evidenceOmitted).toBe(false);
    expect(structured.findings[0]!.evidence).toHaveLength(1);
  });

  it('does not clamp when includeEvidence is set and limit is already within the smaller cap', async () => {
    listMock.mockImplementation(async () => []);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_findings', arguments: { includeEvidence: true, limit: 5 } });

    expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 6 }));
    const structured = result.structuredContent as { limitClamped: boolean };
    expect(structured.limitClamped).toBe(false);
  });

  it('reports hasMore true and slices to the requested limit when more rows exist', async () => {
    listMock.mockImplementation(async () => [makeFinding({ id: 1 }), makeFinding({ id: 2 })]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_findings', arguments: { limit: 1 } });

    const structured = result.structuredContent as { findings: unknown[]; count: number; hasMore: boolean };
    expect(structured.findings).toHaveLength(1);
    expect(structured.count).toBe(1);
    expect(structured.hasMore).toBe(true);
  });

  it('rejects a limit above 50', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_findings', arguments: { limit: 51 } });

    expect(result.isError).toBe(true);
    expect(listMock).not.toHaveBeenCalled();
  });

  it('surfaces a downstream repository failure as an error result', async () => {
    listMock.mockImplementation(async () => {
      throw new Error('connection refused');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'list_findings', arguments: {} });

    expect(result.isError).toBe(true);
  });
});

describe('resolve_finding', () => {
  it('resolves an open finding and returns alreadyClosed false', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'resolve_finding', arguments: { id: 101, resolution: 'rolled back the deploy' } });

    expect(result.isError).toBeUndefined();
    expect(resolveMock).toHaveBeenCalledWith(expect.objectContaining({ id: 101, status: 'resolved', resolution: 'rolled back the deploy' }));
    const structured = result.structuredContent as { id: number; status: string; alreadyClosed: boolean; resolution: string };
    expect(structured.id).toBe(101);
    expect(structured.status).toBe('resolved');
    expect(structured.alreadyClosed).toBe(false);
    expect(structured.resolution).toBe('rolled back the deploy');
  });

  it('accepts an explicit dismissed status', async () => {
    resolveMock.mockImplementation(async () => ({
      finding: makeFinding({ status: 'dismissed', resolvedAt: new Date('2026-08-16T12:30:00.000Z'), resolution: 'duplicate of #99' }),
      alreadyClosed: false,
    }));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'resolve_finding', arguments: { id: 101, status: 'dismissed', resolution: 'duplicate of #99' } });

    expect(resolveMock).toHaveBeenCalledWith(expect.objectContaining({ status: 'dismissed' }));
    const structured = result.structuredContent as { status: string };
    expect(structured.status).toBe('dismissed');
  });

  it('returns alreadyClosed true with the original values unchanged for an already-closed finding', async () => {
    resolveMock.mockImplementation(async () => ({
      finding: makeFinding({ status: 'resolved', resolvedAt: new Date('2026-08-15T09:00:00.000Z'), resolution: 'first resolution note' }),
      alreadyClosed: true,
    }));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'resolve_finding', arguments: { id: 101, resolution: 'a second, different note' } });

    expect(result.isError).toBeUndefined();
    const structured = result.structuredContent as { alreadyClosed: boolean; resolution: string };
    expect(structured.alreadyClosed).toBe(true);
    expect(structured.resolution).toBe('first resolution note');
  });

  it('returns unknown_finding for a nonexistent id', async () => {
    resolveMock.mockImplementation(async () => null);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'resolve_finding', arguments: { id: 999, resolution: 'x' } });

    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain('unknown_finding');
  });

  it('rejects a non-positive id', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'resolve_finding', arguments: { id: 0, resolution: 'x' } });

    expect(result.isError).toBe(true);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('rejects a resolution over the character cap', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'resolve_finding', arguments: { id: 101, resolution: 'x'.repeat(1001) } });

    expect(result.isError).toBe(true);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('rejects an empty resolution', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'resolve_finding', arguments: { id: 101, resolution: '' } });

    expect(result.isError).toBe(true);
    expect(resolveMock).not.toHaveBeenCalled();
  });

  it('surfaces a downstream repository failure as an error result', async () => {
    resolveMock.mockImplementation(async () => {
      throw new Error('connection refused');
    });

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'resolve_finding', arguments: { id: 101, resolution: 'x' } });

    expect(result.isError).toBe(true);
  });
});
