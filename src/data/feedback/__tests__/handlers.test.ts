import { describe, it, expect, mock, spyOn, beforeEach, afterEach } from 'bun:test';
import { SYNTHETIC_ADMIN } from '@/lib/auth/types';
import type { AuthUser } from '@/lib/auth/types';
import { withStartContext } from '@/lib/test/start-context';
import type { FindingVerdictSummary, WeakSignalSummary } from '@/lib/feedback/types';

mock.module('@/lib/feedback/types', () => {
  const { z } = require('zod');
  return {
    OPERATOR_VERDICTS: ['actionable', 'noise', 'duplicate', 'wrong'],
    FEEDBACK_VERDICTS: ['actionable', 'noise', 'duplicate', 'wrong', 'inconclusive'],
    LABEL_SOURCES: ['operator', 'implicit', 'agent'],
    MISS_STATUSES: ['new', 'attributed', 'accepted', 'explained', 'invalid'],
    MAX_LABEL_NOTE_CHARS: 1000,
    MAX_MISS_DESCRIPTION_CHARS: 4000,
    MAX_MISS_ENTITY_IDS: 50,
    zOperatorVerdict: z.enum(['actionable', 'noise', 'duplicate', 'wrong']),
    zLabelNote: z.string().max(1000),
    toMissWire: (m: Record<string, unknown>) => ({
      ...m,
      windowFrom: (m.windowFrom as Date).toISOString(),
      windowTo: (m.windowTo as Date).toISOString(),
      reportedAt: (m.reportedAt as Date).toISOString(),
      updatedAt: (m.updatedAt as Date).toISOString(),
      attributedAt: m.attributedAt ? (m.attributedAt as Date).toISOString() : null,
    }),
  };
});

const {
  handleLabelFinding,
  handleListFindingVerdicts,
  handleReportMiss,
  handleSetMissStatus,
  handleReattributeMiss,
  handleGetFeedbackMetrics,
} = await import('../handlers');
import type { FeedbackHandlerDeps, ReportMissInput, SetMissStatusInput } from '../handlers';
const { reportMissSchema } = await import('../schemas');

const NOW = new Date('2026-08-19T15:00:00.000Z'); // a Wednesday

function makeFindingLabel(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    findingId: 10,
    verdict: 'noise',
    source: 'operator',
    weight: 1,
    signal: null,
    basisAt: null,
    confounders: [],
    evidence: [],
    duplicateOfFindingId: null,
    note: '',
    labeledBy: 'jared@glaserfamily.net',
    labeledAt: NOW,
    supersedesLabelId: null,
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Record<string, unknown>> = {}) {
  return { id: 10, status: 'open', ...overrides };
}

function makeReportedMiss(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 7,
    windowFrom: new Date('2026-08-19T10:00:00.000Z'),
    windowTo: new Date('2026-08-19T12:00:00.000Z'),
    entityIds: ['nuc1/9f2c1ab34de5'],
    host: null,
    stackProject: null,
    whatHappened: 'Postgres stopped responding at 11:40.',
    severity: 'critical',
    status: 'new',
    attribution: {},
    attributionVerdict: null,
    attributedAt: null,
    matchedFindingIds: [],
    matchedIncidentIds: [],
    reportedBy: 'jared@glaserfamily.net',
    reportedAt: NOW,
    note: '',
    updatedAt: NOW,
    ...overrides,
  };
}

function makeAttribution(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    verdict: 'finding_exists',
    findings: [{ id: 55 }],
    incidents: [{ id: 'inc-e-1' }],
    shapes: [],
    entityHadTraffic: true,
    computedAt: NOW,
    windowFrom: new Date('2026-08-19T10:00:00.000Z'),
    windowTo: new Date('2026-08-19T12:00:00.000Z'),
    ...overrides,
  };
}

