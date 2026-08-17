import { describe, it, expect, beforeEach } from 'bun:test';
import {
  ReportedMissRepository,
  IncidentRepository,
  attributeMiss,
  classifyAttribution,
  type CreateReportedMissInput,
  type IncidentRecordInput,
  type AttributionFindingRow,
  type AttributionIncidentRow,
  type AttributionShapeRow,
} from '../reported-incident-repository';
import { createMockPool } from '@/lib/test/mock-pool';

function buildMissRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '1',
    window_from: new Date('2026-08-16T21:00:00.000Z'),
    window_to: new Date('2026-08-16T22:00:00.000Z'),
    entity_ids: ['server1/abc123'],
    host: 'server1',
    stack_project: null,
    what_happened: 'Jellyfin stopped transcoding and nothing was reported.',
    severity: 'warning',
    status: 'new',
    attribution: {},
    attribution_verdict: null,
    attributed_at: null,
    matched_finding_ids: [],
    matched_incident_ids: [],
    reported_by: 'jared@glaserfamily.net',
    reported_at: new Date('2026-08-17T08:00:00.000Z'),
    note: '',
    updated_at: new Date('2026-08-17T08:00:00.000Z'),
    ...overrides,
  };
}

function baseMissInput(overrides: Partial<CreateReportedMissInput> = {}): CreateReportedMissInput {
  return {
    windowFrom: new Date('2026-08-16T21:00:00.000Z'),
    windowTo: new Date('2026-08-16T22:00:00.000Z'),
    entityIds: ['server1/abc123'],
    whatHappened: 'Jellyfin stopped transcoding and nothing was reported.',
    severity: 'warning',
    reportedBy: 'jared@glaserfamily.net',
    ...overrides,
  };
}

