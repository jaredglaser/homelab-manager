import type { Pool } from 'pg';
import {
  ACTIVE_CONTAINER,
  COUNTER_GUEST,
  DOCKER_HOST,
  IDLE_CONTAINER,
  NULL_METRIC_HOUR,
  PROXMOX_CLUSTER_VERSION,
  PROXMOX_HOST,
  PROXMOX_STORAGE_VALUES,
  PROXMOX_SUPPORTING_ENTITIES,
  PROXMOX_SUPPORTING_GAP_MINUTES,
  PROXMOX_SUPPORTING_SAMPLES,
  SPARSE_HOUR,
  UNIFY_COMPOSE,
  UNIFY_DESTROYED,
  UNIFY_ORPHAN,
  UNIFY_PLAIN,
  UNIFY_REPLICA,
  ZFS_DECIMATED_GAP_MINUTES,
  ZFS_DECIMATED_SAMPLES,
  ZFS_ENTITIES,
  ZFS_HOST,
  ZFS_POOL,
  ZFS_RECENT_SAMPLES,
} from './fixture';

const DOCKER_COLUMNS = `(
  time, host, container_id, container_name, image,
  cpu_percent, memory_usage, memory_limit, memory_percent,
  network_rx_bytes_per_sec, network_tx_bytes_per_sec,
  block_io_read_bytes_per_sec, block_io_write_bytes_per_sec
)`;

const DOCKER_METRICS = `
  536870912 + (s % 64) * 1048576,
  2147483648,
  (536870912 + (s % 64) * 1048576)::double precision / 2147483648 * 100,
  1024 * (1 + (s % 7)),
  512 * (1 + (s % 5)),
  2048 * (1 + (s % 3)),
  4096 * (1 + (s % 11))`;

export async function seed(pool: Pool): Promise<void> {
  await seedDockerActive(pool);
  await seedDockerIdle(pool);
  await seedDockerSparseHour(pool);
  await seedDockerNullMetricHour(pool);
  await seedZfs(pool);
  await seedProxmoxCounters(pool);
  await seedProxmoxSupporting(pool);
  await seedServiceKeyUnification(pool);
}

async function seedDockerActive(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO docker_stats ${DOCKER_COLUMNS}
     SELECT
       now() - make_interval(secs => s),
       $1, $2, $3, $4,
       20 + 10 * sin(s / 30.0),
       ${DOCKER_METRICS}
     FROM generate_series(0, $5::int - 1) AS s`,
    [
      DOCKER_HOST,
      ACTIVE_CONTAINER.id,
      ACTIVE_CONTAINER.name,
      ACTIVE_CONTAINER.image,
      ACTIVE_CONTAINER.recentSamples,
    ]
  );

  await pool.query(
    `INSERT INTO docker_stats ${DOCKER_COLUMNS}
     SELECT
       now() - make_interval(mins => s),
       $1, $2, $3, $4,
       20 + 10 * sin(s / 30.0),
       ${DOCKER_METRICS}
     FROM generate_series($5::int, $6::int) AS s`,
    [
      DOCKER_HOST,
      ACTIVE_CONTAINER.id,
      ACTIVE_CONTAINER.name,
      ACTIVE_CONTAINER.image,
      ACTIVE_CONTAINER.decimatedFromMinute,
      ACTIVE_CONTAINER.decimatedToMinute,
    ]
  );
}

async function seedDockerIdle(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO docker_stats ${DOCKER_COLUMNS}
     SELECT
       now() - make_interval(days => $5::int) - make_interval(mins => s * $6::int),
       $1, $2, $3, $4,
       3 + (s % 5),
       ${DOCKER_METRICS}
     FROM generate_series(0, $7::int - 1) AS s`,
    [
      DOCKER_HOST,
      IDLE_CONTAINER.id,
      IDLE_CONTAINER.name,
      IDLE_CONTAINER.image,
      IDLE_CONTAINER.newestAgeDays,
      IDLE_CONTAINER.gapMinutes,
      IDLE_CONTAINER.samples,
    ]
  );
}

