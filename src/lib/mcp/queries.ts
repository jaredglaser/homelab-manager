import '@tanstack/react-start/server-only';
import type { Pool } from 'pg';
import type { ContainerPort, ContainerMount } from '@/types/docker-inventory';
import type { DeployRecord } from '@/lib/deploy/types';

export interface ContainerSnapshotRow {
  at: Date;
  host: string;
  containerId: string;
  eventType: 'upsert' | 'destroy';
  state: string | null;
  name: string | null;
  image: string | null;
  labels: Record<string, string> | null;
  ports: ContainerPort[] | null;
  mounts: ContainerMount[] | null;
  composeProject: string | null;
  serviceKey: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
}

function rowToSnapshot(row: Record<string, unknown>): ContainerSnapshotRow {
  return {
    at: row.at as Date,
    host: row.host as string,
    containerId: row.container_id as string,
    eventType: row.event_type as 'upsert' | 'destroy',
    state: (row.state as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    image: (row.image as string | null) ?? null,
    labels: (row.labels as Record<string, string> | null) ?? null,
    ports: (row.ports as ContainerPort[] | null) ?? null,
    mounts: (row.mounts as ContainerMount[] | null) ?? null,
    composeProject: (row.compose_project as string | null) ?? null,
    serviceKey: (row.service_key as string | null) ?? null,
    startedAt: (row.started_at as Date | null) ?? null,
    finishedAt: (row.finished_at as Date | null) ?? null,
    exitCode: (row.exit_code as number | null) ?? null,
  };
}

const SNAPSHOT_COLUMNS = `at, host, container_id, event_type, state, name, image, labels, ports, mounts,
         compose_project, service_key, started_at, finished_at, exit_code`;

export interface ListContainerSnapshotFilter {
  host?: string;
  state?: string;
  stack?: string;
  nameContains?: string;
  afterEntityId?: string;
  limit: number;
}

/**
 * Latest event per (host, container_id), currently-running containers only
 * (`event_type = 'upsert'`), filtered and keyset-paginated by entity id
 * (host, container_id) so results stay stable across pages as new events land.
 */
export async function listContainerSnapshot(pool: Pool, filter: ListContainerSnapshotFilter): Promise<ContainerSnapshotRow[]> {
  const conditions: string[] = [`latest.event_type = 'upsert'`];
  const params: unknown[] = [];

  if (filter.host !== undefined) {
    params.push(filter.host);
    conditions.push(`latest.host = $${params.length}`);
  }
  if (filter.state !== undefined) {
    params.push(filter.state);
    conditions.push(`latest.state = $${params.length}`);
  }
  if (filter.stack !== undefined) {
    params.push(filter.stack);
    conditions.push(`latest.compose_project = $${params.length}`);
  }
  if (filter.nameContains !== undefined) {
    params.push(`%${filter.nameContains}%`);
    conditions.push(`latest.name ILIKE $${params.length}`);
  }
  if (filter.afterEntityId !== undefined) {
    const idx = filter.afterEntityId.indexOf('/');
    const afterHost = filter.afterEntityId.slice(0, idx);
    const afterContainerId = filter.afterEntityId.slice(idx + 1);
    params.push(afterHost, afterContainerId);
    conditions.push(`(latest.host, latest.container_id) > ($${params.length - 1}, $${params.length})`);
  }

  params.push(filter.limit);

  const { rows } = await pool.query(
    `SELECT ${SNAPSHOT_COLUMNS}
     FROM (
       SELECT DISTINCT ON (host, container_id) ${SNAPSHOT_COLUMNS}
       FROM docker_container_events
       ORDER BY host, container_id, at DESC
     ) latest
     WHERE ${conditions.join(' AND ')}
     ORDER BY latest.host, latest.container_id
     LIMIT $${params.length}`,
    params,
  );
  return (rows as Record<string, unknown>[]).map(rowToSnapshot);
}

/**
 * Current container count per host, for `list_hosts`. Aggregates in SQL rather
 * than pulling every container row into memory to count them client-side.
 */
export async function getContainerCountsByHost(pool: Pool): Promise<Map<string, number>> {
  const { rows } = await pool.query(
    `SELECT latest.host, COUNT(*) AS count
     FROM (
       SELECT DISTINCT ON (host, container_id) host, event_type
       FROM docker_container_events
       ORDER BY host, container_id, at DESC
     ) latest
     WHERE latest.event_type = 'upsert'
     GROUP BY latest.host`,
  );
  const counts = new Map<string, number>();
  for (const row of rows as Record<string, unknown>[]) {
    counts.set(row.host as string, Number(row.count));
  }
  return counts;
}

/** containerId may be a full id or a short prefix. */
export async function getContainerSnapshot(pool: Pool, host: string, containerId: string): Promise<ContainerSnapshotRow | null> {
  const { rows } = await pool.query(
    `SELECT ${SNAPSHOT_COLUMNS}
     FROM (
       SELECT DISTINCT ON (host, container_id) ${SNAPSHOT_COLUMNS}
       FROM docker_container_events
       WHERE host = $1 AND container_id LIKE $2 || '%'
       ORDER BY host, container_id, at DESC
     ) latest
     ORDER BY latest.at DESC
     LIMIT 1`,
    [host, containerId],
  );
  if (rows.length === 0) return null;
  return rowToSnapshot(rows[0] as Record<string, unknown>);
}

export interface ContainerEventRow {
  at: Date;
  eventType: 'upsert' | 'destroy';
  state: string | null;
  name: string | null;
  image: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
  composeProject: string | null;
  serviceKey: string | null;
}

/** Newest first; containerId may be a full id or a short prefix. */
export async function getContainerEvents(
  pool: Pool,
  host: string,
  containerId: string,
  from: Date,
  to: Date,
  limit: number,
): Promise<ContainerEventRow[]> {
  const { rows } = await pool.query(
    `SELECT at, event_type, state, name, image, compose_project, service_key, started_at, finished_at, exit_code
     FROM docker_container_events
     WHERE host = $1 AND container_id LIKE $2 || '%' AND at >= $3 AND at <= $4
     ORDER BY at DESC
     LIMIT $5`,
    [host, containerId, from, to, limit],
  );
  return (rows as Record<string, unknown>[]).map((row) => ({
    at: row.at as Date,
    eventType: row.event_type as 'upsert' | 'destroy',
    state: (row.state as string | null) ?? null,
    name: (row.name as string | null) ?? null,
    image: (row.image as string | null) ?? null,
    startedAt: (row.started_at as Date | null) ?? null,
    finishedAt: (row.finished_at as Date | null) ?? null,
    exitCode: (row.exit_code as number | null) ?? null,
    composeProject: (row.compose_project as string | null) ?? null,
    serviceKey: (row.service_key as string | null) ?? null,
  }));
}

function toDeployRecord(row: Record<string, unknown>): DeployRecord {
  return {
    id: Number(row.id),
    stack: row.stack as string,
    host: row.host as string,
    commitSha: row.commit_sha as string,
    composeHash: row.compose_hash as string,
    envHash: row.env_hash as string,
    status: row.status as DeployRecord['status'],
    trigger: row.trigger as DeployRecord['trigger'],
    action: (row.action as DeployRecord['action']) ?? 'deploy',
    forceRecreate: row.force_recreate === true,
    logs: (row.logs as string) ?? null,
    createdAt: row.created_at as Date,
    postSuccess: (row.post_success as DeployRecord['postSuccess']) ?? null,
  };
}

/** Newest first. */
export async function getDeployHistoryForStack(
  pool: Pool,
  stack: string,
  host: string | null,
  limit: number,
): Promise<DeployRecord[]> {
  const params: unknown[] = [stack];
  const hostFilter = host !== null ? `AND host = $${params.push(host)}` : '';
  params.push(limit);

  const { rows } = await pool.query(
    `SELECT * FROM deploy_history
     WHERE stack = $1 ${hostFilter}
     ORDER BY created_at DESC
     LIMIT $${params.length}`,
    params,
  );
  return (rows as Record<string, unknown>[]).map(toDeployRecord);
}
