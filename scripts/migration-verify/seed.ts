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
  PROXMOX_SUPPORTING_GAP_SECONDS,
  PROXMOX_SUPPORTING_SAMPLES,
  SPARSE_HOUR,
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

// One statement, not one per cpu_percent value: a second INSERT re-evaluates date_trunc('hour',
// now()), so a run that crosses an hour boundary between the two would split the fixture across two
// hour buckets and leave neither matching its expected average.
async function seedDockerSparseHour(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO docker_stats ${DOCKER_COLUMNS}
     SELECT
       date_trunc('hour', now()) - make_interval(hours => $5::int)
         + make_interval(mins => m, secs => s),
       $1, $2, $3, $4,
       CASE WHEN m = $6::int THEN $7::double precision ELSE $8::double precision END,
       ${DOCKER_METRICS}
     FROM generate_series(0, $9::int) AS m, generate_series(0, $10::int - 1) AS s
     WHERE s < CASE WHEN m = $6::int THEN $11::int ELSE $10::int END`,
    [
      DOCKER_HOST,
      SPARSE_HOUR.containerId,
      SPARSE_HOUR.containerName,
      SPARSE_HOUR.image,
      SPARSE_HOUR.hoursAgo,
      SPARSE_HOUR.shortMinuteIndex,
      SPARSE_HOUR.shortCpuPercent,
      SPARSE_HOUR.fullCpuPercent,
      SPARSE_HOUR.fullMinutes,
      SPARSE_HOUR.fullSamplesPerMinute,
      SPARSE_HOUR.shortSamples,
    ]
  );
}

async function seedDockerNullMetricHour(pool: Pool): Promise<void> {
  await pool.query(
    `INSERT INTO docker_stats ${DOCKER_COLUMNS}
     SELECT
       date_trunc('hour', now()) - make_interval(hours => $5::int)
         + make_interval(mins => m, secs => s),
       $1, $2, $3, $4,
       CASE WHEN m < $6::int THEN NULL ELSE $7::double precision END,
       ${DOCKER_METRICS}
     FROM generate_series(0, $8::int - 1) AS m, generate_series(0, $9::int - 1) AS s`,
    [
      DOCKER_HOST,
      NULL_METRIC_HOUR.containerId,
      NULL_METRIC_HOUR.containerName,
      NULL_METRIC_HOUR.image,
      NULL_METRIC_HOUR.hoursAgo,
      NULL_METRIC_HOUR.nullMinutes,
      NULL_METRIC_HOUR.cpuPercent,
      NULL_METRIC_HOUR.minutes,
      NULL_METRIC_HOUR.samplesPerMinute,
    ]
  );
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

/** cpu, max_cpu, mem, max_mem, disk, max_disk. `s` is the sample's age rank, 0 = newest. */
const PROXMOX_GAUGES = `0.2 + 0.05 * sin(s / 8.0), 8,
         4294967296 + (s % 40)::bigint * 1048576,
         17179869184,
         21474836480 + (s % 28)::bigint * 1048576,
         107374182400`;

const PROXMOX_UPTIME = `604800 - s * $6::int`;
const PROXMOX_NETIN = `2000000 + (($7::int - 1 - s) * 8192)::bigint`;
const PROXMOX_NETOUT = `1000000 + (($7::int - 1 - s) * 4096)::bigint`;
const NO_STORAGE_COLUMNS = 'NULL, NULL, NULL, NULL';

/**
 * Migration 032 rolls up a column the same way for every row of an entity_type, so each type is
 * seeded with the NULL pattern `proxmox-overview-converter.ts` produces for it: a cluster row has no
 * uptime, vmid or counters; a node row has uptime but still no vmid or counters; a guest has all
 * three; a storage row has no cpu/mem gauges but does carry disk, max_disk and the storage_* set.
 */
function proxmoxSupportingShape(entity: { entityType: string; entityId: string }): {
  metrics: string;
  params: unknown[];
} {
  switch (entity.entityType) {
    case 'storage':
      return {
        metrics: `'active',
         NULL, NULL,
         NULL, NULL,
         21474836480 + (s % 32)::bigint * 1073741824,
         107374182400,
         NULL,
         NULL,
         NULL, NULL,
         $8::text, $9::text,
         85899345920 - (s % 32)::bigint * 1073741824,
         $10::boolean, NULL`,
        params: [
          PROXMOX_STORAGE_VALUES.storageType,
          PROXMOX_STORAGE_VALUES.storageContent,
          PROXMOX_STORAGE_VALUES.storageShared,
        ],
      };
    case 'cluster':
      return {
        metrics: `'quorate',
         ${PROXMOX_GAUGES},
         NULL,
         NULL,
         NULL, NULL,
         ${NO_STORAGE_COLUMNS},
         $8::int + ($7::int - 1 - s)`,
        params: [PROXMOX_CLUSTER_VERSION],
      };
    case 'node':
      return {
        metrics: `'online',
         ${PROXMOX_GAUGES},
         ${PROXMOX_UPTIME},
         NULL,
         NULL, NULL,
         ${NO_STORAGE_COLUMNS},
         NULL`,
        params: [],
      };
    default:
      return {
        metrics: `'running',
         ${PROXMOX_GAUGES},
         ${PROXMOX_UPTIME},
         $8::int,
         ${PROXMOX_NETIN},
         ${PROXMOX_NETOUT},
         ${NO_STORAGE_COLUMNS},
         NULL`,
        params: [Number(entity.entityId)],
      };
  }
}

// Anchored to the previous whole hour for the same reason as the counter guest: seeding back from
// now() puts every row in the in-progress hour whenever a run starts in the last minute of one, and
// the storage and cluster probes need a closed `_1h` bucket to compare against. The spacing is
// seconds, not minutes, so each minute bucket holds several rows; see PROXMOX_SUPPORTING_SAMPLES.
async function seedProxmoxSupporting(pool: Pool): Promise<void> {
  for (const entity of PROXMOX_SUPPORTING_ENTITIES) {
    const shape = proxmoxSupportingShape(entity);
    await pool.query(
      `INSERT INTO proxmox_stats ${PROXMOX_COLUMNS}
       SELECT
         date_trunc('hour', now()) - make_interval(secs => (s + 1) * $6::int),
         $1, $2, $3, $4, $5, ${shape.metrics}
       FROM generate_series(0, $7::int - 1) AS s`,
      [
        PROXMOX_HOST,
        entity.entityType,
        entity.node,
        entity.entityId,
        entity.entityName,
        PROXMOX_SUPPORTING_GAP_SECONDS,
        PROXMOX_SUPPORTING_SAMPLES,
        ...shape.params,
      ]
    );
  }
}
