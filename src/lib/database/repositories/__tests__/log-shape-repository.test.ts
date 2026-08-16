import { describe, it, expect, beforeEach } from 'bun:test';
import {
  LogShapeRepository,
  MAX_BUCKET_EXEMPLARS,
  MAX_BUCKET_NUMBERS,
  MAX_DIGEST_EXEMPLARS,
  MAX_EXEMPLAR_LINE_CHARS,
  MAX_SHAPE_EXAMPLE_BUCKETS,
  type LogShapeExemplar,
} from '../log-shape-repository';
import { createMockPool } from '@/lib/test/mock-pool';

describe('LogShapeRepository', () => {
  let mockPool: ReturnType<typeof createMockPool>;
  let repo: LogShapeRepository;

  beforeEach(() => {
    mockPool = createMockPool();
    repo = new LogShapeRepository(mockPool.pool);
  });

  describe('recordShapeOccurrence', () => {
    it('upserts log_shapes with the occurrence parameters', async () => {
      const at = new Date('2026-08-15T21:00:00Z');
      await repo.recordShapeOccurrence({
        entityId: 'server1/abc123',
        shapeId: 'deadbeefcafef00d',
        template: 'ffmpeg: stream <N>:<N> dropped <N> frames',
        at,
        count: 1,
        lane: 'batch',
        laneSource: 'seed:level-warn',
      });

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('log_shapes');
      expect(mockPool.queries[0].sql).toContain('ON CONFLICT (entity_id, shape_id)');
      expect(mockPool.queries[0].params).toEqual([
        'server1/abc123',
        'deadbeefcafef00d',
        'ffmpeg: stream <N>:<N> dropped <N> frames',
        at,
        1,
        'batch',
        'seed:level-warn',
      ]);
    });

    it('propagates database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));
      await expect(
        repo.recordShapeOccurrence({
          entityId: 'server1/abc123',
          shapeId: 'deadbeefcafef00d',
          template: 'x',
          at: new Date(),
          count: 1,
          lane: 'count',
          laneSource: 'default',
        }),
      ).rejects.toThrow('connection terminated');
    });
  });

  describe('recordShapeBucket', () => {
    it('upserts log_shape_buckets with serialized exemplars/numbers and the bound params', async () => {
      const bucketStart = new Date('2026-08-15T21:00:00Z');
      const exemplars: LogShapeExemplar[] = [{ at: bucketStart.toISOString(), stream: 'stdout', line: 'hello' }];
      await repo.recordShapeBucket({
        entityId: 'server1/abc123',
        shapeId: 'deadbeefcafef00d',
        bucketStart,
        lane: 'batch',
        count: 5,
        exemplars,
        numbers: [12, 480],
      });

      expect(mockPool.queries).toHaveLength(1);
      expect(mockPool.queries[0].sql).toContain('log_shape_buckets');
      expect(mockPool.queries[0].sql).toContain('ON CONFLICT (entity_id, shape_id, bucket_start)');
      expect(mockPool.queries[0].params).toEqual([
        'server1/abc123',
        'deadbeefcafef00d',
        bucketStart,
        'batch',
        5,
        JSON.stringify(exemplars),
        JSON.stringify([12, 480]),
        MAX_BUCKET_EXEMPLARS,
        MAX_BUCKET_NUMBERS,
      ]);
    });

    it('propagates database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));
      await expect(
        repo.recordShapeBucket({
          entityId: 'server1/abc123',
          shapeId: 'deadbeefcafef00d',
          bucketStart: new Date(),
          lane: 'count',
          count: 1,
          exemplars: [],
          numbers: [],
        }),
      ).rejects.toThrow('connection terminated');
    });

    it('truncates an oversized exemplar line before it reaches the database', async () => {
      const bucketStart = new Date('2026-08-15T21:00:00Z');
      const hugeLine = `FATAL: ${'x'.repeat(3_000_000)}`;
      await repo.recordShapeBucket({
        entityId: 'server1/abc123',
        shapeId: 'deadbeefcafef00d',
        bucketStart,
        lane: 'triage',
        count: 1,
        exemplars: [{ at: bucketStart.toISOString(), stream: 'stderr', line: hugeLine }],
        numbers: [],
      });

      const serializedExemplars = mockPool.queries[0].params[5] as string;
      const stored = JSON.parse(serializedExemplars) as LogShapeExemplar[];
      expect(stored).toHaveLength(1);
      expect(stored[0].line.length).toBe(MAX_EXEMPLAR_LINE_CHARS);
      expect(stored[0].line).toBe(hugeLine.slice(0, MAX_EXEMPLAR_LINE_CHARS));
    });
  });

  describe('setShapeLane', () => {
    it('returns true when a row was updated', async () => {
      mockPool.setDefault([{}]);
      const at = new Date('2026-08-15T21:00:00Z');
      const result = await repo.setShapeLane('server1/abc123', 'deadbeefcafef00d', 'triage', 'agent:run-1', at);

      expect(result).toBe(true);
      expect(mockPool.queries[0].sql).toContain('UPDATE log_shapes');
      expect(mockPool.queries[0].params).toEqual(['server1/abc123', 'deadbeefcafef00d', 'triage', 'agent:run-1', at]);
    });

    it('returns false when the shape has not been seen yet', async () => {
      mockPool.setDefault([]);
      const result = await repo.setShapeLane('server1/abc123', 'unknown', 'triage', 'agent:run-1', new Date());
      expect(result).toBe(false);
    });
  });

  describe('getShape', () => {
    it('maps a found row, wrapping BIGINT total_count with Number()', async () => {
      const firstSeenAt = new Date('2026-08-01T00:00:00Z');
      const lastSeenAt = new Date('2026-08-15T21:00:00Z');
      mockPool.setDefault([
        {
          entity_id: 'server1/abc123',
          shape_id: 'deadbeefcafef00d',
          template: 'ffmpeg: stream <N>:<N> dropped <N> frames',
          first_seen_at: firstSeenAt,
          last_seen_at: lastSeenAt,
          total_count: '198441',
          lane: 'batch',
          lane_source: 'seed:level-warn',
          lane_updated_at: firstSeenAt,
        },
      ]);

      const shape = await repo.getShape('server1/abc123', 'deadbeefcafef00d');

      expect(shape).toEqual({
        entityId: 'server1/abc123',
        shapeId: 'deadbeefcafef00d',
        template: 'ffmpeg: stream <N>:<N> dropped <N> frames',
        firstSeenAt,
        lastSeenAt,
        totalCount: 198441,
        lane: 'batch',
        laneSource: 'seed:level-warn',
        laneUpdatedAt: firstSeenAt,
      });
      expect(typeof shape?.totalCount).toBe('number');
    });

    it('returns null when no row matches', async () => {
      mockPool.setDefault([]);
      const shape = await repo.getShape('server1/abc123', 'unknown');
      expect(shape).toBeNull();
    });
  });

  describe('listShapes', () => {
    it('queries by entity only when no options are given', async () => {
      mockPool.setDefault([]);
      await repo.listShapes('server1/abc123');

      expect(mockPool.queries[0].sql).not.toContain('lane =');
      expect(mockPool.queries[0].sql).not.toContain('LIMIT');
      expect(mockPool.queries[0].params).toEqual(['server1/abc123']);
    });

    it('filters by lane when provided', async () => {
      mockPool.setDefault([]);
      await repo.listShapes('server1/abc123', { lane: 'triage' });

      expect(mockPool.queries[0].sql).toContain('lane = $2');
      expect(mockPool.queries[0].params).toEqual(['server1/abc123', 'triage']);
    });

    it('applies a limit when provided, after the lane filter', async () => {
      mockPool.setDefault([]);
      await repo.listShapes('server1/abc123', { lane: 'triage', limit: 10 });

      expect(mockPool.queries[0].sql).toContain('lane = $2');
      expect(mockPool.queries[0].sql).toContain('LIMIT $3');
      expect(mockPool.queries[0].params).toEqual(['server1/abc123', 'triage', 10]);
    });

    it('maps rows and orders by total_count desc', async () => {
      const seenAt = new Date('2026-08-15T21:00:00Z');
      mockPool.setDefault([
        {
          entity_id: 'server1/abc123',
          shape_id: 'shape1',
          template: 't',
          first_seen_at: seenAt,
          last_seen_at: seenAt,
          total_count: '5',
          lane: 'count',
          lane_source: 'default',
          lane_updated_at: seenAt,
        },
      ]);
      const shapes = await repo.listShapes('server1/abc123');
      expect(shapes).toHaveLength(1);
      expect(shapes[0].totalCount).toBe(5);
    });
  });

  describe('getDigest', () => {
    it('throws when neither entityId nor host is given', async () => {
      await expect(repo.getDigest({ since: new Date(), until: new Date() })).rejects.toThrow(
        'getDigest requires entityId or host',
      );
      expect(mockPool.queries).toHaveLength(0);
    });

    it('filters by exact entity_id when entityId is given', async () => {
      mockPool.setDefault([]);
      const since = new Date('2026-08-14T00:00:00Z');
      const until = new Date('2026-08-15T00:00:00Z');
      await repo.getDigest({ entityId: 'server1/abc123', since, until });

      expect(mockPool.queries[0].sql).toContain('b.entity_id = $3');
      expect(mockPool.queries[0].params).toEqual([since, until, 'server1/abc123', MAX_SHAPE_EXAMPLE_BUCKETS]);
    });

    it('filters by host prefix when host is given', async () => {
      mockPool.setDefault([]);
      const since = new Date('2026-08-14T00:00:00Z');
      const until = new Date('2026-08-15T00:00:00Z');
      await repo.getDigest({ host: 'server1', since, until });

      expect(mockPool.queries[0].sql).toContain('b.entity_id LIKE $3');
      expect(mockPool.queries[0].params).toEqual([since, until, 'server1/%', MAX_SHAPE_EXAMPLE_BUCKETS]);
    });

    it('bounds exemplars/numbers to the most recent MAX_SHAPE_EXAMPLE_BUCKETS per shape, separately from the count total', async () => {
      mockPool.setDefault([]);
      const since = new Date('2026-08-08T00:00:00Z');
      const until = new Date('2026-08-15T00:00:00Z');
      await repo.getDigest({ entityId: 'server1/abc123', since, until });

      const sql = mockPool.queries[0].sql;
      expect(sql).toContain('SUM(b.count)');
      expect(sql).toContain('ROW_NUMBER()');
      expect(sql).toContain('r.rn <= $4');
      expect(mockPool.queries[0].params[3]).toBe(MAX_SHAPE_EXAMPLE_BUCKETS);
    });

    it('maps rows, wraps SUM(count) with Number(), and flattens/bounds exemplars and numbers across buckets', async () => {
      const firstSeen = new Date('2026-08-14T01:00:00Z');
      const lastSeen = new Date('2026-08-14T05:00:00Z');
      const manyExemplars: LogShapeExemplar[] = Array.from({ length: MAX_DIGEST_EXEMPLARS + 3 }, (_, i) => ({
        at: firstSeen.toISOString(),
        stream: 'stdout' as const,
        line: `line-${i}`,
      }));
      mockPool.setDefault([
        {
          entity_id: 'server1/abc123',
          shape_id: 'shape1',
          template: 'ffmpeg: stream <N>:<N> dropped <N> frames',
          lane: 'batch',
          count: '198441',
          first_seen_in_window: firstSeen,
          last_seen_in_window: lastSeen,
          exemplars_by_bucket: [manyExemplars.slice(0, 5), null, manyExemplars.slice(5)],
          numbers_by_bucket: [[12, 480], null, [1, 2, 3]],
        },
      ]);

      const digest = await repo.getDigest({ entityId: 'server1/abc123', since: firstSeen, until: lastSeen });

      expect(digest).toHaveLength(1);
      expect(digest[0]).toEqual({
        entityId: 'server1/abc123',
        shapeId: 'shape1',
        template: 'ffmpeg: stream <N>:<N> dropped <N> frames',
        lane: 'batch',
        count: 198441,
        firstSeenInWindow: firstSeen,
        lastSeenInWindow: lastSeen,
        exemplars: manyExemplars.slice(0, MAX_DIGEST_EXEMPLARS),
        numbers: [12, 480, 1, 2, 3],
      });
      expect(typeof digest[0].count).toBe('number');
    });

    it('propagates database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));
      await expect(repo.getDigest({ entityId: 'server1/abc123', since: new Date(), until: new Date() })).rejects.toThrow(
        'connection terminated',
      );
    });
  });

  describe('getShapeExemplars', () => {
    it('queries recent buckets bounded by MAX_SHAPE_EXAMPLE_BUCKETS and flattens exemplars to the limit', async () => {
      mockPool.setDefault([
        { exemplars: [{ at: 'a', stream: 'stdout', line: 'l1' }] },
        { exemplars: null },
        { exemplars: [{ at: 'b', stream: 'stderr', line: 'l2' }] },
      ]);

      const exemplars = await repo.getShapeExemplars('server1/abc123', 'shape1', 1);

      expect(mockPool.queries[0].sql).toContain('ORDER BY bucket_start DESC');
      expect(mockPool.queries[0].params).toEqual(['server1/abc123', 'shape1', MAX_SHAPE_EXAMPLE_BUCKETS]);
      expect(exemplars).toEqual([{ at: 'a', stream: 'stdout', line: 'l1' }]);
    });

    it('defaults the limit to MAX_DIGEST_EXEMPLARS', async () => {
      mockPool.setDefault([]);
      const exemplars = await repo.getShapeExemplars('server1/abc123', 'shape1');
      expect(exemplars).toEqual([]);
    });

    it('propagates database errors instead of swallowing them', async () => {
      mockPool.setError(new Error('connection terminated'));
      await expect(repo.getShapeExemplars('server1/abc123', 'shape1')).rejects.toThrow('connection terminated');
    });
  });
});