function baseDeps(overrides: Partial<FeedbackHandlerDeps> = {}): FeedbackHandlerDeps {
  return {
    labels: {
      insert: mock(async () => makeFindingLabel()) as never,
      currentForFindings: mock(async () => new Map()) as never,
      weakSignalsForFindings: mock(async () => new Map()) as never,
      listForFinding: mock(async () => []) as never,
    },
    findings: {
      getById: mock(async () => makeFinding()) as never,
      resolve: mock(async () => ({ finding: makeFinding({ status: 'dismissed' }), alreadyClosed: false })) as never,
    },
    misses: {
      create: mock(async () => makeReportedMiss()) as never,
      getById: mock(async () => makeReportedMiss()) as never,
      list: mock(async () => [makeReportedMiss()]) as never,
      saveAttribution: mock(async () => makeReportedMiss({ status: 'attributed' })) as never,
      setStatus: mock(async () => makeReportedMiss({ status: 'accepted' })) as never,
      countByStatus: mock(async () => ({})) as never,
      countByAttributionVerdict: mock(async () => ({})) as never,
    } as never,
    attribute: mock(async () => makeAttribution()) as never,
    metrics: mock(async () => ({}) as never) as never,
    now: () => NOW,
    ...overrides,
  };
}

describe('handleLabelFinding', () => {
  it('records the first verdict on a finding and defaults to closing a non-actionable verdict', async () => {
    const deps = baseDeps();
    const result = await handleLabelFinding(deps, { findingId: 10, verdict: 'noise' }, 'op@example.com');

    expect(deps.labels.insert).toHaveBeenCalledWith(
      expect.objectContaining({ findingId: 10, verdict: 'noise', source: 'operator', weight: 1, supersedesLabelId: null, labeledBy: 'op@example.com' }),
    );
    expect(deps.findings.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, status: 'dismissed', resolution: 'Labeled noise by op@example.com' }),
    );
    expect(result.closed).toBe(true);
    expect(result.findingStatus).toBe('dismissed');
    expect(result.relabelCount).toBe(0);
  });

  it('does not close the finding when the verdict is actionable and close is unspecified', async () => {
    const deps = baseDeps();
    const result = await handleLabelFinding(deps, { findingId: 10, verdict: 'actionable' }, 'op@example.com');

    expect(deps.findings.resolve).not.toHaveBeenCalled();
    expect(result.closed).toBe(false);
    expect(result.findingStatus).toBe('open');
  });

  it('closes an actionable verdict when close is explicitly true', async () => {
    const deps = baseDeps();
    await handleLabelFinding(deps, { findingId: 10, verdict: 'actionable', close: true }, 'op@example.com');

    expect(deps.findings.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: 'Labeled actionable by op@example.com' }));
  });

  it('leaves a noise verdict open when close is explicitly false', async () => {
    const deps = baseDeps();
    const result = await handleLabelFinding(deps, { findingId: 10, verdict: 'noise', close: false }, 'op@example.com');

    expect(deps.findings.resolve).not.toHaveBeenCalled();
    expect(result.closed).toBe(false);
  });

  it('rejects a no-op relabel to the current verdict', async () => {
    const deps = baseDeps({
      labels: {
        insert: mock(async () => makeFindingLabel()) as never,
        currentForFindings: mock(async () => new Map()) as never,
        weakSignalsForFindings: mock(async () => new Map()) as never,
        listForFinding: mock(async () => [makeFindingLabel({ id: 5, verdict: 'noise', source: 'operator' })]) as never,
      },
    });

    await expect(handleLabelFinding(deps, { findingId: 10, verdict: 'noise' }, 'op@example.com')).rejects.toThrow(/already labeled 'noise'/);
    expect(deps.labels.insert).not.toHaveBeenCalled();
  });

  it('references the previous explicit label id as supersedesLabelId when changing a verdict', async () => {
    const deps = baseDeps({
      labels: {
        insert: mock(async () => makeFindingLabel()) as never,
        currentForFindings: mock(async () => new Map()) as never,
        weakSignalsForFindings: mock(async () => new Map()) as never,
        listForFinding: mock(async () => [makeFindingLabel({ id: 5, verdict: 'noise', source: 'operator' })]) as never,
      },
    });

    await handleLabelFinding(deps, { findingId: 10, verdict: 'actionable' }, 'op@example.com');

    expect(deps.labels.insert).toHaveBeenCalledWith(expect.objectContaining({ supersedesLabelId: 5 }));
  });

  it('picks the operator label as current over a more recent agent label (invariant 1 tie-break)', async () => {
    const agentLabel = makeFindingLabel({ id: 10, source: 'agent', verdict: 'wrong', labeledAt: new Date('2026-08-19T14:00:00.000Z') });
    const operatorLabel = makeFindingLabel({ id: 3, source: 'operator', verdict: 'noise', labeledAt: new Date('2026-08-19T10:00:00.000Z') });
    const deps = baseDeps({
      labels: {
        insert: mock(async () => makeFindingLabel()) as never,
        currentForFindings: mock(async () => new Map()) as never,
        weakSignalsForFindings: mock(async () => new Map()) as never,
        listForFinding: mock(async () => [agentLabel, operatorLabel]) as never,
      },
    });

    await handleLabelFinding(deps, { findingId: 10, verdict: 'actionable' }, 'op@example.com');

    expect(deps.labels.insert).toHaveBeenCalledWith(expect.objectContaining({ supersedesLabelId: 3 }));
  });

  it('breaks a tie between two operator labels by time, then by id', async () => {
    const older = makeFindingLabel({ id: 4, source: 'operator', verdict: 'noise', labeledAt: new Date('2026-08-19T09:00:00.000Z') });
    const newer = makeFindingLabel({ id: 8, source: 'operator', verdict: 'wrong', labeledAt: new Date('2026-08-19T11:00:00.000Z') });
    const deps = baseDeps({
      labels: {
        insert: mock(async () => makeFindingLabel()) as never,
        currentForFindings: mock(async () => new Map()) as never,
        weakSignalsForFindings: mock(async () => new Map()) as never,
        listForFinding: mock(async () => [older, newer]) as never,
      },
    });

    await handleLabelFinding(deps, { findingId: 10, verdict: 'actionable' }, 'op@example.com');

    expect(deps.labels.insert).toHaveBeenCalledWith(expect.objectContaining({ supersedesLabelId: 8 }));
  });

  it('breaks a same-timestamp tie between two operator labels by the higher id', async () => {
    const sameTime = new Date('2026-08-19T09:00:00.000Z');
    const lowerId = makeFindingLabel({ id: 4, source: 'operator', verdict: 'noise', labeledAt: sameTime });
    const higherId = makeFindingLabel({ id: 8, source: 'operator', verdict: 'wrong', labeledAt: sameTime });
    const deps = baseDeps({
      labels: {
        insert: mock(async () => makeFindingLabel()) as never,
        currentForFindings: mock(async () => new Map()) as never,
        weakSignalsForFindings: mock(async () => new Map()) as never,
        listForFinding: mock(async () => [lowerId, higherId]) as never,
      },
    });

    await handleLabelFinding(deps, { findingId: 10, verdict: 'actionable' }, 'op@example.com');

    expect(deps.labels.insert).toHaveBeenCalledWith(expect.objectContaining({ supersedesLabelId: 8 }));
  });

  it('counts prior explicit labels for relabelCount, ignoring implicit rows', async () => {
    const deps = baseDeps({
      labels: {
        insert: mock(async () => makeFindingLabel()) as never,
        currentForFindings: mock(async () => new Map()) as never,
        weakSignalsForFindings: mock(async () => new Map()) as never,
        listForFinding: mock(async () => [
          makeFindingLabel({ id: 1, source: 'operator', verdict: 'noise' }),
          makeFindingLabel({ id: 2, source: 'implicit', verdict: 'actionable' }),
          makeFindingLabel({ id: 3, source: 'agent', verdict: 'wrong' }),
        ]) as never,
      },
    });

    const result = await handleLabelFinding(deps, { findingId: 10, verdict: 'actionable' }, 'op@example.com');
    expect(result.relabelCount).toBe(2);
  });

  it('stores duplicateOfFindingId and names the target in the resolution text', async () => {
    const deps = baseDeps();
    await handleLabelFinding(deps, { findingId: 10, verdict: 'duplicate', duplicateOfId: 42 }, 'op@example.com');

    expect(deps.labels.insert).toHaveBeenCalledWith(expect.objectContaining({ duplicateOfFindingId: 42 }));
    expect(deps.findings.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: 'Labeled duplicate of #42 by op@example.com' }));
  });

  it('accepts a duplicate verdict with no target id', async () => {
    const deps = baseDeps();
    const result = await handleLabelFinding(deps, { findingId: 10, verdict: 'duplicate' }, 'op@example.com');

    expect(result.duplicateOfFindingId).toBeNull();
    expect(deps.findings.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: 'Labeled duplicate by op@example.com' }));
  });

  it('appends the note to the resolution text', async () => {
    const deps = baseDeps();
    await handleLabelFinding(deps, { findingId: 10, verdict: 'wrong', note: 'misread stderr' }, 'op@example.com');

    expect(deps.findings.resolve).toHaveBeenCalledWith(expect.objectContaining({ resolution: 'Labeled wrong by op@example.com: misread stderr' }));
  });

  it('throws when the finding does not exist', async () => {
    const deps = baseDeps({ findings: { getById: mock(async () => null) as never, resolve: mock(async () => null) as never } });
    await expect(handleLabelFinding(deps, { findingId: 999, verdict: 'noise' }, 'op@example.com')).rejects.toThrow('not found');
  });

  it('reflects an already-closed finding without claiming it was newly closed', async () => {
    const deps = baseDeps({
      findings: {
        getById: mock(async () => makeFinding({ status: 'resolved' })) as never,
        resolve: mock(async () => ({ finding: makeFinding({ status: 'resolved' }), alreadyClosed: true })) as never,
      },
    });

    const result = await handleLabelFinding(deps, { findingId: 10, verdict: 'wrong' }, 'op@example.com');
    expect(result.closed).toBe(false);
    expect(result.findingStatus).toBe('resolved');
  });

  it('falls back to the finding status already on hand when resolve returns null', async () => {
    const deps = baseDeps({
      findings: {
        getById: mock(async () => makeFinding({ status: 'open' })) as never,
        resolve: mock(async () => null) as never,
      },
    });

    const result = await handleLabelFinding(deps, { findingId: 10, verdict: 'wrong' }, 'op@example.com');
    expect(result.closed).toBe(false);
    expect(result.findingStatus).toBe('open');
  });
});