async function seedDockerSparseHour(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO docker_stats ${DOCKER_COLUMNS}
     SELECT
       date_trunc('hour', now()) - make_interval(hours => $5::int)
         + make_interval(mins => m, secs => s),
       $1, $2, $3, $4,
       $6::double precision,
       ${DOCKER_METRICS}
     FROM generate_series(0, $7::int - 1) AS m, generate_series(0, $8::int - 1) AS s`,
    [
      DOCKER_HOST,
      SPARSE_HOUR.containerId,
      SPARSE_HOUR.containerName,
      SPARSE_HOUR.image,
      SPARSE_HOUR.hoursAgo,
      SPARSE_HOUR.fullCpuPercent,
      SPARSE_HOUR.fullMinutes,
      SPARSE_HOUR.fullSamplesPerMinute,
    ]
  );

  await pool.query(
    `INSERT INTO docker_stats ${DOCKER_COLUMNS}
     SELECT
       date_trunc('hour', now()) - make_interval(hours => $5::int)
         + make_interval(mins => $6::int, secs => s),
       $1, $2, $3, $4,
       $7::double precision,
       ${DOCKER_METRICS}
     FROM generate_series(0, $8::int - 1) AS s`,
    [
      DOCKER_HOST,
      SPARSE_HOUR.containerId,
      SPARSE_HOUR.containerName,
      SPARSE_HOUR.image,
      SPARSE_HOUR.hoursAgo,
      SPARSE_HOUR.shortMinuteIndex,
      SPARSE_HOUR.shortCpuPercent,
      SPARSE_HOUR.shortSamples,
    ]
  );
}

async function seedDockerNullMetricHour(pool: Pool): Promise<void> {
  for (const [fromMinute, toMinute, cpu] of [
    [0, NULL_METRIC_HOUR.nullMinutes - 1, null],
    [NULL_METRIC_HOUR.nullMinutes, NULL_METRIC_HOUR.minutes - 1, NULL_METRIC_HOUR.cpuPercent],
  ] as const) {
    await pool.query(
      `INSERT INTO docker_stats ${DOCKER_COLUMNS}
       SELECT
         date_trunc('hour', now()) - make_interval(hours => $5::int)
           + make_interval(mins => m, secs => s),
         $1, $2, $3, $4,
         $6::double precision,
         ${DOCKER_METRICS}
       FROM generate_series($7::int, $8::int) AS m, generate_series(0, $9::int - 1) AS s`,
      [
        DOCKER_HOST,
        NULL_METRIC_HOUR.containerId,
        NULL_METRIC_HOUR.containerName,
        NULL_METRIC_HOUR.image,
        NULL_METRIC_HOUR.hoursAgo,
        cpu,
        fromMinute,
        toMinute,
        NULL_METRIC_HOUR.samplesPerMinute,
      ]
    );
  }
}

const ZFS_COLUMNS = `(
  time, host, pool, entity, entity_type, indent,
  capacity_alloc, capacity_free,
  read_ops_per_sec, write_ops_per_sec,
  read_bytes_per_sec, write_bytes_per_sec, utilization_percent
)`;

const ZFS_METRICS = `
  4398046511104 + (s % 32)::bigint * 1073741824,
  8796093022208 - (s % 32)::bigint * 1073741824,
  120 + (s % 40),
  60 + (s % 25),
  1048576 * (1 + (s % 9)),
  524288 * (1 + (s % 6)),
  25 + (s % 50)`;

async function seedZfs(pool: Pool): Promise<void> {
  for (const entity of ZFS_ENTITIES) {
    await pool.query(
      `INSERT INTO zfs_stats ${ZFS_COLUMNS}
       SELECT
         now() - make_interval(secs => s),
         $1, $2, $3, $4, $5,
         ${ZFS_METRICS}
       FROM generate_series(0, $6::int - 1) AS s`,
      [ZFS_HOST, ZFS_POOL, entity.entity, entity.entityType, entity.indent, ZFS_RECENT_SAMPLES]
    );

    await pool.query(
      `INSERT INTO zfs_stats ${ZFS_COLUMNS}
       SELECT
         now() - make_interval(mins => (s + 1) * $6::int),
         $1, $2, $3, $4, $5,
         ${ZFS_METRICS}
       FROM generate_series(0, $7::int - 1) AS s`,
      [
        ZFS_HOST,
        ZFS_POOL,
        entity.entity,
        entity.entityType,
        entity.indent,
        ZFS_DECIMATED_GAP_MINUTES,
        ZFS_DECIMATED_SAMPLES,
      ]
    );
  }
}

const PROXMOX_COLUMNS = `(
  time, host, entity_type, node, entity_id, entity_name, status,
  cpu, max_cpu, mem, max_mem, disk, max_disk, uptime, vmid, netin, netout,
  storage_type, storage_content, storage_avail, storage_shared, cluster_version
)`;

// Anchored to the last second of the previous whole hour, which pins two things the counter
// assertions read: the newest minute bucket is whole (seeding up to now() leaves it holding only
// the seconds elapsed past it, and under 4 samples its AVG converges on its LAST), and every row
// falls inside one already-closed hour bucket, which is the only kind `_1h` materializes.
async function seedProxmoxCounters(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO proxmox_stats ${PROXMOX_COLUMNS}
     SELECT
       date_trunc('hour', now()) - make_interval(secs => s + 1),
       $1, $2, $3, $4, $5, 'running',
       0.15 + 0.05 * sin(s / 20.0),
       4 + (s % 3),
       2147483648 + (s % 48)::bigint * 1048576,
       4294967296 + (s % 16)::bigint * 1048576,
       10737418240 + (s % 32)::bigint * 1048576,
       53687091200 + (s % 24)::bigint * 1048576,
       $6::bigint + ($7::int - 1 - s) * $8::bigint,
       $9::int,
       $10::bigint + ($7::int - 1 - s) * $11::bigint,
       $12::bigint + ($7::int - 1 - s) * $13::bigint,
       NULL, NULL, NULL, NULL, NULL
     FROM generate_series(0, $7::int - 1) AS s`,
    [
      PROXMOX_HOST,
      COUNTER_GUEST.entityType,
      COUNTER_GUEST.node,
      COUNTER_GUEST.entityId,
      COUNTER_GUEST.entityName,
      COUNTER_GUEST.uptimeStart,
      COUNTER_GUEST.samples,
      COUNTER_GUEST.uptimeStep,
      COUNTER_GUEST.vmid,
      COUNTER_GUEST.netinStart,
      COUNTER_GUEST.netinStep,
      COUNTER_GUEST.netoutStart,
      COUNTER_GUEST.netoutStep,
    ]
  );
}

