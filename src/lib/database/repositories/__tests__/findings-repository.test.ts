import { describe, it, expect, beforeEach, mock } from 'bun:test';

let capEvidenceImpl = (items: readonly { kind?: string; at: string | null; source?: string; text: string }[]) => ({
  evidence: items.map((item) => ({
    kind: item.kind ?? 'log_line',
    at: item.at ? new Date(item.at) : null,
    source: item.source ?? '',
    text: item.text,
    truncated: false,
  })),
  dropped: 0,
  truncated: 0,
});

mock.module('@/lib/findings/types', () => ({
  MAX_TITLE_CHARS: 200,
  MAX_DETAIL_CHARS: 4000,
  MAX_RESOLUTION_CHARS: 1000,
  sanitizeSingleLine: (raw: string, maxChars: number) => {
    const text = raw.replace(/[\r\n\t]/g, ' ').slice(0, maxChars);
    return { text, truncated: raw.length > maxChars };
  },
  sanitizeBlock: (raw: string, maxChars: number) => {
    const text = raw.slice(0, maxChars);
    return { text, truncated: raw.length > maxChars };
  },
  capEvidence: (items: readonly { kind?: string; at: string | null; source?: string; text: string }[]) =>
    capEvidenceImpl(items),
}));

const { FindingsRepository } = await import('@/lib/database/repositories/findings-repository');
const { createMockPool } = await import('@/lib/test/mock-pool');

function buildRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '7',
    subject_kind: 'container',
    subject_id: 'server1/abc123',
    entity_ids: ['server1/abc123'],
    fingerprint: 'postgres-connection-refused',
    severity: 'critical',
    status: 'open',
    title: 'Postgres connection refused',
    detail: 'Connection refused on port 5432',
    evidence: [{ kind: 'log_line', at: '2026-08-16T12:00:00.000Z', source: 'stderr', text: 'FATAL: connection refused', truncated: false }],
    incident_ids: ['inc-e-abc123'],
    run_id: 'run-1',
    source: 'agent',
    occurrences: 1,
    window_from: new Date('2026-08-16T11:00:00.000Z'),
    window_to: new Date('2026-08-16T12:00:00.000Z'),
    first_seen_at: new Date('2026-08-16T12:00:00.000Z'),
    last_seen_at: new Date('2026-08-16T12:00:00.000Z'),
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

const baseRecordInput = {
  subjectKind: 'container' as const,
  subjectId: 'server1/abc123',
  entityIds: ['server1/abc123'],
  fingerprint: 'postgres-connection-refused',
  severity: 'critical' as const,
  title: 'Postgres connection refused',
  detail: 'Connection refused on port 5432',
  evidence: [{ kind: 'log_line' as const, at: '2026-08-16T12:00:00.000Z', source: 'stderr', text: 'FATAL: connection refused' }],
  incidentId: 'inc-e-abc123',
  runId: 'run-1',
  source: 'agent' as const,
  windowFrom: new Date('2026-08-16T11:00:00.000Z'),
  windowTo: new Date('2026-08-16T12:00:00.000Z'),
  at: new Date('2026-08-16T12:00:00.000Z'),
};