describe('ReportedMissRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: ReportedMissRepository;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new ReportedMissRepository(mockPool.pool as never);
  });

  describe('create', () => {
    it('inserts with defaulted host/stackProject/note', async () => {
      mockPool.pushResult([buildMissRow()]);

      const miss = await repo.create(baseMissInput());

      expect(miss.id).toBe(1);
      expect(miss.status).toBe('new');
      const call = mockPool.queries[0];
      expect(call.sql).toContain('INSERT INTO reported_misses');
      expect(call.params).toEqual([
        baseMissInput().windowFrom,
        baseMissInput().windowTo,
        ['server1/abc123'],
        null,
        null,
        'Jellyfin stopped transcoding and nothing was reported.',
        'warning',
        'jared@glaserfamily.net',
        '',
      ]);
    });

    it('passes through an explicit host, stackProject and note', async () => {
      mockPool.pushResult([buildMissRow({ host: 'server1', stack_project: 'media', note: 'checked with the operator' })]);

      await repo.create(baseMissInput({ host: 'server1', stackProject: 'media', note: 'checked with the operator' }));

      const call = mockPool.queries[0];
      expect(call.params[3]).toBe('server1');
      expect(call.params[4]).toBe('media');
      expect(call.params[8]).toBe('checked with the operator');
    });
  });

  describe('getById', () => {
    it('returns the hydrated miss, coercing the BIGSERIAL id', async () => {
      mockPool.pushResult([buildMissRow({ id: '42' })]);
      const miss = await repo.getById(42);
      expect(miss?.id).toBe(42);
    });

    it('returns null when no row matches', async () => {
      mockPool.pushResult([]);
      expect(await repo.getById(404)).toBeNull();
    });

    it('coerces matched_finding_ids to numbers', async () => {
      mockPool.pushResult([buildMissRow({ matched_finding_ids: ['3', '9'] })]);
      const miss = await repo.getById(1);
      expect(miss?.matchedFindingIds).toEqual([3, 9]);
    });
  });

  describe('list', () => {
    it('lists with only a limit when no filters are given', async () => {
      mockPool.pushResult([buildMissRow()]);
      const misses = await repo.list({ limit: 20 });
      expect(misses).toHaveLength(1);
      const call = mockPool.queries[0];
      expect(call.sql).not.toContain('WHERE');
      expect(call.params).toEqual([20]);
    });

    it('combines every filter with AND, in declaration order, ahead of the limit param', async () => {
      mockPool.pushResult([]);
      const windowFrom = new Date('2026-08-01T00:00:00.000Z');
      const windowTo = new Date('2026-08-17T00:00:00.000Z');
      await repo.list({ windowFrom, windowTo, entityId: 'server1/abc123', status: 'new', limit: 5 });
      const call = mockPool.queries[0];
      expect(call.sql).toContain('window_from >= $1 AND window_to <= $2 AND $3 = ANY(entity_ids) AND status = $4');
      expect(call.params).toEqual([windowFrom, windowTo, 'server1/abc123', 'new', 5]);
    });
  });

  describe('saveAttribution', () => {
    it('writes the cached attribution and flips new to attributed', async () => {
      mockPool.pushResult([
        buildMissRow({
          status: 'attributed',
          attribution_verdict: 'batched_only',
          attributed_at: new Date('2026-08-17T09:00:00.000Z'),
          matched_finding_ids: [],
          matched_incident_ids: ['inc-e-abc123'],
        }),
      ]);

      const at = new Date('2026-08-17T09:00:00.000Z');
      const miss = await repo.saveAttribution(1, 'batched_only', { shapes: [] }, [], ['inc-e-abc123'], at);

      expect(miss?.status).toBe('attributed');
      expect(miss?.attributionVerdict).toBe('batched_only');
      const call = mockPool.queries[0];
      expect(call.sql).toContain("CASE WHEN status = 'new' THEN 'attributed' ELSE status END");
      expect(call.params).toEqual([1, JSON.stringify({ shapes: [] }), 'batched_only', at, [], ['inc-e-abc123']]);
    });

    it('returns null when the id does not exist', async () => {
      mockPool.pushResult([]);
      const result = await repo.saveAttribution(404, 'nothing_recorded', {}, [], [], new Date());
      expect(result).toBeNull();
    });
  });

  describe('setStatus', () => {
    it('updates status and note', async () => {
      mockPool.pushResult([buildMissRow({ status: 'accepted', note: 'confirmed, this was a real miss' })]);

      const miss = await repo.setStatus(1, 'accepted', 'confirmed, this was a real miss');

      expect(miss?.status).toBe('accepted');
      expect(mockPool.queries[0].params).toEqual([1, 'accepted', 'confirmed, this was a real miss']);
    });

    it('returns null when the id does not exist', async () => {
      mockPool.pushResult([]);
      expect(await repo.setStatus(404, 'invalid', '')).toBeNull();
    });
  });

  describe('countByStatus', () => {
    it('zero-fills every status and coerces the count', async () => {
      mockPool.pushResult([
        { status: 'new', n: '2' },
        { status: 'accepted', n: 1 },
      ]);

      const counts = await repo.countByStatus(new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-17T00:00:00.000Z'));

      expect(counts).toEqual({ new: 2, attributed: 0, accepted: 1, explained: 0, invalid: 0 });
    });
  });

  describe('countByAttributionVerdict', () => {
    it('zero-fills every verdict and coerces the count', async () => {
      mockPool.pushResult([{ attribution_verdict: 'batched_only', n: '4' }]);

      const counts = await repo.countByAttributionVerdict(new Date('2026-08-01T00:00:00.000Z'), new Date('2026-08-17T00:00:00.000Z'));

      expect(counts).toEqual({
        nothing_recorded: 0,
        counted_only: 0,
        batched_only: 4,
        dispatched_no_finding: 0,
        dispatch_dropped: 0,
        finding_exists: 0,
      });
    });
  });
});

function buildIncidentRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inc-e-abc123',
    scope: 'container',
    scope_key: 'entity:server1/abc123',
    host: 'server1',
    stack_project: null,
    primary_entity_id: 'server1/abc123',
    entity_ids: ['server1/abc123'],
    tier: 0,
    lane: 'page',
    state: 'dispatched',
    occurrence: 1,
    signal_count: 3,
    opened_at: new Date('2026-08-16T21:00:00.000Z'),
    first_signal_at: new Date('2026-08-16T21:00:00.000Z'),
    last_signal_at: new Date('2026-08-16T21:02:00.000Z'),
    dispatched_at: new Date('2026-08-16T21:02:30.000Z'),
    dispatch_outcome: 'page-sent',
    dispatch_detail: '',
    latency_ms: 150000,
    deciding_rule_id: 'seed:oom-killed',
    rule_ids: ['seed:oom-killed'],
    shape_ids: ['shape-1'],
    hard_signal: true,
    signals: [],
    merged_from: [],
    finding_ids: ['12'],
    ...overrides,
  };
}