const PROXMOX_SUPPORTING_GAUGES = `'running',
         0.2 + 0.05 * sin(s / 8.0), 8,
         4294967296, 17179869184, 21474836480, 107374182400,
         604800 - s * 60,
         NULL,
         2000000 + (($7::int - 1 - s) * 8192)::bigint,
         1000000 + (($7::int - 1 - s) * 4096)::bigint`;

const PROXMOX_STORAGE_GAUGES = `'active',
         NULL, NULL,
         NULL, NULL, NULL, NULL,
         NULL,
         NULL,
         NULL, NULL`;

/**
 * Migration 032 rolls up a column the same way for every row of an entity_type, so each type is
 * seeded with the NULL pattern its collector produces: storage rows carry storage_avail and no
 * gauges, everything else the inverse.
 */
function proxmoxSupportingShape(entityType: string): { metrics: string; params: unknown[] } {
  if (entityType === 'storage') {
    return {
      metrics: `${PROXMOX_STORAGE_GAUGES},
         $8::text, $9::text,
         5497558138880 + (s % 24)::bigint * 1073741824,
         $10::boolean, NULL`,
      params: [
        PROXMOX_STORAGE_VALUES.storageType,
        PROXMOX_STORAGE_VALUES.storageContent,
        PROXMOX_STORAGE_VALUES.storageShared,
      ],
    };
  }
  if (entityType === 'cluster') {
    return {
      metrics: `${PROXMOX_SUPPORTING_GAUGES},
         NULL, NULL, NULL, NULL, $8::int`,
      params: [PROXMOX_CLUSTER_VERSION],
    };
  }
  return {
    metrics: `${PROXMOX_SUPPORTING_GAUGES},
         NULL, NULL, NULL, NULL, NULL`,
    params: [],
  };
}

// Anchored to the previous whole hour for the same reason as the counter guest: seeding back from
// now() puts every row in the in-progress hour whenever a run starts in the last minute of one, and
// the storage and cluster probes need a closed `_1h` bucket to compare against.
async function seedProxmoxSupporting(pool: Pool): Promise<void> {
  for (const entity of PROXMOX_SUPPORTING_ENTITIES) {
    const shape = proxmoxSupportingShape(entity.entityType);
    await pool.query(
      `INSERT INTO proxmox_stats ${PROXMOX_COLUMNS}
       SELECT
         date_trunc('hour', now()) - make_interval(mins => (s + 1) * $6::int),
         $1, $2, $3, $4, $5, ${shape.metrics}
       FROM generate_series(0, $7::int - 1) AS s`,
      [
        PROXMOX_HOST,
        entity.entityType,
        entity.node,
        entity.entityId,
        entity.entityName,
        PROXMOX_SUPPORTING_GAP_MINUTES,
        PROXMOX_SUPPORTING_SAMPLES,
        ...shape.params,
      ]
    );
  }
}

const EVENT_COLUMNS = `(
  at, host, container_id, event_type, state, name, image, labels, service_key
)`;

