import { describe, it, expect, mock } from 'bun:test';

const FINDING_SEVERITIES = ['info', 'warning', 'critical'] as const;
const FINDING_STATUSES = ['open', 'resolved', 'dismissed'] as const;
const FINDING_SUBJECT_KINDS = ['container', 'stack', 'host'] as const;
const FINDING_EVIDENCE_KINDS = ['log_line', 'event', 'metric', 'deploy', 'note'] as const;

interface FakeEvidence {
  kind: string;
  at: Date | null;
  source: string;
  text: string;
  truncated: boolean;
}

interface FakeFinding {
  id: number;
  subjectKind: string;
  subjectId: string;
  entityIds: string[];
  fingerprint: string;
  severity: string;
  status: string;
  title: string;
  detail: string;
  evidence: FakeEvidence[];
  incidentIds: string[];
  runId: string | null;
  source: string;
  occurrences: number;
  windowFrom: Date | null;
  windowTo: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
}

function toFindingWire(finding: FakeFinding) {
  return {
    ...finding,
    windowFrom: finding.windowFrom ? finding.windowFrom.toISOString() : null,
    windowTo: finding.windowTo ? finding.windowTo.toISOString() : null,
    firstSeenAt: finding.firstSeenAt.toISOString(),
    lastSeenAt: finding.lastSeenAt.toISOString(),
    resolvedAt: finding.resolvedAt ? finding.resolvedAt.toISOString() : null,
    evidence: finding.evidence.map((e) => ({ ...e, at: e.at ? e.at.toISOString() : null })),
  };
}

function reviveFinding(wire: ReturnType<typeof toFindingWire>): FakeFinding {
  return {
    ...wire,
    windowFrom: wire.windowFrom ? new Date(wire.windowFrom) : null,
    windowTo: wire.windowTo ? new Date(wire.windowTo) : null,
    firstSeenAt: new Date(wire.firstSeenAt),
    lastSeenAt: new Date(wire.lastSeenAt),
    resolvedAt: wire.resolvedAt ? new Date(wire.resolvedAt) : null,
    evidence: wire.evidence.map((e) => ({ ...e, at: e.at ? new Date(e.at) : null })),
  };
}

mock.module('@/lib/findings/types', () => ({
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_SUBJECT_KINDS,
  FINDING_EVIDENCE_KINDS,
  toFindingWire,
  reviveFinding,
}));

const {
  findingsChannel,
  zFindingsWireMessage,
  zFindingWire,
  zFindingEvidenceWire,
  serializeFindingsEvent,
} = await import('../findings');

const finding: FakeFinding = {
  id: 7,
  subjectKind: 'container',
  subjectId: 'server1/abc123',
  entityIds: ['server1/abc123'],
  fingerprint: 'postgres-connection-refused',
  severity: 'critical',
  status: 'open',
  title: 'Postgres refusing connections',
  detail: 'Connection refused on every attempt since 12:00.',
  evidence: [
    { kind: 'log_line', at: new Date('2026-08-16T12:00:00.000Z'), source: 'stderr', text: 'connection refused', truncated: false },
  ],
  incidentIds: ['inc-e-1'],
  runId: 'run-1',
  source: 'agent',
  occurrences: 4,
  windowFrom: new Date('2026-08-16T11:00:00.000Z'),
  windowTo: new Date('2026-08-16T12:00:00.000Z'),
  firstSeenAt: new Date('2026-08-16T10:00:00.000Z'),
  lastSeenAt: new Date('2026-08-16T12:00:00.000Z'),
  resolvedAt: null,
  resolution: null,
};

const findingWire = toFindingWire(finding);

describe('findingsChannel', () => {
  it('exposes the url and errorEvent used by the route and the client', () => {
    expect(findingsChannel.url).toBe('/api/findings');
    expect(findingsChannel.errorEvent).toBe('findings_error');
  });

  it('validates a well-formed init frame', () => {
    const result = zFindingsWireMessage.safeParse({ type: 'init', findings: [findingWire] });
    expect(result.success).toBe(true);
  });

  it('validates a well-formed upsert frame', () => {
    const result = zFindingsWireMessage.safeParse({ type: 'upsert', finding: findingWire });
    expect(result.success).toBe(true);
  });

  it('validates a finding with a null window and null resolution fields', () => {
    const noWindow = toFindingWire({ ...finding, windowFrom: null, windowTo: null });
    const result = zFindingWire.safeParse(noWindow);
    expect(result.success).toBe(true);
  });

  it('validates a single evidence item', () => {
    const result = zFindingEvidenceWire.safeParse(findingWire.evidence[0]);
    expect(result.success).toBe(true);
  });

  it('drops a malformed frame rather than throwing (schema rejects, safeParse never throws)', () => {
    expect(() => zFindingsWireMessage.safeParse({ type: 'init', findings: [{ id: 'not-a-number' }] })).not.toThrow();
    const result = zFindingsWireMessage.safeParse({ type: 'init', findings: [{ id: 'not-a-number' }] });
    expect(result.success).toBe(false);
  });

  it('rejects a frame with an unrecognized type discriminant', () => {
    const result = zFindingsWireMessage.safeParse({ type: 'removed', id: 1 });
    expect(result.success).toBe(false);
  });

  it('revives an init frame into Date-bearing findings via reviveFinding', () => {
    const parsed = zFindingsWireMessage.parse({ type: 'init', findings: [findingWire] });
    const revived = findingsChannel.revive!(parsed);

    expect(revived.type).toBe('init');
    if (revived.type !== 'init') throw new Error('expected init');
    expect(revived.findings[0].firstSeenAt).toBeInstanceOf(Date);
    expect(revived.findings[0].lastSeenAt.getTime()).toBe(finding.lastSeenAt.getTime());
    expect(revived.findings[0].evidence[0].at).toBeInstanceOf(Date);
  });

  it('revives an upsert frame, including a null window and null resolvedAt', () => {
    const closed = { ...finding, status: 'resolved', resolvedAt: new Date('2026-08-16T13:00:00.000Z'), resolution: 'fixed' };
    const wire = toFindingWire(closed);
    const parsed = zFindingsWireMessage.parse({ type: 'upsert', finding: wire });
    const revived = findingsChannel.revive!(parsed);

    expect(revived.type).toBe('upsert');
    if (revived.type !== 'upsert') throw new Error('expected upsert');
    expect(revived.finding.resolvedAt).toBeInstanceOf(Date);
    expect(revived.finding.resolution).toBe('fixed');
  });
});

describe('serializeFindingsEvent', () => {
  it('serializes an init event as a data frame carrying wire-shaped findings', () => {
    const frame = serializeFindingsEvent({ type: 'init', findings: [finding] as never });
    expect(frame).toBe(`data: ${JSON.stringify({ type: 'init', findings: [findingWire] })}\n\n`);
    expect(frame.endsWith('\n\n')).toBe(true);
  });

  it('serializes an upsert event as a data frame carrying one wire-shaped finding', () => {
    const frame = serializeFindingsEvent({ type: 'upsert', finding } as never);
    expect(frame).toBe(`data: ${JSON.stringify({ type: 'upsert', finding: findingWire })}\n\n`);
  });
});