describe('handleListFindingVerdicts', () => {
  it('returns empty results without querying when findingIds is empty', async () => {
    const deps = baseDeps();
    const result = await handleListFindingVerdicts(deps, { findingIds: [] });

    expect(result).toEqual({ verdicts: [], weakSignals: [] });
    expect(deps.labels.currentForFindings).not.toHaveBeenCalled();
    expect(deps.labels.weakSignalsForFindings).not.toHaveBeenCalled();
  });

  it('returns verdicts and weak signals from the repository maps', async () => {
    const verdict: FindingVerdictSummary = { findingId: 10, verdict: 'actionable', source: 'operator', note: '', duplicateOfFindingId: null, labeledBy: 'op@example.com', labeledAt: NOW, relabelCount: 0 };
    const weak: WeakSignalSummary = { findingId: 11, actionableWeight: 0.3, noiseWeight: 0, signalCount: 1, signals: ['restart_after'], confounders: [], lastInferredAt: NOW };
    const deps = baseDeps({
      labels: {
        insert: mock(async () => makeFindingLabel()) as never,
        currentForFindings: mock(async () => new Map([[10, verdict]])) as never,
        weakSignalsForFindings: mock(async () => new Map([[11, weak]])) as never,
        listForFinding: mock(async () => []) as never,
      },
    });

    const result = await handleListFindingVerdicts(deps, { findingIds: [10, 11] });
    expect(result.verdicts).toEqual([verdict]);
    expect(result.weakSignals).toEqual([weak]);
    expect(deps.labels.currentForFindings).toHaveBeenCalledWith([10, 11]);
  });
});

