import type { Pool } from 'pg';

type ValueRow = { value: string };
type EntityValueRow = { entity: string; value: string };
type EntityKeyValueRow = { entity: string; key: string; value: string };
type ContainerIdRow = { container_id: string };
type ServiceInfoRow = { service_key: string; icon: string | null };
type ContainerMetadataRow = { container_entity: string; service_key_entity: string; icon_slug: string | null };

/**
 * Repository for the `entity_metadata` table.
 *
 * Stores per-entity key/value attributes such as icons, display names, and
 * service-key groupings. Entity identifiers follow the `host/container_id`
 * convention (longer slash paths allowed for hierarchical sources). The
 * `source` column is stored separately and is currently always `'docker'`.
 *
 * Known `key` values: `icon`, `service_key`, `name`, `image`, `label`.
 *
 * Split out of the original StatsRepository so time-series concerns stay
 * separate from metadata lookups/migrations.
 */
export class EntityMetadataRepository {
  constructor(private pool: Pool) {}

  async upsertEntityMetadata(
    entity: string,
    key: string,
    value: string
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO entity_metadata (source, entity, key, value, updated_at)
       VALUES ('docker', $1, $2, $3, NOW())
       ON CONFLICT (source, entity, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [entity, key, value]
    );
  }

  /**
   * Upsert several entity/key/value rows in one statement via unnest.
   * Used by AgentStatsCollector to register a new container (name, image,
   * service_key) with one round trip instead of three. Entries must not
   * contain duplicate (entity, key) pairs: ON CONFLICT DO UPDATE rejects
   * affecting the same row twice within one statement.
   */
  async upsertEntityMetadataBatch(
    entries: { entity: string; key: string; value: string }[]
  ): Promise<void> {
    if (entries.length === 0) return;
    await this.pool.query(
      `INSERT INTO entity_metadata (source, entity, key, value, updated_at)
       SELECT 'docker', t.entity, t.key, t.value, NOW()
       FROM unnest($1::text[], $2::text[], $3::text[]) AS t(entity, key, value)
       ON CONFLICT (source, entity, key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [
        entries.map(e => e.entity),
        entries.map(e => e.key),
        entries.map(e => e.value),
      ]
    );
  }

  async getSourceIcons(): Promise<Map<string, string>> {
    const result = await this.pool.query(
      `SELECT entity, value
       FROM entity_metadata
       WHERE source = 'docker' AND key = 'icon'`
    );
    const icons = new Map<string, string>();
    for (const row of result.rows as EntityValueRow[]) {
      icons.set(row.entity, row.value);
    }
    return icons;
  }

  async getEntityIcon(entityId: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT value FROM entity_metadata
       WHERE source = 'docker' AND entity = $1 AND key = 'icon'
       LIMIT 1`,
      [entityId]
    );
    return (result.rows[0] as ValueRow | undefined)?.value ?? null;
  }

  async getEntityMetadata(
    entities: string[]
  ): Promise<Map<string, Map<string, string>>> {
    if (entities.length === 0) return new Map();

    const result = await this.pool.query(
      `SELECT entity, key, value
       FROM entity_metadata
       WHERE source = 'docker' AND entity = ANY($1)`,
      [entities]
    );

    const metadata = new Map<string, Map<string, string>>();
    for (const row of result.rows as EntityKeyValueRow[]) {
      if (!metadata.has(row.entity)) {
        metadata.set(row.entity, new Map());
      }
      metadata.get(row.entity)!.set(row.key, row.value);
    }
    return metadata;
  }

  /** Look up the service_key value for a single entity. Returns null if not set. */
  async getServiceKeyForEntity(entity: string): Promise<string | null> {
    const result = await this.pool.query(
      `SELECT value FROM entity_metadata
       WHERE source = 'docker' AND entity = $1 AND key = 'service_key'
       LIMIT 1`,
      [entity]
    );
    return (result.rows[0] as ValueRow | undefined)?.value ?? null;
  }