function baseIncidentInput(overrides: Partial<IncidentRecordInput> = {}): IncidentRecordInput {
  return {
    id: 'inc-e-abc123',
    scope: 'container',
    scopeKey: 'entity:server1/abc123',
    host: 'server1',
    stackProject: null,
    primaryEntityId: 'server1/abc123',
    entityIds: ['server1/abc123'],
    tier: 0,
    lane: 'page',
    state: 'dispatched',
    occurrence: 1,
    signalCount: 3,
    openedAt: new Date('2026-08-16T21:00:00.000Z'),
    firstSignalAt: new Date('2026-08-16T21:00:00.000Z'),
    lastSignalAt: new Date('2026-08-16T21:02:00.000Z'),
    dispatchedAt: new Date('2026-08-16T21:02:30.000Z'),
    dispatchOutcome: 'page-sent',
    dispatchDetail: '',
    latencyMs: 150000,
    decidingRuleId: 'seed:oom-killed',
    ruleIds: ['seed:oom-killed'],
    shapeIds: ['shape-1'],
    hardSignal: true,
    signals: [],
    mergedFrom: [],
    ...overrides,
  };
}

describe('IncidentRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: IncidentRepository;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new IncidentRepository(mockPool.pool as never);
  });

  describe('upsert', () => {
    it('inserts with an ON CONFLICT clause that only overwrites dispatch fields when non-null', async () => {
      await repo.upsert(baseIncidentInput());

      const call = mockPool.queries[0];
      expect(call.sql).toContain('ON CONFLICT (id) DO UPDATE SET');
      expect(call.sql).toContain('dispatched_at = COALESCE(EXCLUDED.dispatched_at, incidents.dispatched_at)');
      expect(call.sql).toContain('dispatch_outcome = COALESCE(EXCLUDED.dispatch_outcome, incidents.dispatch_outcome)');
      expect(call.sql).toContain('first_signal_at = LEAST(incidents.first_signal_at, EXCLUDED.first_signal_at)');
      expect(call.params[0]).toBe('inc-e-abc123');
      expect(call.params[16]).toBe('page-sent');
      expect(call.params[23]).toBe(JSON.stringify([]));
    });

    it('serializes null dispatch fields for a not-yet-dispatched incident', async () => {
      await repo.upsert(baseIncidentInput({ state: 'open', dispatchedAt: null, dispatchOutcome: null, latencyMs: null }));

      const call = mockPool.queries[0];
      expect(call.params[15]).toBeNull();
      expect(call.params[16]).toBeNull();
      expect(call.params[18]).toBeNull();
    });
  });

  describe('getById', () => {
    it('hydrates finding_ids with Number coercion', async () => {
      mockPool.pushResult([buildIncidentRow()]);
      const incident = await repo.getById('inc-e-abc123');
      expect(incident?.findingIds).toEqual([12]);
      expect(incident?.delivered).toBe(true);
    });

    it('returns null when no row matches', async () => {
      mockPool.pushResult([]);
      expect(await repo.getById('inc-missing')).toBeNull();
    });

    it('marks an undelivered outcome as not delivered', async () => {
      mockPool.pushResult([buildIncidentRow({ dispatch_outcome: 'budget-exhausted', finding_ids: [] })]);
      const incident = await repo.getById('inc-e-abc123');
      expect(incident?.delivered).toBe(false);
    });
  });

  describe('list', () => {
    it('lists with only a limit when no filters are given', async () => {
      mockPool.pushResult([buildIncidentRow()]);
      const incidents = await repo.list({ limit: 20 });
      expect(incidents).toHaveLength(1);
      const call = mockPool.queries[0];
      expect(call.sql).not.toMatch(/FROM incidents i\s+WHERE/);
      expect(call.params).toEqual([20]);
    });

    it('combines incidentId/entityId/host/stackProject/lane/tier/since/until filters in declaration order', async () => {
      mockPool.pushResult([]);
      const since = new Date('2026-08-01T00:00:00.000Z');
      const until = new Date('2026-08-17T00:00:00.000Z');
      await repo.list({
        incidentId: 'inc-e-abc123',
        entityId: 'server1/abc123',
        host: 'server1',
        stackProject: 'media',
        lane: 'page',
        tier: 0,
        since,
        until,
        limit: 10,
      });
      const call = mockPool.queries[0];
      expect(call.sql).toContain(
        'i.id = $1 AND $2 = ANY(i.entity_ids) AND i.host = $3 AND i.stack_project = $4 AND i.lane = $5 AND i.tier = $6 AND i.first_signal_at >= $7 AND i.first_signal_at <= $8',
      );
      expect(call.params).toEqual(['inc-e-abc123', 'server1/abc123', 'server1', 'media', 'page', 0, since, until, 10]);
    });

    it('filters to delivered outcomes', async () => {
      mockPool.pushResult([]);
      await repo.list({ dispatched: 'delivered', limit: 10 });
      const call = mockPool.queries[0];
      expect(call.sql).toContain('i.dispatch_outcome = ANY($1)');
      expect(call.params[0]).toEqual(['accepted', 'page-sent']);
    });

    it('filters to undelivered outcomes, including a null dispatch_outcome', async () => {
      mockPool.pushResult([]);
      await repo.list({ dispatched: 'undelivered', limit: 10 });
      const call = mockPool.queries[0];
      expect(call.sql).toContain('i.dispatch_outcome IS NULL OR i.dispatch_outcome <> ALL($1)');
      expect(call.params[0]).toEqual(['accepted', 'page-sent']);
    });

    it('does not filter on dispatch outcome for "any"', async () => {
      mockPool.pushResult([]);
      await repo.list({ dispatched: 'any', limit: 10 });
      expect(mockPool.queries[0].sql).not.toContain('i.dispatch_outcome');
    });
  });

  describe('listForWindow', () => {
    it('returns an empty array and issues no query for an empty entity list', async () => {
      const incidents = await repo.listForWindow([], new Date(), new Date());
      expect(incidents).toEqual([]);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('queries by entity overlap and the signal-time window', async () => {
      mockPool.pushResult([buildIncidentRow()]);
      const from = new Date('2026-08-16T20:00:00.000Z');
      const to = new Date('2026-08-16T22:00:00.000Z');
      const incidents = await repo.listForWindow(['server1/abc123'], from, to);
      expect(incidents).toHaveLength(1);
      const call = mockPool.queries[0];
      expect(call.sql).toContain('i.entity_ids && $1 AND i.last_signal_at >= $2 AND i.first_signal_at <= $3');
      expect(call.params).toEqual([['server1/abc123'], from, to]);
    });
  });

  describe('tierZeroLatencies', () => {
    it('collects dispatched latencies and buckets never-dispatched incidents by outcome', async () => {
      mockPool.pushResult([{ latency_ms: '1200' }, { latency_ms: 900 }]);
      mockPool.pushResult([
        { dispatch_outcome: 'budget-exhausted', n: '2' },
        { dispatch_outcome: null, n: '1' },
      ]);

      const result = await repo.tierZeroLatencies(new Date('2026-08-16T00:00:00.000Z'), new Date('2026-08-17T00:00:00.000Z'));

      expect(result.latencies).toEqual([1200, 900]);
      expect(result.neverDispatched).toEqual({ 'budget-exhausted': 2, none: 1 });
      expect(mockPool.queries[0].sql).toContain('dispatched_at IS NOT NULL');
      expect(mockPool.queries[1].sql).toContain('dispatched_at IS NULL');
    });
  });

  describe('prune', () => {
    it('deletes incidents older than the cutoff and reports the row count', async () => {
      mockPool.pushResult([{}, {}, {}]);
      const count = await repo.prune(new Date('2026-02-01T00:00:00.000Z'));
      expect(count).toBe(3);
      expect(mockPool.queries[0].sql).toContain('DELETE FROM incidents WHERE first_signal_at < $1');
    });
  });
});

