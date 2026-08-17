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

function mockHasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required) || scopes.includes('mcp:read');
}

function mockIso(value: Date | number): string {
  return new Date(value).toISOString();
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

const resolveWindowMock = mock(
  (_input: { since?: string; until?: string }, _opts: { defaultSinceSeconds: number; maxSpanSeconds: number }) => DEFAULT_WINDOW,
);

mock.module('@/lib/mcp/shared', () => ({
  zEntityId: (() => {
    const { z } = require('zod');
    return z.string().regex(/^[^/\s]+\/[a-zA-Z0-9][a-zA-Z0-9_.-]*$/, { message: 'Expected an entity id' });
  })(),
  zTime: (() => {
    const { z } = require('zod');
    const RELATIVE_TIME = /^(\d{1,6})([smhd])$/;
    return z.string().refine((v: string) => RELATIVE_TIME.test(v) || !Number.isNaN(Date.parse(v)), { message: 'Expected a timestamp or duration' });
  })(),
  resolveWindow: resolveWindowMock,
  hasScope: mockHasScope,
  iso: mockIso,
  McpToolError: MockMcpToolError,
  ok: mockOk,
  fail: mockFail,
}));

mock.module('@/lib/findings/types', () => ({
  FINDING_SEVERITIES: ['info', 'warning', 'critical'],
  FINDING_STATUSES: ['open', 'resolved', 'dismissed'],
}));

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
  evidence: unknown[];
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
    evidence: [],
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

interface FindingLabelFixture {
  id: number;
  findingId: number;
  verdict: string;
  source: 'operator' | 'implicit' | 'agent';
  weight: number;
  signal: string | null;
  basisAt: Date | null;
  confounders: string[];
  evidence: unknown[];
  duplicateOfFindingId: number | null;
  note: string;
  labeledBy: string | null;
  labeledAt: Date;
  supersedesLabelId: number | null;
}

function makeLabel(overrides: Partial<FindingLabelFixture> = {}): FindingLabelFixture {
  return {
    id: 1,
    findingId: 101,
    verdict: 'actionable',
    source: 'operator',
    weight: 1,
    signal: null,
    basisAt: null,
    confounders: [],
    evidence: [],
    duplicateOfFindingId: null,
    note: '',
    labeledBy: 'op@example.com',
    labeledAt: new Date('2026-08-16T12:15:00.000Z'),
    supersedesLabelId: null,
    ...overrides,
  };
}

interface ReportedMissFixture {
  id: number;
  windowFrom: Date;
  windowTo: Date;
  entityIds: string[];
  severity: 'info' | 'warning' | 'critical';
  whatHappened: string;
  status: string;
  attributionVerdict: string | null;
}

function makeMiss(overrides: Partial<ReportedMissFixture> = {}): ReportedMissFixture {
  return {
    id: 5,
    windowFrom: new Date('2026-08-16T09:00:00.000Z'),
    windowTo: new Date('2026-08-16T10:00:00.000Z'),
    entityIds: ['nuc1/9f2c1ab34de5'],
    severity: 'critical',
    whatHappened: 'Postgres was down for 20 minutes and nothing fired.',
    status: 'new',
    attributionVerdict: null,
    ...overrides,
  };
}

const getByIdMock = mock(async (_id: number): Promise<FindingFixture | null> => makeFinding());
const listMock = mock(async (_options: unknown): Promise<FindingFixture[]> => [makeFinding()]);

mock.module('@/lib/database/repositories/findings-repository', () => ({
  FindingsRepository: mock().mockImplementation(() => ({ getById: getByIdMock, list: listMock })),
}));

const listForFindingMock = mock(async (_id: number): Promise<FindingLabelFixture[]> => []);

mock.module('@/lib/database/repositories/finding-label-repository', () => ({
  FindingLabelRepository: mock().mockImplementation(() => ({ listForFinding: listForFindingMock })),
}));

const missListMock = mock(async (_options: unknown): Promise<ReportedMissFixture[]> => []);

mock.module('@/lib/database/repositories/reported-miss-repository', () => ({
  ReportedMissRepository: mock().mockImplementation(() => ({ list: missListMock })),
}));

const { registerFeedbackTools } = await import('@/lib/mcp/tools/feedback');

function makeCtx(scopes: string[] = ['mcp:feedback:read']): McpToolContext {
  return {
    pool: {} as McpToolContext['pool'],
    scopes,
    callAgent: mock(async () => new Response('ok')),
  };
}

async function connectedClient(ctx: McpToolContext) {
  const server = new McpServer({ name: 'test-server', version: '0.0.0' });
  registerFeedbackTools(server, ctx);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

beforeEach(() => {
  resolveWindowMock.mockClear();
  resolveWindowMock.mockImplementation(() => DEFAULT_WINDOW);
  getByIdMock.mockClear();
  getByIdMock.mockImplementation(async () => makeFinding());
  listMock.mockClear();
  listMock.mockImplementation(async () => [makeFinding()]);
  listForFindingMock.mockClear();
  listForFindingMock.mockImplementation(async () => []);
  missListMock.mockClear();
  missListMock.mockImplementation(async () => []);
});

afterEach(() => {
  mock.restore();
});

describe('registerFeedbackTools', () => {
  it('registers no tools when the context has neither the feedback scope nor mcp:read', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:hosts:read']));
    expect(client.getServerCapabilities()?.tools).toBeUndefined();
  });

  it('registers get_finding_feedback when mcp:feedback:read is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:feedback:read']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_finding_feedback']);
  });

  it('registers get_finding_feedback when only the mcp:read umbrella scope is present', async () => {
    const { client } = await connectedClient(makeCtx(['mcp:read']));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['get_finding_feedback']);
  });
});

