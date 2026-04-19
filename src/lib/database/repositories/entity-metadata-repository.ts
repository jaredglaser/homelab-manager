import type { Pool } from 'pg';

/**
 * Repository for the `entity_metadata` table.
 *
 * Stores per-entity key/value attributes such as icons, display names, and
 * service-key groupings. Entity identifiers follow the `source/host/...`
 * convention (e.g. `docker` source, entity `host/container_id`).
 *
 * Split out of the original StatsRepository so time-series concerns stay
 * separate from metadata lookups/migrations.
 */
export class EntityMetadataRepository {
  constructor(private pool: Pool) {}

  async upsertEntityMetadata(
    source: string,
    entity: string,
    key: string,
    value: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO entity_metadata (source, entity, key, value, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (source, entity, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [source, entity, key, value]
    );
  }

  async getSourceIcons(source: string): Promise<Map<string, string>> {
    const result = await this.pool.query(
      `SELECT entity, value
       FROM entity_metadata
       WHERE source = $1 AND key = 'icon'`,
      [source]
    );
    const icons = new Map<string, string>();
    for (const row of result.rows as { entity: string; value: string }[]) {
      icons.set(row.entity, row.value);
    }
    return icons;
  }

  async getEntityIcon(source: string, entityId: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT value FROM entity_metadata
       WHERE source = $1 AND entity = $2 AND key = 'icon'
       LIMIT 1`,
      [source, entityId]
    );
    return (result.rows[0] as { value: string } | undefined)?.value ?? null;
  }

  async getEntityMetadata(
    source: string,
    entities: string[]
  ): Promise<Map<string, Map<string, string>>> {
    if (entities.length === 0) return new Map();

    const result = await this.pool.query(
      `SELECT entity, key, value
       FROM entity_metadata
       WHERE source = $1 AND entity = ANY($2)`,
      [source, entities]
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

  /** Look up the service_key value for a single entity. Returns null if not set. */
  async getServiceKeyForEntity(source: string, entity: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT value FROM entity_metadata
       WHERE source = $1 AND entity = $2 AND key = 'service_key'
       LIMIT 1`,
      [source, entity]
    );
    return (result.rows[0] as { value: string } | undefined)?.value ?? null;
  }

