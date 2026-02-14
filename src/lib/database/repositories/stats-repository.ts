import type { Pool } from 'pg';

export interface RawStatRow {
  timestamp: Date;
  source: string;
  type: string;
  entity: string;
  value: number;
}

/** Row returned by getLatestStats - latest value for each entity/type combination */
export interface LatestStatRow {
  timestamp: Date;
  type: string;
  entity: string;
  value: number;
}

export class StatsRepository {
  private sourceCache = new Map<string, number>();
  private typeCache = new Map<string, number>();

  constructor(private pool: Pool) {}

  async getOrCreateSource(name: string): Promise<number> {
    const cached = this.sourceCache.get(name);
    if (cached !== undefined) return cached;

    // SELECT first to avoid wasting identity sequence values on conflict
    let result = await this.pool.query(
      `SELECT id FROM stat_source WHERE name = $1`,
      [name]
    );

    if (result.rows.length === 0) {
      result = await this.pool.query(
        `INSERT INTO stat_source (name) VALUES ($1)
         ON CONFLICT (name) DO NOTHING
         RETURNING id`,
        [name]
      );

      // Race condition: another connection inserted between SELECT and INSERT
      if (result.rows.length === 0) {
        result = await this.pool.query(
          `SELECT id FROM stat_source WHERE name = $1`,
          [name]
        );
      }
    }

    const id = result.rows[0].id;
    this.sourceCache.set(name, id);
    return id;
  }

  async getOrCreateType(sourceName: string, typeName: string): Promise<number> {
    const cacheKey = `${sourceName}:${typeName}`;
    const cached = this.typeCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const sourceId = await this.getOrCreateSource(sourceName);

    // SELECT first to avoid wasting identity sequence values on conflict
    let result = await this.pool.query(
      `SELECT id FROM stat_type WHERE source_id = $1 AND name = $2`,
      [sourceId, typeName]
    );

    if (result.rows.length === 0) {
      result = await this.pool.query(
        `INSERT INTO stat_type (source_id, name) VALUES ($1, $2)
         ON CONFLICT (source_id, name) DO NOTHING
         RETURNING id`,
        [sourceId, typeName]
      );

      // Race condition: another connection inserted between SELECT and INSERT
      if (result.rows.length === 0) {
        result = await this.pool.query(
          `SELECT id FROM stat_type WHERE source_id = $1 AND name = $2`,
          [sourceId, typeName]
        );
      }
    }

    const id = result.rows[0].id;
    this.typeCache.set(cacheKey, id);
    return id;
  }

  private async resolveIds(
    rows: RawStatRow[]
  ): Promise<Map<string, { sourceId: number; typeId: number }>> {
    const resolved = new Map<string, { sourceId: number; typeId: number }>();

    const pairs = new Set<string>();
    for (const row of rows) {
      pairs.add(`${row.source}:${row.type}`);
    }

    for (const pair of pairs) {
      const [source, ...typeParts] = pair.split(':');
      const type = typeParts.join(':');
      const sourceId = await this.getOrCreateSource(source);
      const typeId = await this.getOrCreateType(source, type);
      resolved.set(pair, { sourceId, typeId });
    }

    return resolved;
  }

  async insertRawStats(rows: RawStatRow[]): Promise<void> {
    if (rows.length === 0) return;

    try {
      const idMap = await this.resolveIds(rows);

      const values: unknown[] = [];
      const placeholders: string[] = [];

      rows.forEach((row, index) => {
        const offset = index * 5;
        const ids = idMap.get(`${row.source}:${row.type}`)!;

        placeholders.push(
          `($${offset + 1}, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5})`
        );

        values.push(
          row.timestamp,
          ids.sourceId,
          ids.typeId,
          row.entity,
          row.value
        );
      });

      const query = `
        INSERT INTO stats_raw (timestamp, source_id, type_id, entity, value)
        VALUES ${placeholders.join(', ')}
        ON CONFLICT (timestamp, source_id, type_id, entity) DO NOTHING
      `;

      await this.pool.query(query, values);

      // Notify listeners about new stats for each source
      const sources = [...new Set(rows.map(r => r.source))];
      for (const source of sources) {
        await this.pool.query(`NOTIFY stats_update, '${source}'`);
      }
    } catch (err) {
      console.error('[StatsRepository] Failed to insert stats:', err);
      throw err;
    }
  }

  /**
   * Get the most recent stats for each entity/type combination
   * Used by the subscription service to populate cache after NOTIFY
   */
  async getLatestStats(params: {
    sourceName: string;
    maxAge?: number; // Seconds, default 5
  }): Promise<LatestStatRow[]> {
    const sourceId = await this.getOrCreateSource(params.sourceName);
    const maxAge = params.maxAge ?? 5;

    const result = await this.pool.query(
      `SELECT DISTINCT ON (entity, type_id)
              sr.timestamp,
              st.name AS type,
              sr.entity,
              sr.value
       FROM stats_raw sr
       JOIN stat_type st ON sr.type_id = st.id
       WHERE sr.source_id = $1
         AND sr.timestamp >= NOW() - make_interval(secs => $2)
       ORDER BY entity, type_id, sr.timestamp DESC`,
      [sourceId, maxAge]
    );

    return result.rows.map((row: { timestamp: Date; type: string; entity: string; value: number }) => ({
      timestamp: row.timestamp,
      type: row.type,
      entity: row.entity,
      value: row.value,
    }));
  }