describe('handleReportMiss', () => {
  const input: ReportMissInput = {
    windowFrom: new Date('2026-08-19T10:00:00.000Z'),
    windowTo: new Date('2026-08-19T12:00:00.000Z'),
    entityIds: ['nuc1/9f2c1ab34de5'],
    whatHappened: 'Postgres stopped responding at 11:40.',
    severity: 'critical',
  };

  it('creates the miss and saves a successful attribution', async () => {
    const deps = baseDeps();
    const result = await handleReportMiss(deps, input, 'op@example.com');

    expect(deps.misses.create).toHaveBeenCalledWith(expect.objectContaining({ reportedBy: 'op@example.com', whatHappened: input.whatHappened }));
    expect(deps.attribute).toHaveBeenCalledWith({ windowFrom: input.windowFrom, windowTo: input.windowTo, entityIds: input.entityIds });
    expect(deps.misses.saveAttribution).toHaveBeenCalledWith(7, 'finding_exists', expect.anything(), [55], ['inc-e-1'], NOW);
    expect(result.attributionFailed).toBe(false);
    expect(result.attribution).not.toBeNull();
    expect(result.miss.status).toBe('attributed');
  });

  it('keeps the miss as filed and flags attributionFailed when attribution throws', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const deps = baseDeps({ attribute: mock(async () => { throw new Error('query timeout'); }) as never });

    const result = await handleReportMiss(deps, input, 'op@example.com');

    expect(result.attributionFailed).toBe(true);
    expect(result.attribution).toBeNull();
    expect(result.miss.status).toBe('new');
    expect(deps.misses.saveAttribution).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });
});