function findingRow(overrides: Partial<AttributionFindingRow> = {}): AttributionFindingRow {
  return {
    id: 12,
    fingerprint: 'jellyfin-transcode-stall',
    severity: 'warning',
    status: 'open',
    title: 'Jellyfin transcode stalled',
    firstSeenAt: new Date('2026-08-16T21:05:00.000Z'),
    lastSeenAt: new Date('2026-08-16T21:10:00.000Z'),
    incidentIds: ['inc-e-abc123'],
    runId: 'run-1',
    currentVerdict: null,
    ...overrides,
  };
}

function incidentRow(overrides: Partial<AttributionIncidentRow> = {}): AttributionIncidentRow {
  return {
    id: 'inc-e-abc123',
    lane: 'triage',
    tier: 1,
    state: 'dispatched',
    signalCount: 2,
    firstSignalAt: new Date('2026-08-16T21:00:00.000Z'),
    lastSignalAt: new Date('2026-08-16T21:02:00.000Z'),
    dispatchedAt: new Date('2026-08-16T21:02:30.000Z'),
    dispatchOutcome: 'accepted',
    latencyMs: 150000,
    decidingRuleId: 'seed:level-warn',
    ruleIds: ['seed:level-warn'],
    shapeIds: ['shape-1'],
    signals: [],
    ...overrides,
  };
}