  async getEntities(
    sourceName: string,
    daysBack: number = 7
  ): Promise<string[]> {
    const sourceId = await this.getOrCreateSource(sourceName);

    const result = await this.pool.query(
      `SELECT DISTINCT entity
       FROM stats_raw
       WHERE source_id = $1
         AND timestamp >= NOW() - make_interval(days => $2)
       ORDER BY entity`,
      [sourceId, daysBack]
    );

    return result.rows.map((row: { entity: string }) => row.entity);
  }

  async getStats(params: {
    sourceName: string;
    entity: string;
    startTime: Date;
    endTime: Date;
    typeNames?: string[];
  }) {
    const sourceId = await this.getOrCreateSource(params.sourceName);

    if (params.typeNames && params.typeNames.length > 0) {
      const typeIds: number[] = [];
      for (const typeName of params.typeNames) {
        typeIds.push(await this.getOrCreateType(params.sourceName, typeName));
      }

      const result = await this.pool.query(
        `SELECT sr.timestamp, st.name AS type, sr.entity, sr.value
         FROM stats_raw sr
         JOIN stat_type st ON sr.type_id = st.id
         WHERE sr.source_id = $1
           AND sr.entity = $2
           AND sr.type_id = ANY($3)
           AND sr.timestamp >= $4
           AND sr.timestamp <= $5
         ORDER BY sr.timestamp DESC`,
        [sourceId, params.entity, typeIds, params.startTime, params.endTime]
      );

      return result.rows;
    }

    const result = await this.pool.query(
      `SELECT sr.timestamp, st.name AS type, sr.entity, sr.value
       FROM stats_raw sr
       JOIN stat_type st ON sr.type_id = st.id
       WHERE sr.source_id = $1
         AND sr.entity = $2
         AND sr.timestamp >= $3
         AND sr.timestamp <= $4
       ORDER BY sr.timestamp DESC`,
      [sourceId, params.entity, params.startTime, params.endTime]
    );

    return result.rows;
  }

  /**
   * Get time series stats for all entities matching optional filter.
   * Returns data grouped by timestamp for charting purposes.
   */
  async getTimeSeriesStats(params: {
    sourceName: string;
    startTime: Date;
    endTime: Date;
    typeNames: string[];
    entityFilter?: (entity: string) => boolean;
  }): Promise<LatestStatRow[]> {
    const sourceId = await this.getOrCreateSource(params.sourceName);

    const typeIds: number[] = [];
    for (const typeName of params.typeNames) {
      typeIds.push(await this.getOrCreateType(params.sourceName, typeName));
    }

    const result = await this.pool.query(
      `SELECT sr.timestamp, st.name AS type, sr.entity, sr.value
       FROM stats_raw sr
       JOIN stat_type st ON sr.type_id = st.id
       WHERE sr.source_id = $1
         AND sr.type_id = ANY($2)
         AND sr.timestamp >= $3
         AND sr.timestamp <= $4
       ORDER BY sr.timestamp ASC`,
      [sourceId, typeIds, params.startTime, params.endTime]
    );

    let rows = result.rows.map(
      (row: { timestamp: Date; type: string; entity: string; value: number }) => ({
        timestamp: row.timestamp,
        type: row.type,
        entity: row.entity,
        value: row.value,
      })
    );

    if (params.entityFilter) {
      rows = rows.filter((row: LatestStatRow) => params.entityFilter!(row.entity));
    }

    return rows;
  }

  /**
   * Upsert entity metadata (key-value pair for an entity).
   * Used for storing display names, labels, and other metadata.
   */
  async upsertEntityMetadata(
    source: string,
    entity: string,
    key: string,
    value: string
  ): Promise<void> {
    const sourceId = await this.getOrCreateSource(source);
    await this.pool.query(
      `INSERT INTO entity_metadata (source_id, entity, key, value, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (source_id, entity, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [sourceId, entity, key, value]
    );
  }

  /**
   * Get metadata for multiple entities.
   * Returns a nested map: entity -> key -> value
   */
  async getEntityMetadata(
    source: string,
    entities: string[]
  ): Promise<Map<string, Map<string, string>>> {
    if (entities.length === 0) return new Map();

    const sourceId = await this.getOrCreateSource(source);
    const result = await this.pool.query(
      `SELECT entity, key, value
       FROM entity_metadata
       WHERE source_id = $1 AND entity = ANY($2)`,
      [sourceId, entities]
    );

    const metadata = new Map<string, Map<string, string>>();
    for (const row of result.rows as { entity: string; key: string; value: string }[]) {
      if (!metadata.has(row.entity)) {
        metadata.set(row.entity, new Map());
      }
      metadata.get(row.entity)!.set(row.key, row.value);
    }
    return metadata;
  }
}
