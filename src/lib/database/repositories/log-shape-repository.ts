import type { Pool } from 'pg';

export type LogLane = 'page' | 'triage' | 'batch' | 'count';
export type LogStream = 'stdout' | 'stderr';

export const MAX_BUCKET_EXEMPLARS = 8;
export const MAX_BUCKET_NUMBERS = 200;
export const MAX_DIGEST_EXEMPLARS = 8;
export const MAX_SHAPE_EXAMPLE_BUCKETS = 100;
export const MAX_EXEMPLAR_LINE_CHARS = 2048;

export interface LogShapeExemplar {
  readonly at: string;
  readonly stream: LogStream;
  readonly line: string;
}

export interface LogShapeRecord {
  readonly entityId: string;
  readonly shapeId: string;
  readonly template: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly totalCount: number;
  readonly lane: LogLane;
  readonly laneSource: string;
  readonly laneUpdatedAt: Date;
}

export interface RecordShapeOccurrenceInput {
  readonly entityId: string;
  readonly shapeId: string;
  readonly template: string;
  readonly at: Date;
  readonly count: number;
  readonly lane: LogLane;
  readonly laneSource: string;
}

export interface RecordShapeBucketInput {
  readonly entityId: string;
  readonly shapeId: string;
  readonly bucketStart: Date;
  readonly lane: LogLane;
  readonly count: number;
  readonly exemplars: readonly LogShapeExemplar[];
  readonly numbers: readonly number[];
}

export interface ListShapesOptions {
  readonly lane?: LogLane;
  readonly limit?: number;
}

export interface GetDigestInput {
  readonly entityId?: string;
  readonly host?: string;
  readonly since: Date;
  readonly until: Date;
}

export interface ShapeDigestEntry {
  readonly entityId: string;
  readonly shapeId: string;
  readonly template: string;
  readonly lane: LogLane;
  readonly count: number;
  readonly firstSeenInWindow: Date;
  readonly lastSeenInWindow: Date;
  readonly exemplars: readonly LogShapeExemplar[];
  readonly numbers: readonly number[];
}

interface LogShapeDbRow {
  entity_id: string;
  shape_id: string;
  template: string;
  first_seen_at: Date;
  last_seen_at: Date;
  total_count: string | number;
  lane: LogLane;
  lane_source: string;
  lane_updated_at: Date;
}

interface DigestDbRow {
  entity_id: string;
  shape_id: string;
  template: string;
  lane: LogLane;
  count: string | number;
  first_seen_in_window: Date;
  last_seen_in_window: Date;
  exemplars_by_bucket: (LogShapeExemplar[] | null)[];
  numbers_by_bucket: (number[] | null)[];
}

function mapShapeRow(row: LogShapeDbRow): LogShapeRecord {
  return {
    entityId: row.entity_id,
    shapeId: row.shape_id,
    template: row.template,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    totalCount: Number(row.total_count),
    lane: row.lane,
    laneSource: row.lane_source,
    laneUpdatedAt: row.lane_updated_at,
  };
}

function boundExemplarLine(exemplar: LogShapeExemplar): LogShapeExemplar {
  return exemplar.line.length > MAX_EXEMPLAR_LINE_CHARS
    ? { ...exemplar, line: exemplar.line.slice(0, MAX_EXEMPLAR_LINE_CHARS) }
    : exemplar;
}

function flattenBounded<T>(buckets: (T[] | null)[], limit: number): T[] {
  const out: T[] = [];
  for (const bucket of buckets) {
    if (!bucket) continue;
    for (const item of bucket) {
      if (out.length >= limit) return out;
      out.push(item);
    }
  }
  return out;
}

export class LogShapeRepository {
  constructor(private readonly pool: Pool) {}