// docker_container_events.host references managed_hosts, which nothing else in
// the fixture seeds.
async function seedServiceKeyUnification(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO managed_hosts (name, agent_url) VALUES ($1, 'http://localhost:9090')
     ON CONFLICT (name) DO NOTHING`,
    [DOCKER_HOST]
  );

  const seedUpsert = (
    ageHours: number,
    containerId: string,
    name: string,
    image: string,
    labels: object,
    serviceKey: string,
  ): Promise<unknown> =>
    pool.query(
      `INSERT INTO docker_container_events ${EVENT_COLUMNS}
       VALUES (now() - make_interval(hours => $1::int), $2, $3, 'upsert', 'running', $4, $5, $6::jsonb, $7)`,
      [ageHours, DOCKER_HOST, containerId, name, image, JSON.stringify(labels), serviceKey]
    );

  await seedUpsert(
    3, UNIFY_COMPOSE.containerId, UNIFY_COMPOSE.name, UNIFY_COMPOSE.image,
    { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'stale' },
    UNIFY_COMPOSE.staleEventKey
  );
  await seedUpsert(
    2, UNIFY_COMPOSE.containerId, UNIFY_COMPOSE.name, UNIFY_COMPOSE.image,
    { 'com.docker.compose.project': 'media', 'com.docker.compose.service': 'plex' },
    UNIFY_COMPOSE.latestEventKey
  );

  await seedUpsert(
    3, UNIFY_DESTROYED.containerId, UNIFY_DESTROYED.name, UNIFY_DESTROYED.image,
    { 'com.docker.compose.project': 'gone', 'com.docker.compose.service': 'svc' },
    UNIFY_DESTROYED.latestUpsertKey
  );
  await pool.query(
    `INSERT INTO docker_container_events (at, host, container_id, event_type)
     VALUES (now() - make_interval(hours => 2), $1, $2, 'destroy')`,
    [DOCKER_HOST, UNIFY_DESTROYED.containerId]
  );

  await seedUpsert(
    2, UNIFY_PLAIN.containerId, UNIFY_PLAIN.name, UNIFY_PLAIN.image, {}, UNIFY_PLAIN.eventKey
  );
  await seedUpsert(
    2, UNIFY_REPLICA.containerIds[0], UNIFY_REPLICA.names[0], UNIFY_REPLICA.image,
    { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' },
    UNIFY_REPLICA.eventKey
  );
  await seedUpsert(
    2, UNIFY_REPLICA.containerIds[1], UNIFY_REPLICA.names[1], UNIFY_REPLICA.image,
    { 'com.docker.compose.project': 'app', 'com.docker.compose.service': 'web' },
    UNIFY_REPLICA.eventKey
  );

  const metadataRows: Array<[string, string, string]> = [
    [`${DOCKER_HOST}/${UNIFY_COMPOSE.containerId}`, 'service_key', UNIFY_COMPOSE.seededNameKey],
    [`${DOCKER_HOST}/${UNIFY_DESTROYED.containerId}`, 'service_key', UNIFY_DESTROYED.seededNameKey],
    [`${DOCKER_HOST}/${UNIFY_REPLICA.containerIds[0]}`, 'service_key', UNIFY_REPLICA.names[0]],
    [`${DOCKER_HOST}/${UNIFY_REPLICA.containerIds[1]}`, 'service_key', UNIFY_REPLICA.names[1]],
    [`${DOCKER_HOST}/${UNIFY_PLAIN.containerId}`, 'service_key', UNIFY_PLAIN.eventKey],
    [`${DOCKER_HOST}/${UNIFY_ORPHAN.containerId}`, 'service_key', UNIFY_ORPHAN.seededNameKey],
    [`${DOCKER_HOST}/${UNIFY_COMPOSE.seededNameKey}`, 'icon', UNIFY_COMPOSE.seededOldIcon],
    [`${DOCKER_HOST}/${UNIFY_COMPOSE.latestEventKey}`, 'icon', UNIFY_COMPOSE.targetIcon],
    [`${DOCKER_HOST}/${UNIFY_REPLICA.names[0]}`, 'icon', UNIFY_REPLICA.seededIcon],
    [`${DOCKER_HOST}/${UNIFY_PLAIN.eventKey}`, 'icon', UNIFY_PLAIN.seededIcon],
    [`${DOCKER_HOST}/${UNIFY_ORPHAN.seededNameKey}`, 'icon', UNIFY_ORPHAN.seededIcon],
  ];
  await pool.query(
    `INSERT INTO entity_metadata (source, entity, key, value, updated_at)
     SELECT 'docker', t.entity, t.key, t.value, NOW()
     FROM unnest($1::text[], $2::text[], $3::text[]) AS t(entity, key, value)`,
    [metadataRows.map(r => r[0]), metadataRows.map(r => r[1]), metadataRows.map(r => r[2])]
  );
}