describe('handleSetMissStatus', () => {
  it('updates status and returns the wire-shaped miss', async () => {
    const deps = baseDeps();
    const input: SetMissStatusInput = { id: 7, status: 'accepted', note: 'confirmed with the operator' };
    const result = await handleSetMissStatus(deps, input);

    expect(deps.misses.setStatus).toHaveBeenCalledWith(7, 'accepted', 'confirmed with the operator');
    expect(result.status).toBe('accepted');
    expect(typeof result.windowFrom).toBe('string');
  });

  it('throws when the reported miss does not exist', async () => {
    const deps = baseDeps({ misses: { ...baseDeps().misses, setStatus: mock(async () => null) as never } as never });
    await expect(handleSetMissStatus(deps, { id: 999, status: 'invalid' })).rejects.toThrow('not found');
  });
});

describe('handleReattributeMiss', () => {
  it('re-runs attribution for an existing miss and saves it', async () => {
    const deps = baseDeps();
    const result = await handleReattributeMiss(deps, { id: 7 });

    expect(deps.misses.getById).toHaveBeenCalledWith(7);
    expect(deps.attribute).toHaveBeenCalled();
    expect(result.attributionFailed).toBe(false);
  });

  it('throws when the reported miss does not exist', async () => {
    const deps = baseDeps({ misses: { ...baseDeps().misses, getById: mock(async () => null) as never } as never });
    await expect(handleReattributeMiss(deps, { id: 999 })).rejects.toThrow('not found');
  });

  it('flags attributionFailed and logs when re-attribution throws', async () => {
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    const deps = baseDeps({ attribute: mock(async () => { throw new Error('pool exhausted'); }) as never });

    const result = await handleReattributeMiss(deps, { id: 7 });
    expect(result.attributionFailed).toBe(true);
    expect(result.miss.id).toBe(7);
    logged.mockRestore();
  });
});

describe('handleGetFeedbackMetrics', () => {
  it('defaults to the current ISO week (Monday 00:00 UTC through the following Monday) when no period is given', async () => {
    const deps = baseDeps();
    await handleGetFeedbackMetrics(deps, {});

    expect(deps.metrics).toHaveBeenCalledWith({
      from: new Date('2026-08-17T00:00:00.000Z'),
      to: new Date('2026-08-24T00:00:00.000Z'),
    });
  });

  it('uses the provided period when both from and to are given', async () => {
    const deps = baseDeps();
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-01-08T00:00:00.000Z');
    await handleGetFeedbackMetrics(deps, { from, to });

    expect(deps.metrics).toHaveBeenCalledWith({ from, to });
  });

  it('rejects a period with only "from" given', async () => {
    const deps = baseDeps();
    await expect(handleGetFeedbackMetrics(deps, { from: new Date('2026-01-01T00:00:00.000Z') })).rejects.toThrow(
      'Both from and to must be provided together, or neither',
    );
  });

  it('rejects a period with only "to" given', async () => {
    const deps = baseDeps();
    await expect(handleGetFeedbackMetrics(deps, { to: new Date('2026-01-01T00:00:00.000Z') })).rejects.toThrow(
      'Both from and to must be provided together, or neither',
    );
  });
});

// --- Server function wiring: role guarding and dependency assembly (functions.tsx) ---

let activeUser: AuthUser = SYNTHETIC_ADMIN;

async function withUser<T>(user: AuthUser, run: () => Promise<T>): Promise<T> {
  activeUser = user;
  try {
    return await run();
  } finally {
    activeUser = SYNTHETIC_ADMIN;
  }
}