  async recordShapeOccurrence(input: RecordShapeOccurrenceInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO log_shapes
         (entity_id, shape_id, template, first_seen_at, last_seen_at, total_count,
          lane, lane_source, lane_updated_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $4, NOW(), NOW())
       ON CONFLICT (entity_id, shape_id) DO UPDATE SET
         last_seen_at = GREATEST(log_shapes.last_seen_at, EXCLUDED.last_seen_at),
         total_count = log_shapes.total_count + EXCLUDED.total_count,
         lane = EXCLUDED.lane,
         lane_source = EXCLUDED.lane_source,
         lane_updated_at = CASE
           WHEN log_shapes.lane IS DISTINCT FROM EXCLUDED.lane THEN EXCLUDED.lane_updated_at
           ELSE log_shapes.lane_updated_at
         END,
         updated_at = NOW()`,
      [
        input.entityId,
        input.shapeId,
        input.template,
        input.at,
        input.count,
        input.lane,
        input.laneSource,
      ],
    );
  }

  async recordShapeBucket(input: RecordShapeBucketInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO log_shape_buckets
         (entity_id, shape_id, bucket_start, lane, count, exemplars, numbers, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, NOW(), NOW())
       ON CONFLICT (entity_id, shape_id, bucket_start) DO UPDATE SET
         lane = EXCLUDED.lane,
         count = log_shape_buckets.count + EXCLUDED.count,
         exemplars = (
           SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
           FROM (
             SELECT elem
             FROM jsonb_array_elements(log_shape_buckets.exemplars || EXCLUDED.exemplars) AS elem
             LIMIT $8
           ) bounded
         ),
         numbers = (
           SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
           FROM (
             SELECT elem
             FROM jsonb_array_elements(log_shape_buckets.numbers || EXCLUDED.numbers) AS elem
             LIMIT $9
           ) bounded
         ),
         updated_at = NOW()`,
      [
        input.entityId,
        input.shapeId,
        input.bucketStart,
        input.lane,
        input.count,
        JSON.stringify(input.exemplars.map(boundExemplarLine)),
        JSON.stringify(input.numbers),
        MAX_BUCKET_EXEMPLARS,
        MAX_BUCKET_NUMBERS,
      ],
    );
  }

  /** Updates routing for a shape prospectively (e.g. a promoted route rule) without touching its counters. Returns false if the shape has not been seen yet. */
  async setShapeLane(entityId: string, shapeId: string, lane: LogLane, laneSource: string, at: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE log_shapes
       SET lane = $3, lane_source = $4, lane_updated_at = $5, updated_at = NOW()
       WHERE entity_id = $1 AND shape_id = $2`,
      [entityId, shapeId, lane, laneSource, at],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async getShape(entityId: string, shapeId: string): Promise<LogShapeRecord | null> {
    const result = await this.pool.query(
      `SELECT entity_id, shape_id, template, first_seen_at, last_seen_at, total_count,
              lane, lane_source, lane_updated_at
       FROM log_shapes
       WHERE entity_id = $1 AND shape_id = $2
       LIMIT 1`,
      [entityId, shapeId],
    );
    const row = result.rows[0] as LogShapeDbRow | undefined;
    return row ? mapShapeRow(row) : null;
  }

  async listShapes(entityId: string, options: ListShapesOptions = {}): Promise<LogShapeRecord[]> {
    const conditions = ['entity_id = $1'];
    const params: unknown[] = [entityId];

    if (options.lane) {
      params.push(options.lane);
      conditions.push(`lane = $${params.length}`);
    }

    let limitClause = '';
    if (options.limit !== undefined) {
      params.push(options.limit);
      limitClause = ` LIMIT $${params.length}`;
    }

    const result = await this.pool.query(
      `SELECT entity_id, shape_id, template, first_seen_at, last_seen_at, total_count,
              lane, lane_source, lane_updated_at
       FROM log_shapes
       WHERE ${conditions.join(' AND ')}
       ORDER BY total_count DESC${limitClause}`,
      params,
    );
    return (result.rows as LogShapeDbRow[]).map(mapShapeRow);
  }

  /** Per-shape rollup over a window for the batch digest. Filter by exactly one of entityId or host. */
  async getDigest(input: GetDigestInput): Promise<ShapeDigestEntry[]> {
    if (!input.entityId && !input.host) {
      throw new Error('getDigest requires entityId or host');
    }

    const entityFilter = input.entityId ? 'b.entity_id = $3' : 'b.entity_id LIKE $3';
    const entityParam = input.entityId ?? `${input.host}/%`;

    // count/first/last (totals) aggregate every bucket in the window, but exemplars/numbers
    // (recent_buckets) are bounded to the most recent MAX_SHAPE_EXAMPLE_BUCKETS per shape:
    // a week-long window can span ~168 hourly buckets, and shipping all of them just to
    // discard most client-side scales transfer with window length, not the promised bound.
    const result = await this.pool.query(
      `WITH totals AS (
         SELECT b.entity_id, b.shape_id,
                SUM(b.count) AS count,
                MIN(b.bucket_start) AS first_seen_in_window,
                MAX(b.bucket_start) AS last_seen_in_window
         FROM log_shape_buckets b
         WHERE b.bucket_start >= $1 AND b.bucket_start < $2 AND ${entityFilter}
         GROUP BY b.entity_id, b.shape_id
       ),
       recent_buckets AS (
         SELECT b.entity_id, b.shape_id, b.exemplars, b.numbers,
                ROW_NUMBER() OVER (PARTITION BY b.entity_id, b.shape_id ORDER BY b.bucket_start DESC) AS rn
         FROM log_shape_buckets b
         WHERE b.bucket_start >= $1 AND b.bucket_start < $2 AND ${entityFilter}
       )
       SELECT
         t.entity_id                                        AS entity_id,
         t.shape_id                                         AS shape_id,
         s.template                                         AS template,
         s.lane                                              AS lane,
         t.count                                            AS count,
         t.first_seen_in_window                             AS first_seen_in_window,
         t.last_seen_in_window                              AS last_seen_in_window,
         jsonb_agg(r.exemplars) FILTER (WHERE r.rn <= $4)   AS exemplars_by_bucket,
         jsonb_agg(r.numbers) FILTER (WHERE r.rn <= $4)     AS numbers_by_bucket
       FROM totals t
       JOIN log_shapes s ON s.entity_id = t.entity_id AND s.shape_id = t.shape_id
       LEFT JOIN recent_buckets r ON r.entity_id = t.entity_id AND r.shape_id = t.shape_id
       GROUP BY t.entity_id, t.shape_id, s.template, s.lane, t.count, t.first_seen_in_window, t.last_seen_in_window
       ORDER BY t.count DESC`,
      [input.since, input.until, entityParam, MAX_SHAPE_EXAMPLE_BUCKETS],
    );

    return (result.rows as DigestDbRow[]).map(row => ({
      entityId: row.entity_id,
      shapeId: row.shape_id,
      template: row.template,
      lane: row.lane,
      count: Number(row.count),
      firstSeenInWindow: row.first_seen_in_window,
      lastSeenInWindow: row.last_seen_in_window,
      exemplars: flattenBounded(row.exemplars_by_bucket, MAX_DIGEST_EXEMPLARS),
      numbers: flattenBounded(row.numbers_by_bucket, MAX_BUCKET_NUMBERS),
    }));
  }

  /** Retained exemplars for a shape regardless of lane, so a demoted shape can still be inspected (plan 6.1, get_shape_examples). */
  async getShapeExemplars(entityId: string, shapeId: string, limit = MAX_DIGEST_EXEMPLARS): Promise<LogShapeExemplar[]> {
    const result = await this.pool.query(
      `SELECT exemplars
       FROM log_shape_buckets
       WHERE entity_id = $1 AND shape_id = $2
       ORDER BY bucket_start DESC
       LIMIT $3`,
      [entityId, shapeId, MAX_SHAPE_EXAMPLE_BUCKETS],
    );
    const buckets = (result.rows as { exemplars: LogShapeExemplar[] | null }[]).map(row => row.exemplars);
    return flattenBounded(buckets, limit);
  }
}