  /**
   * Given a container entity (host/container_id), find all sibling container_ids on the same
   * host that share the same service_key. Combines the getServiceKeyForEntity + getContainerIdsByServiceKey
   * lookups into a single self-join query. Returns an empty array if no service_key is set.
   */
  async getLinkedContainerIds(
    source: string,
    entity: string,
    host: string,
  ): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT SPLIT_PART(sibling.entity, '/', 2) AS container_id
       FROM entity_metadata me
       JOIN entity_metadata sibling
         ON  sibling.source = me.source
         AND sibling.key    = 'service_key'
         AND sibling.value  = me.value
         AND SPLIT_PART(sibling.entity, '/', 1) = $3
       WHERE me.source = $1 AND me.entity = $2 AND me.key = 'service_key'`,
      [source, entity, host]
    );
    return (result.rows as { container_id: string }[]).map(r => r.container_id);
  }

  /**
   * Return all container_ids (without host prefix) that share the given service_key on a host.
   * Entity format is "host/container_id", so we strip the "host/" prefix from results.
   */
  async getContainerIdsByServiceKey(
    source: string,
    host: string,
    serviceKey: string,
  ): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT SPLIT_PART(entity, '/', 2) AS container_id
       FROM entity_metadata
       WHERE source = $1 AND key = 'service_key' AND value = $3
         AND SPLIT_PART(entity, '/', 1) = $2`,
      [source, host, serviceKey]
    );
    return (result.rows as { container_id: string }[]).map(r => r.container_id);
  }

  /**
   * Migrate all entity_metadata rows on a host where service_key = oldKey to newKey.
   * Used when a container gains Docker Compose labels after previously using a name-only key.
   * Idempotent - safe to call even if rows don't exist or are already updated.
   */
  async migrateServiceKeyByName(
    source: string,
    host: string,
    oldKey: string,
    newKey: string,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE entity_metadata
       SET value = $4, updated_at = NOW()
       WHERE source = $1 AND key = 'service_key' AND value = $3
         AND SPLIT_PART(entity, '/', 1) = $2`,
      [source, host, oldKey, newKey]
    );
  }

  /**
   * Copy the icon from one service_key entity to another.
   * Used when a container gains Docker Compose labels - the icon stored under the
   * old name-only entity (e.g. "myhost/plex") is copied to the new compose entity
   * (e.g. "myhost/media-stack/plex") so it survives the migration.
   * ON CONFLICT DO NOTHING preserves any icon the user already set on the new entity.
   *
   * NOTE: Removing compose labels from a container does NOT revert the service_key
   * back to a name-only entry - the container retains the compose-based service_key
   * and icon until the worker restarts or the container is recreated without labels.
   */
  async migrateServiceIcon(
    source: string,
    oldServiceKeyEntity: string,
    newServiceKeyEntity: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO entity_metadata (source, entity, key, value, updated_at)
       SELECT $1, $3, key, value, NOW()
       FROM entity_metadata
       WHERE source = $1 AND entity = $2 AND key = 'icon'
       ON CONFLICT (source, entity, key) DO NOTHING`,
      [source, oldServiceKeyEntity, newServiceKeyEntity]
    );
  }

  /**
   * Return the service_key and resolved icon for a single container entity in one query.
   * Uses the same JOIN + COALESCE pattern as getDockerContainerMetadata but for a single entity.
   * Returns null if the entity has no service_key set.
   */
  async getContainerServiceInfo(
    source: string,
    entity: string,
  ): Promise<{ serviceKey: string; icon: string | null } | null> {
    const result = await this.pool.query(
      `SELECT
         sk.value AS service_key,
         COALESCE(icon.value, legacy_icon.value) AS icon
       FROM entity_metadata sk
       LEFT JOIN entity_metadata icon
         ON  icon.source = sk.source
         AND icon.key    = 'icon'
         AND icon.entity = SPLIT_PART(sk.entity, '/', 1) || '/' || sk.value
       LEFT JOIN entity_metadata legacy_icon
         ON  legacy_icon.source = sk.source
         AND legacy_icon.key    = 'icon'
         AND legacy_icon.entity = sk.entity
       WHERE sk.source = $1 AND sk.entity = $2 AND sk.key = 'service_key'`,
      [source, entity]
    );
    const row = result.rows[0] as { service_key: string; icon: string | null } | undefined;
    if (!row) return null;
    return { serviceKey: row.service_key, icon: row.icon ?? null };
  }

  /**
   * Return per-container icon and service_key entity for the Docker dashboard.
   * Icons are stored under the service_key entity (host/service_key) so they
   * survive container recreation. The result is keyed by container entity (host/container_id)
   * for easy lookup during hierarchy building.
   */
  async getDockerContainerMetadata(
    source: string,
  ): Promise<Map<string, { serviceKeyEntity: string; iconSlug: string | null }>> {
    const result = await this.pool.query(
      `SELECT
         sk.entity                                                             AS container_entity,
         SPLIT_PART(sk.entity, '/', 1) || '/' || sk.value                     AS service_key_entity,
         COALESCE(icon.value, legacy_icon.value)                               AS icon_slug
       FROM entity_metadata sk
       LEFT JOIN entity_metadata icon
         ON  icon.source = sk.source
         AND icon.key    = 'icon'
         AND icon.entity = SPLIT_PART(sk.entity, '/', 1) || '/' || sk.value
       LEFT JOIN entity_metadata legacy_icon
         ON  legacy_icon.source = sk.source
         AND legacy_icon.key    = 'icon'
         AND legacy_icon.entity = sk.entity
       WHERE sk.source = $1 AND sk.key = 'service_key'`,
      [source]
    );

    const meta = new Map<string, { serviceKeyEntity: string; iconSlug: string | null }>();
    for (const row of result.rows as { container_entity: string; service_key_entity: string; icon_slug: string | null }[]) {
      meta.set(row.container_entity, {
        serviceKeyEntity: row.service_key_entity,
        iconSlug: row.icon_slug ?? null,
      });
    }
    return meta;
  }
}