function shapeRow(overrides: Partial<AttributionShapeRow> = {}): AttributionShapeRow {
  return {
    entityId: 'server1/abc123',
    shapeId: 'shape-1',
    template: 'transcode chatter <NUM>',
    laneAtTheTime: 'count',
    lines: 42,
    firstBucket: new Date('2026-08-16T21:00:00.000Z'),
    lastBucket: new Date('2026-08-16T21:59:00.000Z'),
    exemplars: [],
    routedLane: 'count',
    routedFromLane: null,
    laneSource: 'default',
    decidedAt: null,
    ruleId: null,
    ruleName: null,
    ruleState: null,
    ruleOrigin: null,
    ruleRationale: null,
    proposedByRunId: null,
    operatorApproved: null,
    demotedAt: null,
    demotionDirection: null,
    demotionRationale: null,
    demotionActor: null,
    ...overrides,
  };
}

describe('classifyAttribution', () => {
  it('returns finding_exists when any finding overlaps the padded window, regardless of incidents or shapes', () => {
    const verdict = classifyAttribution({ findings: [findingRow()], incidents: [incidentRow()], shapes: [shapeRow()] });
    expect(verdict).toBe('finding_exists');
  });

  it('returns dispatch_dropped when an incident fired but was never delivered', () => {
    const verdict = classifyAttribution({
      findings: [],
      incidents: [incidentRow({ dispatchOutcome: 'budget-exhausted' })],
      shapes: [],
    });
    expect(verdict).toBe('dispatch_dropped');
  });

  it('returns dispatched_no_finding when the incident delivered but nothing was found', () => {
    const verdict = classifyAttribution({
      findings: [],
      incidents: [incidentRow({ dispatchOutcome: 'accepted' })],
      shapes: [],
    });
    expect(verdict).toBe('dispatched_no_finding');
  });

  it('returns batched_only when the highest lane observed is batch, with no incident', () => {
    const verdict = classifyAttribution({
      findings: [],
      incidents: [],
      shapes: [shapeRow({ laneAtTheTime: 'count' }), shapeRow({ shapeId: 'shape-2', laneAtTheTime: 'batch' })],
    });
    expect(verdict).toBe('batched_only');
  });

  it('returns counted_only when every shape stayed in the count lane', () => {
    const verdict = classifyAttribution({
      findings: [],
      incidents: [],
      shapes: [shapeRow({ laneAtTheTime: 'count' })],
    });
    expect(verdict).toBe('counted_only');
  });

  it('folds a triage/page lane with no incident row into batched_only rather than discarding it', () => {
    const verdict = classifyAttribution({
      findings: [],
      incidents: [],
      shapes: [shapeRow({ laneAtTheTime: 'triage' })],
    });
    expect(verdict).toBe('batched_only');
  });

  it('returns nothing_recorded when there is genuinely no signal for the window', () => {
    const verdict = classifyAttribution({ findings: [], incidents: [], shapes: [] });
    expect(verdict).toBe('nothing_recorded');
  });

  it('does not count a finding an operator marked wrong as coverage of the window', () => {
    const verdict = classifyAttribution({
      findings: [findingRow({ currentVerdict: 'wrong' })],
      incidents: [],
      shapes: [shapeRow({ laneAtTheTime: 'batch' })],
    });
    expect(verdict).toBe('batched_only');
  });

  it('still counts finding_exists when a wrong finding overlaps alongside a genuine one', () => {
    const verdict = classifyAttribution({
      findings: [findingRow({ id: 1, currentVerdict: 'wrong' }), findingRow({ id: 2, currentVerdict: 'actionable' })],
      incidents: [],
      shapes: [],
    });
    expect(verdict).toBe('finding_exists');
  });

  it('classifies cooldown and duplicate dispatch outcomes as dropped, not silently as nothing_recorded', () => {
    expect(classifyAttribution({ findings: [], incidents: [incidentRow({ dispatchOutcome: 'cooldown' })], shapes: [] })).toBe('dispatch_dropped');
    expect(classifyAttribution({ findings: [], incidents: [incidentRow({ dispatchOutcome: 'duplicate' })], shapes: [] })).toBe('dispatch_dropped');
    expect(classifyAttribution({ findings: [], incidents: [incidentRow({ dispatchOutcome: 'rejected' })], shapes: [] })).toBe('dispatch_dropped');
  });

  it('does not let a duplicate/rate-limited incident with no findings mask as dispatched_no_finding', () => {
    const verdict = classifyAttribution({
      findings: [],
      incidents: [incidentRow({ dispatchOutcome: 'rate-limited' })],
      shapes: [shapeRow({ laneAtTheTime: 'batch' })],
    });
    expect(verdict).toBe('dispatch_dropped');
  });
});

