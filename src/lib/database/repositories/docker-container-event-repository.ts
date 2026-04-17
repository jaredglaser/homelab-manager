import type { Pool } from 'pg';
import type { ContainerState } from '@/types/docker-inventory';

export interface NewContainerEvent {
  at: Date;
  host: string;
  containerId: string;
  eventType: 'upsert' | 'destroy';
  state: ContainerState | null;
  name: string | null;
  image: string | null;
  labels: Record<string, string>;
  serviceKey: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
}

export interface DockerContainerEventRow {
  at: Date;
  host: string;
  containerId: string;
  eventType: 'upsert' | 'destroy';
  state: ContainerState | null;
  name: string | null;
  image: string | null;
  labels: Record<string, string>;
  composeProject: string | null;
  serviceKey: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
}

function rowToEventRow(row: Record<string, unknown>): DockerContainerEventRow {
  return {
    at: row.at as Date,
    host: row.host as string,
    containerId: row.container_id as string,
    eventType: row.event_type as 'upsert' | 'destroy',
    state: (row.state as ContainerState | null) ?? null,
    name: (row.name as string | null) ?? null,
    image: (row.image as string | null) ?? null,
    labels: (row.labels as Record<string, string>) ?? {},
    composeProject: (row.compose_project as string | null) ?? null,
    serviceKey: (row.service_key as string | null) ?? null,
    startedAt: (row.started_at as Date | null) ?? null,
    finishedAt: (row.finished_at as Date | null) ?? null,
    exitCode: (row.exit_code as number | null) ?? null,
  };
}

export class DockerContainerEventRepository {
  constructor(private readonly pool: Pool) {}

  /** Append one event row. Returns the inserted row. */
  async insert(event: NewContainerEvent): Promise<DockerContainerEventRow> {
    const { rows } = await this.pool.query(
      `INSERT INTO docker_container_events
         (at, host, container_id, event_type, state, name, image, labels, service_key,
          started_at, finished_at, exit_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING
         at, host, container_id, event_type, state, name, image, labels,
         compose_project, service_key, started_at, finished_at, exit_code`,
      [
        event.at,
        event.host,
        event.containerId,
        event.eventType,
        event.state,
        event.name,
        event.image,
        JSON.stringify(event.labels),
        event.serviceKey,
        event.startedAt,
        event.finishedAt,
        event.exitCode,
      ],
    );
    return rowToEventRow(rows[0] as Record<string, unknown>);
  }

  /** Latest event per (host, container_id) across all hosts. Used for init snapshots. */
  async getCurrentSnapshot(): Promise<DockerContainerEventRow[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (host, container_id)
         at, host, container_id, event_type, state, name, image, labels,
         compose_project, service_key, started_at, finished_at, exit_code
       FROM docker_container_events
       ORDER BY host, container_id, at DESC`,
    );
    return (rows as Record<string, unknown>[]).map(rowToEventRow);
  }

  /** Latest event for a specific container. Used by collector for no-op dedup. */
  async getLatestForContainer(host: string, containerId: string): Promise<DockerContainerEventRow | null> {
    const { rows } = await this.pool.query(
      `SELECT
         at, host, container_id, event_type, state, name, image, labels,
         compose_project, service_key, started_at, finished_at, exit_code
       FROM docker_container_events
       WHERE host = $1 AND container_id = $2
       ORDER BY at DESC
       LIMIT 1`,
      [host, containerId],
    );
    if (rows.length === 0) return null;
    return rowToEventRow(rows[0] as Record<string, unknown>);
  }

  /** Time-series of state changes for a container, oldest first. For future graphing. */
  async getHistoryForContainer(host: string, containerId: string, since: Date): Promise<DockerContainerEventRow[]> {
    const { rows } = await this.pool.query(
      `SELECT
         at, host, container_id, event_type, state, name, image, labels,
         compose_project, service_key, started_at, finished_at, exit_code
       FROM docker_container_events
       WHERE host = $1 AND container_id = $2 AND at >= $3
       ORDER BY at ASC`,
      [host, containerId, since],
    );
    return (rows as Record<string, unknown>[]).map(rowToEventRow);
  }
}