mock.module('@/middleware/auth-middleware', () => ({
  authMiddleware: {
    options: {
      type: 'function',
      client: async ({ next, sendContext }: { next: (opts: { sendContext: unknown }) => unknown; sendContext: unknown }) =>
        next({ sendContext: { ...(sendContext as Record<string, unknown>), user: activeUser } }),
      server: async ({ next, context }: { next: (opts: { context: unknown }) => unknown; context: unknown }) =>
        next({ context: { ...(context as Record<string, unknown>), user: activeUser } }),
    },
  },
  AuthError: class AuthError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'AuthError';
    }
  },
}));

mock.module('@/lib/clients/database-client', () => ({
  databaseConnectionManager: { getClient: mock(async () => ({ getPool: () => ({ __fakePool: true }) })) },
}));
mock.module('@/lib/config/database-config', () => ({ loadDatabaseConfig: mock(() => ({})) }));

const labelInsertMock = mock(async () => makeFindingLabel());
const labelCurrentForFindingsMock = mock(async () => new Map());
const labelWeakSignalsForFindingsMock = mock(async () => new Map());
const labelListForFindingMock = mock(async () => []);

mock.module('@/lib/database/repositories/finding-label-repository', () => ({
  FindingLabelRepository: mock().mockImplementation(() => ({
    insert: labelInsertMock,
    currentForFindings: labelCurrentForFindingsMock,
    weakSignalsForFindings: labelWeakSignalsForFindingsMock,
    listForFinding: labelListForFindingMock,
  })),
}));

const findingsGetByIdMock = mock(async () => makeFinding());
const findingsResolveMock = mock(async () => ({ finding: makeFinding({ status: 'dismissed' }), alreadyClosed: false }));

mock.module('@/lib/database/repositories/findings-repository', () => ({
  FindingsRepository: mock().mockImplementation(() => ({
    getById: findingsGetByIdMock,
    resolve: findingsResolveMock,
  })),
}));

const missCreateMock = mock(async () => makeReportedMiss());
const missGetByIdMock = mock(async () => makeReportedMiss());
const missListMock = mock(async () => [makeReportedMiss()]);
const missSaveAttributionMock = mock(async () => makeReportedMiss({ status: 'attributed' }));
const missSetStatusMock = mock(async () => makeReportedMiss({ status: 'accepted' }));

mock.module('@/lib/database/repositories/reported-miss-repository', () => ({
  ReportedMissRepository: mock().mockImplementation(() => ({
    create: missCreateMock,
    getById: missGetByIdMock,
    list: missListMock,
    saveAttribution: missSaveAttributionMock,
    setStatus: missSetStatusMock,
  })),
}));

const attributeMissMock = mock(async () => makeAttribution());
mock.module('@/lib/feedback/attribution', () => ({ attributeMiss: attributeMissMock }));

const getFeedbackMetricsServiceMock = mock(async () => ({ findingsThisWeek: { count: 0 } }));
mock.module('@/lib/feedback/metrics-service', () => ({ getFeedbackMetrics: getFeedbackMetricsServiceMock }));

const {
  labelFinding,
  listFindingVerdicts,
  reportMiss,
  listReportedMisses,
  setMissStatus,
  reattributeMiss,
  getFeedbackMetrics,
} = await import('../functions');

const OPERATOR: AuthUser = { ...SYNTHETIC_ADMIN, role: 'operator' };
const VIEWER: AuthUser = { ...SYNTHETIC_ADMIN, role: 'viewer' };

