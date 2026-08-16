import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { renderHook, act } from '@testing-library/react';

const FINDING_SEVERITIES = ['info', 'warning', 'critical'] as const;
const FINDING_STATUSES = ['open', 'resolved', 'dismissed'] as const;
const FINDING_SUBJECT_KINDS = ['container', 'stack', 'host'] as const;
const FINDING_EVIDENCE_KINDS = ['log_line', 'event', 'metric', 'deploy', 'note'] as const;

mock.module('@/lib/findings/types', () => ({
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  FINDING_SUBJECT_KINDS,
  FINDING_EVIDENCE_KINDS,
  toFindingWire: (f: unknown) => f,
  reviveFinding: (w: unknown) => w,
}));

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
  evidence: unknown[];
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

function makeFinding(overrides: Partial<FakeFinding> & { id: number }): FakeFinding {
  return {
    subjectKind: 'container',
    subjectId: 'server1/abc123',
    entityIds: ['server1/abc123'],
    fingerprint: `fingerprint-${overrides.id}`,
    severity: 'warning',
    status: 'open',
    title: `Finding ${overrides.id}`,
    detail: '',
    evidence: [],
    incidentIds: [],
    runId: null,
    source: 'agent',
    occurrences: 1,
    windowFrom: null,
    windowTo: null,
    firstSeenAt: new Date('2026-08-16T10:00:00.000Z'),
    lastSeenAt: new Date('2026-08-16T10:00:00.000Z'),
    resolvedAt: null,
    resolution: null,
    ...overrides,
  };
}

type FindingsSSEMessage =
  | { type: 'init'; findings: FakeFinding[] }
  | { type: 'upsert'; finding: FakeFinding };

interface UseSseChannelOptions {
  onData: (data: FindingsSSEMessage) => void;
}

let capturedOnData: ((data: FindingsSSEMessage) => void) | null = null;
let mockIsConnected = false;
let mockError: Error | null = null;

const useSseChannelMock = mock((_channel: unknown, options: UseSseChannelOptions) => {
  capturedOnData = options.onData;
  return { isConnected: mockIsConnected, error: mockError };
});

mock.module('@/hooks/useSseChannel', () => ({ useSseChannel: useSseChannelMock }));

const { useFindings } = await import('../useFindings');

function emit(data: FindingsSSEMessage) {
  act(() => {
    capturedOnData?.(data);
  });
}

beforeEach(() => {
  capturedOnData = null;
  mockIsConnected = false;
  mockError = null;
  useSseChannelMock.mockClear();
});

describe('useFindings', () => {
  it('starts with an empty findings array', () => {
    const { result } = renderHook(() => useFindings());
    expect(result.current.findings).toEqual([]);
  });

  it('passes isConnected and error through from useSseChannel', () => {
    mockIsConnected = true;
    mockError = new Error('Findings stream unavailable');
    const { result } = renderHook(() => useFindings());

    expect(result.current.isConnected).toBe(true);
    expect(result.current.error).toBe('Findings stream unavailable');
  });

  it('replaces the findings set wholesale on init', () => {
    const { result } = renderHook(() => useFindings());
    const a = makeFinding({ id: 1 });
    const b = makeFinding({ id: 2 });

    emit({ type: 'init', findings: [a, b] });
    expect(result.current.findings.map((f) => f.id).sort()).toEqual([1, 2]);

    emit({ type: 'init', findings: [makeFinding({ id: 3 })] });
    expect(result.current.findings.map((f) => f.id)).toEqual([3]);
  });

  it('merges an upsert: adds a new finding and updates an existing one in place', () => {
    const { result } = renderHook(() => useFindings());
    emit({ type: 'init', findings: [makeFinding({ id: 1, title: 'Original' })] });

    emit({ type: 'upsert', finding: makeFinding({ id: 2, title: 'New' }) });
    expect(result.current.findings).toHaveLength(2);

    emit({ type: 'upsert', finding: makeFinding({ id: 1, title: 'Updated', occurrences: 5 }) });
    expect(result.current.findings).toHaveLength(2);
    const updated = result.current.findings.find((f) => f.id === 1);
    expect(updated?.title).toBe('Updated');
    expect(updated?.occurrences).toBe(5);
  });

  it('returns the same findings array reference when an upsert is identical on the compared fields', () => {
    const { result } = renderHook(() => useFindings());
    const original = makeFinding({ id: 1, occurrences: 3 });
    emit({ type: 'init', findings: [original] });

    const before = result.current.findings;
    // A different object instance, but identical on (id, status, occurrences, lastSeenAt, severity):
    // a re-notify of an unchanged finding must not churn the array reference.
    emit({ type: 'upsert', finding: makeFinding({ id: 1, occurrences: 3, title: 'ignored diff' }) });

    expect(result.current.findings).toBe(before);
  });

  it('produces a new array reference when the compared fields actually change', () => {
    const { result } = renderHook(() => useFindings());
    emit({ type: 'init', findings: [makeFinding({ id: 1, occurrences: 1 })] });

    const before = result.current.findings;
    emit({ type: 'upsert', finding: makeFinding({ id: 1, occurrences: 2 }) });

    expect(result.current.findings).not.toBe(before);
  });

  it('sorts open findings before closed, then by lastSeenAt descending, then id descending', () => {
    const { result } = renderHook(() => useFindings());
    const openOld = makeFinding({ id: 1, status: 'open', lastSeenAt: new Date('2026-08-16T09:00:00.000Z') });
    const openNew = makeFinding({ id: 2, status: 'open', lastSeenAt: new Date('2026-08-16T11:00:00.000Z') });
    const resolvedRecent = makeFinding({ id: 3, status: 'resolved', lastSeenAt: new Date('2026-08-16T12:00:00.000Z') });
    const openTie1 = makeFinding({ id: 5, status: 'open', lastSeenAt: new Date('2026-08-16T11:00:00.000Z') });
    const openTie2 = makeFinding({ id: 4, status: 'open', lastSeenAt: new Date('2026-08-16T11:00:00.000Z') });

    emit({ type: 'init', findings: [openOld, resolvedRecent, openNew, openTie1, openTie2] });

    expect(result.current.findings.map((f) => f.id)).toEqual([5, 4, 2, 1, 3]);
  });
});
