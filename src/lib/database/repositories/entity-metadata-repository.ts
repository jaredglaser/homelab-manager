import type { Pool } from 'pg';

/**
 * Repository for entity metadata stored in PostgreSQL.
 * Stores display names, labels, icons, and other key-value metadata per entity.
 *
 * Uses a string `source` column instead of FK to stat_source,
 * since time-series data is now in InfluxDB.
 */
export class EntityMetadataRepository {
  constructor(private pool: Pool) {}

  /**
   * Upsert entity metadata (key-value pair for an entity).
   * Used for storing display names, labels, and other metadata.
   */
  async upsertEntityMetadata(
    source: string,
    entity: string,
    key: string,
    value: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO entity_metadata (source, entity, key, value, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (source, entity, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [source, entity, key, value],
    );
  }

  /**
   * Get metadata for multiple entities.
   * Returns a nested map: entity -> key -> value
   */
  async getEntityMetadata(
    source: string,
    entities: string[],
  ): Promise<Map<string, Map<string, string>>> {
    if (entities.length === 0) return new Map();

    const result = await this.pool.query(
      `SELECT entity, key, value
       FROM entity_metadata
       WHERE source = $1 AND entity = ANY($2)`,
      [source, entities],
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