  /**
   * Given a container entity (host/container_id), find all sibling container_ids on the same
   * host that share the same service_key. Combines the getServiceKeyForEntity + getContainerIdsByServiceKey
   * lookups into a single self-join query. Returns an empty array if no service_key is set.
   */
  async getLinkedContainerIds(
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
         AND SPLIT_PART(sibling.entity, '/', 1) = $2
       WHERE me.source = 'docker' AND me.entity = $1 AND me.key = 'service_key'`,
      [entity, host]
    );
    return (result.rows as ContainerIdRow[]).map(r => r.container_id);
  }

  /**
   * Return all container_ids (without host prefix) that share the given service_key on a host.
   * Entity format is "host/container_id", so we strip the "host/" prefix from results.
   */
  async getContainerIdsByServiceKey(
    host: string,
    serviceKey: string,
  ): Promise<string[]> {
    const result = await this.pool.query(
      `SELECT SPLIT_PART(entity, '/', 2) AS container_id
       FROM entity_metadata
       WHERE source = 'docker' AND key = 'service_key' AND value = $2
         AND SPLIT_PART(entity, '/', 1) = $1`,
      [host, serviceKey]
    );
    return (result.rows as ContainerIdRow[]).map(r => r.container_id);
  }

  /**
   * Migrate all entity_metadata rows on a host where service_key = `from` to `to`.
   * Used when a container gains Docker Compose labels after previously using a name-only key.
   * Idempotent; safe to call even if rows don't exist or are already updated.
   */
  async migrateServiceKeyByName(
    { host, from, to }: { host: string; from: string; to: string },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE entity_metadata
       SET value = $3, updated_at = NOW()
       WHERE source = 'docker' AND key = 'service_key' AND value = $2
         AND SPLIT_PART(entity, '/', 1) = $1`,
      [host, from, to]
    );
  }

  /**
   * Copy the icon from one service_key entity to another.
   * Used when a container gains Docker Compose labels: the icon stored under the
   * old name-only entity (e.g. "myhost/plex") is copied to the new compose entity
   * (e.g. "myhost/media-stack/plex") so it survives the migration.
   * ON CONFLICT DO NOTHING preserves any icon the user already set on the new entity.
   *
   * NOTE: Removing compose labels from a container does NOT revert the service_key
   * back to a name-only entry; the container retains the compose-based service_key
   * and icon until the worker restarts or the container is recreated without labels.
   */
  async migrateServiceIcon(
    { from, to }: { from: string; to: string },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO entity_metadata (source, entity, key, value, updated_at)
       SELECT 'docker', $2, key, value, NOW()
       FROM entity_metadata
       WHERE source = 'docker' AND entity = $1 AND key = 'icon'
       ON CONFLICT (source, entity, key) DO NOTHING`,
      [from, to]
    );
  }

  /**
   * Return the service_key and resolved icon for a single container entity in one query.
   * Uses the same JOIN + COALESCE pattern as getDockerContainerMetadata but for a single entity.
   * Returns null if the entity has no service_key set.
   */
  async getContainerServiceInfo(
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
       WHERE sk.source = 'docker' AND sk.entity = $1 AND sk.key = 'service_key'`,
      [entity]
    );
    const row = result.rows[0] as ServiceInfoRow | undefined;
    if (!row) return null;
    return { serviceKey: row.service_key, icon: row.icon ?? null };
  }

  /**
   * Return per-container icon and service_key entity for the Docker dashboard.
   * Icons are stored under the service_key entity (host/service_key) so they
   * survive container recreation. The result is keyed by container entity (host/container_id)
   * for easy lookup during hierarchy building.
   */
  async getDockerContainerMetadata(): Promise<Map<string, { serviceKeyEntity: string; iconSlug: string | null }>> {
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
       WHERE sk.source = 'docker' AND sk.key = 'service_key'`
    );

    const meta = new Map<string, { serviceKeyEntity: string; iconSlug: string | null }>();
    for (const row of result.rows as ContainerMetadataRow[]) {
      meta.set(row.container_entity, {
        serviceKeyEntity: row.service_key_entity,
        iconSlug: row.icon_slug ?? null,
      });
    }
    return meta;
  }
}
