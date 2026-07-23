import type { Pool } from 'pg';
import type { ContainerState, ContainerPort, ContainerMount } from '@/types/docker-inventory';

export type NewContainerEvent =
  | {
      at: Date;
      host: string;
      containerId: string;
      eventType: 'upsert';
      state: ContainerState;
      name: string;
      image: string;
      labels: Record<string, string>;
      ports: ContainerPort[];
      mounts: ContainerMount[];
      serviceKey: string | null;
      startedAt: Date | null;
      finishedAt: Date | null;
      exitCode: number | null;
    }
  | {
      at: Date;
      host: string;
      containerId: string;
      eventType: 'destroy';
    };

export interface DockerContainerEventUpsertRow {
  at: Date;
  host: string;
  containerId: string;
  eventType: 'upsert';
  state: ContainerState;
  name: string;
  image: string;
  labels: Record<string, string>;
  ports: ContainerPort[];
  mounts: ContainerMount[];
  composeProject: string | null;
  serviceKey: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
}

export interface DockerContainerEventDestroyRow {
  at: Date;
  host: string;
  containerId: string;
  eventType: 'destroy';
}

export type DockerContainerEventRow = DockerContainerEventUpsertRow | DockerContainerEventDestroyRow;

function rowToEventRow(row: Record<string, unknown>): DockerContainerEventRow {
  const eventType = row.event_type as 'upsert' | 'destroy';
  const base = {
    at: row.at as Date,
    host: row.host as string,
    containerId: row.container_id as string,
  };

  if (eventType === 'destroy') {
    return { ...base, eventType };
  }

  return {
    ...base,
    eventType,
    state: row.state as ContainerState,
    name: row.name as string,
    image: row.image as string,
    labels: (row.labels as Record<string, string>) ?? {},
    ports: (row.ports as ContainerPort[]) ?? [],
    mounts: (row.mounts as ContainerMount[]) ?? [],
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
    const isUpsert = event.eventType === 'upsert';
    const { rows } = await this.pool.query(
      `INSERT INTO docker_container_events
         (at, host, container_id, event_type, state, name, image, labels, ports, mounts,
          service_key, started_at, finished_at, exit_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING
         at, host, container_id, event_type, state, name, image, labels, ports, mounts,
         compose_project, service_key, started_at, finished_at, exit_code`,
      [
        event.at,
        event.host,
        event.containerId,
        event.eventType,
        isUpsert ? event.state : null,
        isUpsert ? event.name : null,
        isUpsert ? event.image : null,
        JSON.stringify(isUpsert ? event.labels : {}),
        JSON.stringify(isUpsert ? event.ports : []),
        JSON.stringify(isUpsert ? event.mounts : []),
        isUpsert ? event.serviceKey : null,
        isUpsert ? event.startedAt : null,
        isUpsert ? event.finishedAt : null,
        isUpsert ? event.exitCode : null,
      ],
    );
    return rowToEventRow(rows[0] as Record<string, unknown>);
  }

  /** Latest event per (host, container_id) across all hosts. Used for init snapshots. */
  async getCurrentSnapshot(): Promise<DockerContainerEventRow[]> {
    const { rows } = await this.pool.query(
      `SELECT DISTINCT ON (host, container_id)
         at, host, container_id, event_type, state, name, image, labels, ports, mounts,
         compose_project, service_key, started_at, finished_at, exit_code
       FROM docker_container_events
       ORDER BY host, container_id, at DESC`,
    );
    return (rows as Record<string, unknown>[]).map(rowToEventRow);
  }

}