describe('server functions: role guarding', () => {
  beforeEach(() => {
    labelInsertMock.mockClear();
    findingsGetByIdMock.mockClear();
    findingsResolveMock.mockClear();
    missCreateMock.mockClear();
    missSetStatusMock.mockClear();
    attributeMissMock.mockClear();
  });

  it('rejects a viewer setting a verdict without reaching the database', async () => {
    await expect(
      withUser(VIEWER, () => withStartContext(() => labelFinding({ data: { findingId: 10, verdict: 'noise' } }))),
    ).rejects.toThrow('Insufficient permissions');
    expect(findingsGetByIdMock).not.toHaveBeenCalled();
  });

  it('lets an operator set a verdict', async () => {
    await withUser(OPERATOR, () => withStartContext(() => labelFinding({ data: { findingId: 10, verdict: 'noise' } })));
    expect(labelInsertMock).toHaveBeenCalledTimes(1);
    expect(labelInsertMock).toHaveBeenCalledWith(expect.objectContaining({ verdict: 'noise', labeledBy: OPERATOR.email }));
  });

  it('rejects a viewer reporting a miss', async () => {
    await expect(
      withUser(VIEWER, () =>
        withStartContext(() =>
          reportMiss({
            data: {
              windowFrom: new Date('2026-08-19T10:00:00.000Z'),
              windowTo: new Date('2026-08-19T12:00:00.000Z'),
              entityIds: ['nuc1/9f2c1ab34de5'],
              whatHappened: 'Postgres stopped responding.',
              severity: 'critical',
            },
          }),
        ),
      ),
    ).rejects.toThrow('Insufficient permissions');
    expect(missCreateMock).not.toHaveBeenCalled();
  });

  it('lets an operator report a miss and runs attribution', async () => {
    await withUser(OPERATOR, () =>
      withStartContext(() =>
        reportMiss({
          data: {
            windowFrom: new Date('2026-08-19T10:00:00.000Z'),
            windowTo: new Date('2026-08-19T12:00:00.000Z'),
            entityIds: ['nuc1/9f2c1ab34de5'],
            whatHappened: 'Postgres stopped responding.',
            severity: 'critical',
          },
        }),
      ),
    );
    expect(missCreateMock).toHaveBeenCalledTimes(1);
    expect(attributeMissMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a viewer changing a reported miss status', async () => {
    await expect(
      withUser(VIEWER, () => withStartContext(() => setMissStatus({ data: { id: 7, status: 'accepted' } }))),
    ).rejects.toThrow('Insufficient permissions');
    expect(missSetStatusMock).not.toHaveBeenCalled();
  });

  it('lets an admin change a reported miss status', async () => {
    await withUser(SYNTHETIC_ADMIN, () => withStartContext(() => setMissStatus({ data: { id: 7, status: 'accepted' } })));
    expect(missSetStatusMock).toHaveBeenCalledWith(7, 'accepted', '');
  });

  it('rejects a viewer re-attributing a reported miss', async () => {
    await expect(withUser(VIEWER, () => withStartContext(() => reattributeMiss({ data: { id: 7 } })))).rejects.toThrow('Insufficient permissions');
    expect(attributeMissMock).not.toHaveBeenCalled();
  });

  it('lets an operator re-attribute a reported miss', async () => {
    await withUser(OPERATOR, () => withStartContext(() => reattributeMiss({ data: { id: 7 } })));
    expect(missGetByIdMock).toHaveBeenCalledWith(7);
    expect(attributeMissMock).toHaveBeenCalledTimes(1);
  });

  it('lets any authenticated user list finding verdicts without a role check', async () => {
    labelCurrentForFindingsMock.mockClear();
    await withUser(VIEWER, () => withStartContext(() => listFindingVerdicts({ data: { findingIds: [10] } })));
    expect(labelCurrentForFindingsMock).toHaveBeenCalledWith([10]);
  });

  it('lets any authenticated user list reported misses without a role check', async () => {
    await withUser(VIEWER, () => withStartContext(() => listReportedMisses({ data: {} })));
    expect(missListMock).toHaveBeenCalledWith({ status: undefined, entityId: undefined, windowFrom: undefined, windowTo: undefined, limit: undefined });
  });

  it('lets any authenticated user read feedback metrics without a role check', async () => {
    await withUser(VIEWER, () => withStartContext(() => getFeedbackMetrics({ data: {} })));
    expect(getFeedbackMetricsServiceMock).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  activeUser = SYNTHETIC_ADMIN;
});

describe('reportMissSchema', () => {
  const valid = {
    windowFrom: '2026-08-19T10:00:00.000Z',
    windowTo: '2026-08-19T12:00:00.000Z',
    entityIds: ['nuc1/9f2c1ab34de5'],
    whatHappened: 'Postgres stopped responding at 11:40.',
    severity: 'critical',
  };

  it('accepts a well-formed report', () => {
    const result = reportMissSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it('rejects a window where windowFrom is not before windowTo', () => {
    const result = reportMissSchema.safeParse({ ...valid, windowFrom: valid.windowTo, windowTo: valid.windowFrom });
    expect(result.success).toBe(false);
  });

  it('rejects a window spanning more than 7 days', () => {
    const result = reportMissSchema.safeParse({ ...valid, windowFrom: '2026-08-01T00:00:00.000Z', windowTo: '2026-08-10T00:00:00.000Z' });
    expect(result.success).toBe(false);
  });
});
