import { describe, it, expect, beforeEach } from 'bun:test';
import { FindingLabelRepository, type InsertLabelInput } from '../finding-label-repository';
import { createMockPool } from '@/lib/test/mock-pool';

function buildLabelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '5',
    finding_id: '7',
    verdict: 'actionable',
    source: 'operator',
    weight: 1,
    signal: null,
    basis_at: null,
    confounders: [],
    evidence: [],
    duplicate_of_finding_id: null,
    note: '',
    labeled_by: 'jared@glaserfamily.net',
    labeled_at: new Date('2026-08-16T12:00:00.000Z'),
    supersedes_label_id: null,
    ...overrides,
  };
}

function baseInsertInput(overrides: Partial<InsertLabelInput> = {}): InsertLabelInput {
  return {
    findingId: 7,
    verdict: 'actionable',
    source: 'operator',
    weight: 1,
    labeledBy: 'jared@glaserfamily.net',
    ...overrides,
  };
}

describe('FindingLabelRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: FindingLabelRepository;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new FindingLabelRepository(mockPool.pool as never);
  });

  describe('insert', () => {
    it('inserts an operator label with defaulted optional fields', async () => {
      mockPool.pushResult([buildLabelRow()]);

      const label = await repo.insert(baseInsertInput());

      expect(label.id).toBe(5);
      expect(label.findingId).toBe(7);
      expect(label.verdict).toBe('actionable');
      expect(label.weight).toBe(1);

      const call = mockPool.queries[0];
      expect(call.sql).toContain('INSERT INTO finding_labels');
      expect(call.params).toEqual([
        7,
        'actionable',
        'operator',
        1,
        null, // signal
        null, // basisAt
        [], // confounders
        JSON.stringify([]), // evidence
        null, // duplicateOfFindingId
        '', // note
        'jared@glaserfamily.net',
        null, // supersedesLabelId
        null, // at (COALESCE'd to NOW() in SQL)
      ]);
    });

    it('inserts an implicit label carrying signal, basisAt, confounders and evidence', async () => {
      mockPool.pushResult([
        buildLabelRow({
          source: 'implicit',
          verdict: 'noise',
          weight: 0.15,
          signal: 'quiet_24h',
          basis_at: new Date('2026-08-16T00:00:00.000Z'),
          confounders: ['slow_burn_candidate'],
          evidence: [{ kind: 'absence', at: null, ref: 'server1/abc', detail: 'no restart in 24h' }],
        }),
      ]);

      await repo.insert({
        findingId: 7,
        verdict: 'noise',
        source: 'implicit',
        weight: 0.15,
        signal: 'quiet_24h',
        basisAt: new Date('2026-08-16T00:00:00.000Z'),
        confounders: ['slow_burn_candidate'],
        evidence: [{ kind: 'absence', at: null, ref: 'server1/abc', detail: 'no restart in 24h' }],
        labeledBy: null,
      });

      const call = mockPool.queries[0];
      expect(call.params[4]).toBe('quiet_24h');
      expect(call.params[5]).toEqual(new Date('2026-08-16T00:00:00.000Z'));
      expect(call.params[6]).toEqual(['slow_burn_candidate']);
      expect(call.params[7]).toBe(JSON.stringify([{ kind: 'absence', at: null, ref: 'server1/abc', detail: 'no restart in 24h' }]));
      expect(call.params[10]).toBeNull();
    });

    it('records a relabel by threading supersedesLabelId and an explicit at', async () => {
      mockPool.pushResult([buildLabelRow({ id: '9', supersedes_label_id: '5', verdict: 'noise' })]);

      const label = await repo.insert({
        findingId: 7,
        verdict: 'noise',
        source: 'operator',
        weight: 1,
        labeledBy: 'jared@glaserfamily.net',
        supersedesLabelId: 5,
        note: 'reversed after the outage',
        at: new Date('2026-08-17T09:00:00.000Z'),
      });

      expect(label.id).toBe(9);
      expect(label.supersedesLabelId).toBe(5);
      const call = mockPool.queries[0];
      expect(call.params[9]).toBe('reversed after the outage');
      expect(call.params[11]).toBe(5);
      expect(call.params[12]).toEqual(new Date('2026-08-17T09:00:00.000Z'));
    });
  });

  describe('insertMany', () => {
    it('returns 0 and issues no query for an empty batch', async () => {
      const count = await repo.insertMany([]);
      expect(count).toBe(0);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('builds one multi-row VALUES insert with ON CONFLICT DO NOTHING against the implicit unique index', async () => {
      mockPool.pushResult([{ id: '1' }, { id: '2' }]);

      const count = await repo.insertMany([
        { findingId: 1, verdict: 'actionable', source: 'implicit', weight: 0.25, signal: 'restart_after', basisAt: new Date('2026-08-16T00:00:00.000Z'), labeledBy: null },
        { findingId: 2, verdict: 'actionable', source: 'implicit', weight: 0.4, signal: 'rollback_after', basisAt: new Date('2026-08-16T00:00:00.000Z'), labeledBy: null },
      ]);

      expect(count).toBe(2);
      const call = mockPool.queries[0];
      expect(call.sql).toContain("ON CONFLICT (finding_id, signal, basis_at) WHERE source = 'implicit' DO NOTHING");
      expect(call.sql.split('COALESCE(').length - 1).toBe(2);
      expect(call.params).toHaveLength(26);
      expect(call.params[0]).toBe(1);
      expect(call.params[13]).toBe(2);
    });

    it('reports fewer rows written than submitted when the unique index rejects a repeat', async () => {
      mockPool.pushResult([{ id: '1' }]);

      const count = await repo.insertMany([
        { findingId: 1, verdict: 'actionable', source: 'implicit', weight: 0.25, signal: 'restart_after', basisAt: new Date('2026-08-16T00:00:00.000Z'), labeledBy: null },
      ]);

      expect(count).toBe(1);
    });
  });

  describe('listForFinding', () => {
    it('defaults to a limit of 100, most recent first', async () => {
      mockPool.pushResult([buildLabelRow()]);

      const labels = await repo.listForFinding(7);

      expect(labels).toHaveLength(1);
      const call = mockPool.queries[0];
      expect(call.sql).toContain('ORDER BY labeled_at DESC, id DESC');
      expect(call.params).toEqual([7, 100]);
    });

    it('honours a custom limit', async () => {
      mockPool.pushResult([]);
      await repo.listForFinding(7, 5);
      expect(mockPool.queries[0].params).toEqual([7, 5]);
    });
  });

  describe('currentForFindings', () => {
    it('returns an empty map and issues no query for an empty id list', async () => {
      const map = await repo.currentForFindings([]);
      expect(map.size).toBe(0);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('maps the joined view+count row and derives relabelCount from explicit_count - 1', async () => {
      mockPool.pushResult([
        {
          finding_id: '7',
          verdict: 'actionable',
          source: 'operator',
          note: 'confirmed after rollback',
          duplicate_of_finding_id: null,
          labeled_by: 'jared@glaserfamily.net',
          labeled_at: new Date('2026-08-17T09:00:00.000Z'),
          explicit_count: '3',
        },
      ]);

      const map = await repo.currentForFindings([7]);

      const summary = map.get(7);
      expect(summary?.verdict).toBe('actionable');
      expect(summary?.source).toBe('operator');
      expect(summary?.relabelCount).toBe(2);
      expect(mockPool.queries[0].params).toEqual([[7]]);
    });

    it('reports a fresh label (explicit_count 1) as zero relabels', async () => {
      mockPool.pushResult([
        {
          finding_id: '7',
          verdict: 'noise',
          source: 'agent',
          note: '',
          duplicate_of_finding_id: null,
          labeled_by: 'run-42',
          labeled_at: new Date('2026-08-16T12:00:00.000Z'),
          explicit_count: '1',
        },
      ]);

      const map = await repo.currentForFindings([7]);

      expect(map.get(7)?.relabelCount).toBe(0);
    });

    it('surfaces a duplicate_of_finding_id as a coerced number', async () => {
      mockPool.pushResult([
        {
          finding_id: '7',
          verdict: 'duplicate',
          source: 'operator',
          note: '',
          duplicate_of_finding_id: '3',
          labeled_by: 'jared@glaserfamily.net',
          labeled_at: new Date('2026-08-16T12:00:00.000Z'),
          explicit_count: '1',
        },
      ]);

      const map = await repo.currentForFindings([7]);

      expect(map.get(7)?.duplicateOfFindingId).toBe(3);
    });
  });

  describe('weakSignalsForFindings', () => {
    it('returns an empty map and issues no query for an empty id list', async () => {
      const map = await repo.weakSignalsForFindings([]);
      expect(map.size).toBe(0);
      expect(mockPool.queries).toHaveLength(0);
    });

    it('defaults null actionable/noise weights to 0 and drops null entries from signals/confounders', async () => {
      mockPool.pushResult([
        {
          finding_id: '7',
          actionable_weight: null,
          noise_weight: '0.15',
          signal_count: '2',
          signals: ['quiet_24h', null],
          confounders: [null, 'slow_burn_candidate'],
          last_inferred_at: new Date('2026-08-17T00:00:00.000Z'),
        },
      ]);

      const map = await repo.weakSignalsForFindings([7]);

      const summary = map.get(7);
      expect(summary?.actionableWeight).toBe(0);
      expect(summary?.noiseWeight).toBe(0.15);
      expect(summary?.signalCount).toBe(2);
      expect(summary?.signals).toEqual(['quiet_24h']);
      expect(summary?.confounders).toEqual(['slow_burn_candidate']);
    });

    it('clamps the weight sum representation as returned by the view (0.5 ceiling lives in SQL)', async () => {
      mockPool.pushResult([
        {
          finding_id: '7',
          actionable_weight: '0.5',
          noise_weight: null,
          signal_count: '4',
          signals: [],
          confounders: [],
          last_inferred_at: new Date('2026-08-17T00:00:00.000Z'),
        },
      ]);

      const map = await repo.weakSignalsForFindings([7]);

      expect(map.get(7)?.actionableWeight).toBe(0.5);
    });
  });

  describe('currentSince', () => {
    it('filters the view by labeled_at range and maps every row', async () => {
      mockPool.pushResult([
        {
          finding_id: '7',
          verdict: 'wrong',
          source: 'operator',
          note: 'misread the container',
          duplicate_of_finding_id: null,
          labeled_by: 'jared@glaserfamily.net',
          labeled_at: new Date('2026-08-16T12:00:00.000Z'),
          explicit_count: '1',
        },
      ]);

      const since = new Date('2026-08-01T00:00:00.000Z');
      const until = new Date('2026-08-17T00:00:00.000Z');
      const summaries = await repo.currentSince(since, until);

      expect(summaries).toHaveLength(1);
      expect(summaries[0].verdict).toBe('wrong');
      const call = mockPool.queries[0];
      expect(call.sql).toContain('c.labeled_at >= $1 AND c.labeled_at < $2');
      expect(call.params).toEqual([since, until]);
    });
  });

  describe('hasOperatorLabel', () => {
    it('returns true when an operator row exists', async () => {
      mockPool.pushResult([{ '?column?': 1 }]);
      expect(await repo.hasOperatorLabel(7)).toBe(true);
      expect(mockPool.queries[0].sql).toContain("source = 'operator'");
    });

    it('returns false when no operator row exists', async () => {
      mockPool.pushResult([]);
      expect(await repo.hasOperatorLabel(7)).toBe(false);
    });
  });

  describe('listImplicitCandidates', () => {
    const input = {
      settledBefore: new Date('2026-08-17T08:00:00.000Z'),
      notOlderThan: new Date('2026-07-18T09:00:00.000Z'),
      quietBefore: new Date('2026-08-16T09:00:00.000Z'),
      limit: 200,
    };

    it('sends settledBefore/notOlderThan/limit as params, in that order', async () => {
      mockPool.pushResult([]);
      await repo.listImplicitCandidates(input);
      expect(mockPool.queries[0].params).toEqual([input.settledBefore, input.notOlderThan, input.limit]);
      expect(mockPool.queries[0].sql).toContain("f.source = 'agent'");
      expect(mockPool.queries[0].sql).toContain('NOT EXISTS');
    });

    it('derives host from a container subjectId and leaves stackProject null', async () => {
      mockPool.pushResult([
        {
          id: '7',
          subject_kind: 'container',
          subject_id: 'server1/abc123',
          entity_ids: ['server1/abc123'],
          severity: 'critical',
          status: 'open',
          title: 'Postgres refusing connections',
          detail: 'connection refused',
          last_seen_at: new Date('2026-08-16T12:00:00.000Z'),
          window_from: null,
          window_to: null,
          evaluated_signals: [],
        },
      ]);

      const [candidate] = await repo.listImplicitCandidates(input);

      expect(candidate.host).toBe('server1');
      expect(candidate.stackProject).toBeNull();
    });

    it('derives host and stackProject from a stack subjectId', async () => {
      mockPool.pushResult([
        {
          id: '8',
          subject_kind: 'stack',
          subject_id: 'server1/media-stack',
          entity_ids: ['server1/abc123'],
          severity: 'warning',
          status: 'open',
          title: 'Stack degraded',
          detail: '',
          last_seen_at: new Date('2026-08-16T12:00:00.000Z'),
          window_from: null,
          window_to: null,
          evaluated_signals: [null, 'no_outcome_observed'],
        },
      ]);

      const [candidate] = await repo.listImplicitCandidates(input);

      expect(candidate.host).toBe('server1');
      expect(candidate.stackProject).toBe('media-stack');
      expect(candidate.evaluatedSignals).toEqual(['no_outcome_observed']);
    });

    it('treats a host-kind subjectId with no slash as the host itself', async () => {
      mockPool.pushResult([
        {
          id: '9',
          subject_kind: 'host',
          subject_id: 'server1',
          entity_ids: ['server1/abc123'],
          severity: 'critical',
          status: 'open',
          title: 'Host under pressure',
          detail: '',
          last_seen_at: new Date('2026-08-16T12:00:00.000Z'),
          window_from: null,
          window_to: null,
          evaluated_signals: null,
        },
      ]);

      const [candidate] = await repo.listImplicitCandidates(input);

      expect(candidate.host).toBe('server1');
      expect(candidate.stackProject).toBeNull();
      expect(candidate.evaluatedSignals).toEqual([]);
    });
  });
});