describe('attributeMiss', () => {
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockPool = createMockPool();
  });

  const windowFrom = new Date('2026-08-16T21:00:00.000Z');
  const windowTo = new Date('2026-08-16T22:00:00.000Z');
  const entityIds = ['server1/abc123'];

  it('classifies nothing_recorded with no surrounding traffic when all four reads come back empty', async () => {
    mockPool.pushResult([]); // findings
    mockPool.pushResult([]); // incidents
    mockPool.pushResult([]); // shapes
    mockPool.pushResult([]); // traffic check

    const attribution = await attributeMiss(mockPool.pool as never, { windowFrom, windowTo, entityIds });

    expect(attribution.verdict).toBe('nothing_recorded');
    expect(attribution.findings).toEqual([]);
    expect(attribution.incidents).toEqual([]);
    expect(attribution.shapes).toEqual([]);
    expect(attribution.entityHadTraffic).toBe(false);
    expect(attribution.windowFrom).toBe(windowFrom);
    expect(attribution.windowTo).toBe(windowTo);
    expect(mockPool.queries).toHaveLength(4);
  });

  it('distinguishes nothing_recorded with surrounding traffic (watcher ran, entity was quiet) from a dark window', async () => {
    mockPool.pushResult([]); // findings
    mockPool.pushResult([]); // incidents
    mockPool.pushResult([]); // shapes in the exact window
    mockPool.pushResult([{ '?column?': 1 }]); // traffic in the +/-24h pad

    const attribution = await attributeMiss(mockPool.pool as never, { windowFrom, windowTo, entityIds });

    expect(attribution.verdict).toBe('nothing_recorded');
    expect(attribution.entityHadTraffic).toBe(true);
  });

  it('hydrates a finding_exists window end to end, including the current verdict join', async () => {
    mockPool.pushResult([
      {
        id: '12',
        fingerprint: 'jellyfin-transcode-stall',
        severity: 'warning',
        status: 'open',
        title: 'Jellyfin transcode stalled',
        first_seen_at: new Date('2026-08-16T21:05:00.000Z'),
        last_seen_at: new Date('2026-08-16T21:10:00.000Z'),
        incident_ids: ['inc-e-abc123'],
        run_id: 'run-1',
        current_verdict: 'actionable',
      },
    ]);
    mockPool.pushResult([]);
    mockPool.pushResult([]);
    mockPool.pushResult([]);

    const attribution = await attributeMiss(mockPool.pool as never, { windowFrom, windowTo, entityIds });

    expect(attribution.verdict).toBe('finding_exists');
    expect(attribution.findings[0].id).toBe(12);
    expect(attribution.findings[0].currentVerdict).toBe('actionable');
    const findingsCall = mockPool.queries[0];
    expect(findingsCall.sql).toContain("INTERVAL '15 minutes'");
    expect(findingsCall.params).toEqual([windowFrom, windowTo, entityIds]);
  });

  it('hydrates shapes with lane/rule/demotion detail for a batched_only window', async () => {
    mockPool.pushResult([]); // findings
    mockPool.pushResult([]); // incidents
    mockPool.pushResult([
      {
        entity_id: 'server1/abc123',
        shape_id: 'shape-1',
        template: 'transcode chatter <NUM>',
        lane_at_the_time: 'batch',
        lines: '1204',
        first_bucket: new Date('2026-08-16T21:00:00.000Z'),
        last_bucket: new Date('2026-08-16T21:59:00.000Z'),
        exemplars: [{ line: 'ffmpeg chatter' }],
        routed_lane: 'batch',
        routed_from_lane: 'triage',
        lane_source: 'agent:jellyfin-ffmpeg-chatter',
        decided_at: new Date('2026-08-02T00:00:00.000Z'),
        rule_id: 'agent:jellyfin-ffmpeg-chatter',
        rule_name: 'Routine transcoder chatter',
        rule_state: 'active',
        rule_origin: 'agent',
        rule_rationale: 'routine transcoder chatter on every stream start',
        proposed_by_run_id: 'run-9',
        operator_approved: true,
        demoted_at: new Date('2026-08-02T00:00:00.000Z'),
        demotion_direction: 'demotion',
        demotion_rationale: 'routine transcoder chatter on every stream start',
        demotion_actor: 'agent',
      },
    ]);
    mockPool.pushResult([]); // traffic

    const attribution = await attributeMiss(mockPool.pool as never, { windowFrom, windowTo, entityIds });

    expect(attribution.verdict).toBe('batched_only');
    expect(attribution.shapes[0].lines).toBe(1204);
    expect(attribution.shapes[0].ruleRationale).toBe('routine transcoder chatter on every stream start');
    const shapesCall = mockPool.queries[2];
    expect(shapesCall.sql).toContain('shapes_in_window');
    expect(shapesCall.sql).toContain('lane_in_force');
    expect(shapesCall.params).toEqual([windowFrom, windowTo, entityIds]);
  });

  it('hydrates incidents including a dropped dispatch outcome', async () => {
    mockPool.pushResult([]); // findings
    mockPool.pushResult([
      {
        id: 'inc-e-abc123',
        lane: 'triage',
        tier: 1,
        state: 'closed',
        signal_count: 2,
        first_signal_at: new Date('2026-08-16T21:00:00.000Z'),
        last_signal_at: new Date('2026-08-16T21:02:00.000Z'),
        dispatched_at: null,
        dispatch_outcome: 'circuit-open',
        latency_ms: null,
        deciding_rule_id: 'seed:level-warn',
        rule_ids: ['seed:level-warn'],
        shape_ids: ['shape-1'],
        signals: [],
      },
    ]);
    mockPool.pushResult([]); // shapes
    mockPool.pushResult([]); // traffic

    const attribution = await attributeMiss(mockPool.pool as never, { windowFrom, windowTo, entityIds });

    expect(attribution.verdict).toBe('dispatch_dropped');
    expect(attribution.incidents[0].dispatchOutcome).toBe('circuit-open');
    expect(attribution.incidents[0].latencyMs).toBeNull();
  });
});