describe('get_finding_feedback', () => {
  it('rejects a call with no selector at all', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: {} });

    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain('missing_selector');
    expect(getByIdMock).not.toHaveBeenCalled();
    expect(listMock).not.toHaveBeenCalled();
  });

  it('looks a finding up directly by findingId, bypassing the list query', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { findingId: 101 } });

    expect(result.isError).toBeUndefined();
    expect(getByIdMock).toHaveBeenCalledWith(101);
    expect(listMock).not.toHaveBeenCalled();
    const structured = result.structuredContent as { findings: Array<{ findingId: number }>; summary: { total: number } };
    expect(structured.findings).toHaveLength(1);
    expect(structured.findings[0]!.findingId).toBe(101);
    expect(structured.summary.total).toBe(1);
  });

  it('returns an empty finding list when findingId does not resolve', async () => {
    getByIdMock.mockImplementation(async () => null);
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { findingId: 999 } });

    const structured = result.structuredContent as { findings: unknown[]; summary: { total: number } };
    expect(structured.findings).toEqual([]);
    expect(structured.summary.total).toBe(0);
  });

  it('falls back to the list query with the resolved window when subjectId is given', async () => {
    const { client } = await connectedClient(makeCtx());
    await client.callTool({ name: 'get_finding_feedback', arguments: { subjectId: 'nuc1/9f2c1ab34de5' } });

    expect(resolveWindowMock).toHaveBeenCalledTimes(1);
    expect(listMock).toHaveBeenCalledWith(
      expect.objectContaining({ subjectId: 'nuc1/9f2c1ab34de5', status: 'any', since: DEFAULT_WINDOW.from, until: DEFAULT_WINDOW.to }),
    );
  });

  it('reports an operator verdict and its note on a labeled finding', async () => {
    listForFindingMock.mockImplementation(async () => [makeLabel({ verdict: 'actionable', note: 'confirmed the outage' })]);
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { findingId: 101 } });

    const structured = result.structuredContent as { findings: Array<{ verdict: string; verdictSource: string; verdictNote: string }> };
    expect(structured.findings[0]).toMatchObject({ verdict: 'actionable', verdictSource: 'operator', verdictNote: 'confirmed the outage' });
  });

  it('picks the operator label as current even when an agent label is more recent', async () => {
    listForFindingMock.mockImplementation(async () => [
      makeLabel({ id: 9, source: 'agent', verdict: 'wrong', labeledAt: new Date('2026-08-16T13:00:00.000Z') }),
      makeLabel({ id: 4, source: 'operator', verdict: 'noise', labeledAt: new Date('2026-08-16T10:00:00.000Z') }),
    ]);
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { findingId: 101 } });

    const structured = result.structuredContent as { findings: Array<{ verdict: string; verdictSource: string; relabelCount: number }> };
    expect(structured.findings[0]).toMatchObject({ verdict: 'noise', verdictSource: 'operator', relabelCount: 1 });
  });

  it('breaks a tie between two operator labels by time, then by id', async () => {
    const sameTime = new Date('2026-08-16T10:00:00.000Z');
    listForFindingMock.mockImplementation(async () => [
      makeLabel({ id: 4, source: 'operator', verdict: 'noise', labeledAt: sameTime }),
      makeLabel({ id: 8, source: 'operator', verdict: 'wrong', labeledAt: sameTime }),
      makeLabel({ id: 2, source: 'operator', verdict: 'actionable', labeledAt: new Date('2026-08-16T09:00:00.000Z') }),
    ]);
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { findingId: 101 } });

    const structured = result.structuredContent as { findings: Array<{ verdict: string }> };
    expect(structured.findings[0]!.verdict).toBe('wrong');
  });

  it('reports duplicateOfFindingId when the current verdict is a duplicate', async () => {
    listForFindingMock.mockImplementation(async () => [makeLabel({ verdict: 'duplicate', duplicateOfFindingId: 55 })]);
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { findingId: 101 } });

    const structured = result.structuredContent as { findings: Array<{ duplicateOfFindingId: number | null }> };
    expect(structured.findings[0]!.duplicateOfFindingId).toBe(55);
  });

  it('carries an unlabeled finding through with a null verdict by default', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { findingId: 101 } });

    const structured = result.structuredContent as { findings: Array<{ verdict: string | null; verdictSource: string | null }> };
    expect(structured.findings[0]).toMatchObject({ verdict: null, verdictSource: null });
  });

  it('drops unlabeled findings when includeUnlabeled is false', async () => {
    listMock.mockImplementation(async () => [makeFinding({ id: 101 }), makeFinding({ id: 102 })]);
    listForFindingMock.mockImplementation(async (id: number) => (id === 101 ? [makeLabel({ verdict: 'actionable' })] : []));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'get_finding_feedback',
      arguments: { subjectId: 'nuc1/9f2c1ab34de5', includeUnlabeled: false },
    });

    const structured = result.structuredContent as { findings: Array<{ findingId: number }>; summary: { total: number; labeled: number } };
    expect(structured.findings.map((f) => f.findingId)).toEqual([101]);
    expect(structured.summary.total).toBe(2);
    expect(structured.summary.labeled).toBe(1);
  });

  it('includes weak signals from implicit labels, capped and separate from the operator verdict', async () => {
    listForFindingMock.mockImplementation(async () => [
      makeLabel({ verdict: 'actionable', source: 'operator' }),
      makeLabel({
        id: 2,
        source: 'implicit',
        verdict: 'actionable',
        signal: 'restart_after',
        weight: 0.25,
        confounders: ['operator_may_have_acted'],
      }),
    ]);
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { findingId: 101 } });

    const structured = result.structuredContent as {
      findings: Array<{ weakSignals: Array<{ signal: string; verdict: string; weight: number; confounders: string[]; at: string }> }>;
    };
    expect(structured.findings[0]!.weakSignals).toEqual([
      { signal: 'restart_after', verdict: 'actionable', weight: 0.25, confounders: ['operator_may_have_acted'], at: expect.any(String) },
    ]);
  });

  it('omits weak signals entirely when includeWeakSignals is false', async () => {
    listForFindingMock.mockImplementation(async () => [makeLabel({ id: 2, source: 'implicit', verdict: 'noise', signal: 'quiet_24h' })]);
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({
      name: 'get_finding_feedback',
      arguments: { findingId: 101, includeWeakSignals: false },
    });

    const structured = result.structuredContent as { findings: Array<{ weakSignals: unknown[] }> };
    expect(structured.findings[0]!.weakSignals).toEqual([]);
  });

  it('withholds precision below the minimum decisive label count', async () => {
    listMock.mockImplementation(async () => [makeFinding({ id: 101 })]);
    listForFindingMock.mockImplementation(async () => [makeLabel({ verdict: 'actionable' })]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { subjectId: 'nuc1/9f2c1ab34de5' } });

    const structured = result.structuredContent as { summary: { precision: number | null; precisionWithheldReason: string | null; precisionN: number } };
    expect(structured.summary.precision).toBeNull();
    expect(structured.summary.precisionWithheldReason).toBe('insufficient_labels');
    expect(structured.summary.precisionN).toBe(1);
  });

  it('withholds precision below the minimum coverage even with enough decisive labels', async () => {
    const findings = Array.from({ length: 50 }, (_, i) => makeFinding({ id: 400 + i }));
    listMock.mockImplementation(async () => findings);
    listForFindingMock.mockImplementation(async (id: number) => (id < 420 ? [makeLabel({ verdict: 'actionable' })] : []));

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { subjectId: 'nuc1/9f2c1ab34de5', limit: 50 } });

    const structured = result.structuredContent as { summary: { precision: number | null; precisionWithheldReason: string | null } };
    expect(structured.summary.precisionWithheldReason).toBe('insufficient_coverage');
    expect(structured.summary.precision).toBeNull();
  });

  it('reports precision once decisive labels and coverage both clear the minimum', async () => {
    const findings = Array.from({ length: 25 }, (_, i) => makeFinding({ id: 300 + i }));
    listMock.mockImplementation(async () => findings);
    listForFindingMock.mockImplementation(async (id: number) => [makeLabel({ verdict: id < 315 ? 'actionable' : 'noise' })]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { subjectId: 'nuc1/9f2c1ab34de5', limit: 50 } });

    const structured = result.structuredContent as { summary: { precision: number | null; precisionN: number; counts: { actionable: number; noise: number } } };
    expect(structured.summary.precisionN).toBe(25);
    expect(structured.summary.counts).toEqual(expect.objectContaining({ actionable: 15, noise: 10 }));
    expect(structured.summary.precision).toBeCloseTo(15 / 25);
  });

  it('gathers reported misses across the entity ids of the returned findings', async () => {
    missListMock.mockImplementation(async () => [makeMiss()]);
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { findingId: 101 } });

    expect(missListMock).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: 'nuc1/9f2c1ab34de5', windowFrom: DEFAULT_WINDOW.from, windowTo: DEFAULT_WINDOW.to }),
    );
    const structured = result.structuredContent as { reportedMisses: Array<{ id: number; whatHappened: string }> };
    expect(structured.reportedMisses).toHaveLength(1);
    expect(structured.reportedMisses[0]!.id).toBe(5);
  });

  it('skips the reported-misses lookup entirely when includeMisses is false', async () => {
    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { findingId: 101, includeMisses: false } });

    expect(missListMock).not.toHaveBeenCalled();
    const structured = result.structuredContent as { reportedMisses: unknown[] };
    expect(structured.reportedMisses).toEqual([]);
  });

  it('deduplicates reported misses seen through more than one entity id', async () => {
    listMock.mockImplementation(async () => [
      makeFinding({ id: 101, entityIds: ['nuc1/a'] }),
      makeFinding({ id: 102, entityIds: ['nuc1/b'] }),
    ]);
    missListMock.mockImplementation(async () => [makeMiss({ id: 5 })]);

    const { client } = await connectedClient(makeCtx());
    const result = await client.callTool({ name: 'get_finding_feedback', arguments: { subjectId: 'nuc1' } });

    const structured = result.structuredContent as { reportedMisses: Array<{ id: number }> };
    expect(structured.reportedMisses.map((m) => m.id)).toEqual([5]);
    expect(missListMock).toHaveBeenCalledTimes(2);
  });
});