describe('FindingsRepository', () => {
  let repo: InstanceType<typeof FindingsRepository>;
  let mockPool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new FindingsRepository(mockPool.pool as never);
    capEvidenceImpl = (items) => ({
      evidence: items.map((item) => ({
        kind: item.kind ?? 'log_line',
        at: item.at ? new Date(item.at) : null,
        source: item.source ?? '',
        text: item.text,
        truncated: false,
      })),
      dropped: 0,
      truncated: 0,
    });
  });

  describe('record', () => {
    it('inserts a new finding with a fresh id and returns created: true', async () => {
      mockPool.pushResult([buildRow({ created: true })]);

      const result = await repo.record(baseRecordInput);

      expect(result.created).toBe(true);
      expect(result.finding.id).toBe(7);
      expect(result.finding.occurrences).toBe(1);
      expect(result.evidenceDropped).toBe(0);
      expect(result.evidenceTruncated).toBe(0);
      expect(result.detailTruncated).toBe(false);

      const call = mockPool.queries[0];
      expect(call.sql).toContain('INSERT INTO findings');
      expect(call.sql).toContain('ON CONFLICT (subject_kind, subject_id, fingerprint) WHERE status = \'open\'');
      expect(call.sql).toContain("occurrences = findings.occurrences + 1");
      expect(call.params).toEqual([
        'container',
        'server1/abc123',
        ['server1/abc123'],
        'postgres-connection-refused',
        'critical',
        'Postgres connection refused',
        'Connection refused on port 5432',
        JSON.stringify([
          { kind: 'log_line', at: new Date('2026-08-16T12:00:00.000Z'), source: 'stderr', text: 'FATAL: connection refused', truncated: false },
        ]),
        ['inc-e-abc123'],
        'run-1',
        'agent',
        baseRecordInput.windowFrom,
        baseRecordInput.windowTo,
        baseRecordInput.at,
      ]);
    });

    it('hits the dedupe conflict path and surfaces created: false with bumped occurrences', async () => {
      mockPool.pushResult([buildRow({ created: false, occurrences: 4 })]);

      const result = await repo.record(baseRecordInput);

      expect(result.created).toBe(false);
      expect(result.finding.occurrences).toBe(4);
    });

    it('stores an empty incident_ids array when no incidentId is given', async () => {
      mockPool.pushResult([buildRow({ created: true })]);

      await repo.record({ ...baseRecordInput, incidentId: null });

      expect(mockPool.queries[0].params[8]).toEqual([]);
    });

    it('stores null for runId, windowFrom and windowTo when absent', async () => {
      mockPool.pushResult([buildRow({ created: true })]);

      await repo.record({ ...baseRecordInput, runId: null, windowFrom: null, windowTo: null });

      const params = mockPool.queries[0].params;
      expect(params[9]).toBeNull();
      expect(params[11]).toBeNull();
      expect(params[12]).toBeNull();
    });

    it('dedupes and sorts entityIds before inserting', async () => {
      mockPool.pushResult([buildRow({ created: true })]);

      await repo.record({ ...baseRecordInput, entityIds: ['server1/z', 'server1/a', 'server1/a'] });

      expect(mockPool.queries[0].params[2]).toEqual(['server1/a', 'server1/z']);
    });

    it('sanitizes the title on a code point that would exceed the cap', async () => {
      mockPool.pushResult([buildRow({ created: true })]);

      await repo.record({ ...baseRecordInput, title: 'line one\nline two' });

      expect(mockPool.queries[0].params[5]).toBe('line one line two');
    });

    it('surfaces detailTruncated and evidence caps reported by capEvidence', async () => {
      capEvidenceImpl = () => ({
        evidence: [{ kind: 'log_line' as const, at: null, source: '', text: 'kept', truncated: true }],
        dropped: 2,
        truncated: 1,
      });
      mockPool.pushResult([buildRow({ created: true })]);

      const result = await repo.record({ ...baseRecordInput, detail: 'x'.repeat(5000) });

      expect(result.detailTruncated).toBe(true);
      expect(result.evidenceDropped).toBe(2);
      expect(result.evidenceTruncated).toBe(1);
    });
  });

  describe('getById', () => {
    it('returns the finding, coercing BIGINT id and occurrences with Number()', async () => {
      mockPool.pushResult([buildRow({ id: '99', occurrences: '3' })]);

      const finding = await repo.getById(99);

      expect(finding?.id).toBe(99);
      expect(finding?.occurrences).toBe(3);
      expect(mockPool.queries[0].sql).toContain('SELECT * FROM findings WHERE id = $1');
      expect(mockPool.queries[0].params).toEqual([99]);
    });

    it('returns null when no row matches', async () => {
      mockPool.pushResult([]);

      const finding = await repo.getById(404);

      expect(finding).toBeNull();
    });

    it('drops malformed evidence items and revives well-formed ones', async () => {
      mockPool.pushResult([
        buildRow({
          evidence: [
            { kind: 'log_line', at: null, source: 'stderr', text: 'ok', truncated: false },
            { kind: 'log_line', text: 'missing fields' },
            'not an object',
            null,
          ],
        }),
      ]);

      const finding = await repo.getById(7);

      expect(finding?.evidence).toHaveLength(1);
      expect(finding?.evidence[0]).toEqual({ kind: 'log_line', at: null, source: 'stderr', text: 'ok', truncated: false });
    });

    it('treats a non-array evidence column as empty', async () => {
      mockPool.pushResult([buildRow({ evidence: null })]);

      const finding = await repo.getById(7);

      expect(finding?.evidence).toEqual([]);
    });
  });

  describe('list', () => {
    it('lists with only a limit when no filters are given', async () => {
      mockPool.pushResult([buildRow()]);

      const findings = await repo.list({ limit: 20 });

      expect(findings).toHaveLength(1);
      const call = mockPool.queries[0];
      expect(call.sql).not.toContain('WHERE');
      expect(call.sql).toContain('ORDER BY last_seen_at DESC LIMIT $1');
      expect(call.params).toEqual([20]);
    });

    it('filters by subjectId', async () => {
      mockPool.pushResult([]);
      await repo.list({ subjectId: 'server1/abc123', limit: 10 });
      const call = mockPool.queries[0];
      expect(call.sql).toContain('subject_id = $1');
      expect(call.params).toEqual(['server1/abc123', 10]);
    });

    it('filters by entityId against entity_ids', async () => {
      mockPool.pushResult([]);
      await repo.list({ entityId: 'server1/abc123', limit: 10 });
      const call = mockPool.queries[0];
      expect(call.sql).toContain('$1 = ANY(entity_ids)');
      expect(call.params).toEqual(['server1/abc123', 10]);
    });

    it('filters by fingerprint', async () => {
      mockPool.pushResult([]);
      await repo.list({ fingerprint: 'postgres-connection-refused', limit: 10 });
      expect(mockPool.queries[0].sql).toContain('fingerprint = $1');
    });

    it('filters by an explicit status', async () => {
      mockPool.pushResult([]);
      await repo.list({ status: 'resolved', limit: 10 });
      const call = mockPool.queries[0];
      expect(call.sql).toContain('status = $1');
      expect(call.params).toEqual(['resolved', 10]);
    });

    it('omits the status filter when status is "any"', async () => {
      mockPool.pushResult([]);
      await repo.list({ status: 'any', limit: 10 });
      expect(mockPool.queries[0].sql).not.toContain('status =');
    });

    it('filters by severity', async () => {
      mockPool.pushResult([]);
      await repo.list({ severity: 'warning', limit: 10 });
      expect(mockPool.queries[0].sql).toContain('severity = $1');
    });

    it('filters by since and until against last_seen_at', async () => {
      mockPool.pushResult([]);
      const since = new Date('2026-08-01T00:00:00.000Z');
      const until = new Date('2026-08-16T00:00:00.000Z');
      await repo.list({ since, until, limit: 10 });
      const call = mockPool.queries[0];
      expect(call.sql).toContain('last_seen_at >= $1');
      expect(call.sql).toContain('last_seen_at <= $2');
      expect(call.params).toEqual([since, until, 10]);
    });

    it('combines every filter with AND, in declaration order, ahead of the limit param', async () => {
      mockPool.pushResult([]);
      const since = new Date('2026-08-01T00:00:00.000Z');
      const until = new Date('2026-08-16T00:00:00.000Z');
      await repo.list({
        subjectId: 'server1/abc123',
        entityId: 'server1/abc123',
        fingerprint: 'postgres-connection-refused',
        status: 'open',
        severity: 'critical',
        since,
        until,
        limit: 5,
      });
      const call = mockPool.queries[0];
      expect(call.sql).toContain(
        'subject_id = $1 AND $2 = ANY(entity_ids) AND fingerprint = $3 AND status = $4 AND severity = $5 AND last_seen_at >= $6 AND last_seen_at <= $7',
      );
      expect(call.params).toEqual([
        'server1/abc123',
        'server1/abc123',
        'postgres-connection-refused',
        'open',
        'critical',
        since,
        until,
        5,
      ]);
    });
  });

  describe('listRecent', () => {
    it('orders open findings before closed ones, then by last_seen_at', async () => {
      mockPool.pushResult([buildRow()]);

      const findings = await repo.listRecent(100);

      expect(findings).toHaveLength(1);
      const call = mockPool.queries[0];
      expect(call.sql).toContain(`ORDER BY (status = 'open') DESC, last_seen_at DESC LIMIT $1`);
      expect(call.params).toEqual([100]);
    });
  });

  describe('resolve', () => {
    it('closes an open finding and returns alreadyClosed: false', async () => {
      mockPool.pushResult([
        buildRow({ status: 'resolved', resolution: 'Rolled back the deploy', resolved_at: new Date('2026-08-16T13:00:00.000Z') }),
      ]);

      const result = await repo.resolve({
        id: 7,
        status: 'resolved',
        resolution: 'Rolled back the deploy',
        at: new Date('2026-08-16T13:00:00.000Z'),
      });

      expect(result?.alreadyClosed).toBe(false);
      expect(result?.finding.status).toBe('resolved');
      expect(result?.finding.resolution).toBe('Rolled back the deploy');
      const call = mockPool.queries[0];
      expect(call.sql).toContain("WHERE id = $1 AND status = 'open'");
      expect(call.params).toEqual([7, 'resolved', 'Rolled back the deploy', new Date('2026-08-16T13:00:00.000Z')]);
    });

    it('dismisses an open finding', async () => {
      mockPool.pushResult([buildRow({ status: 'dismissed', resolution: 'False positive', resolved_at: new Date() })]);

      const result = await repo.resolve({ id: 7, status: 'dismissed', resolution: 'False positive', at: new Date() });

      expect(result?.finding.status).toBe('dismissed');
    });

    it('returns the unchanged finding with alreadyClosed: true when it was already closed', async () => {
      mockPool.pushResult([]);
      mockPool.pushResult([buildRow({ status: 'resolved', resolution: 'First resolution', resolved_at: new Date('2026-08-16T12:30:00.000Z') })]);

      const result = await repo.resolve({ id: 7, status: 'dismissed', resolution: 'Second attempt', at: new Date() });

      expect(result?.alreadyClosed).toBe(true);
      expect(result?.finding.resolution).toBe('First resolution');
      expect(result?.finding.status).toBe('resolved');
    });

    it('returns null when the id does not exist', async () => {
      mockPool.pushResult([]);
      mockPool.pushResult([]);

      const result = await repo.resolve({ id: 404, status: 'resolved', resolution: 'n/a', at: new Date() });

      expect(result).toBeNull();
    });
  });
});
