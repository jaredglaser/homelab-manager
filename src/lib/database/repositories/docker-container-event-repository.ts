import type { Pool } from 'pg';
import type { ContainerState, ContainerPort, ContainerMount } from '@/types/docker-inventory';
import { CONTAINER_STATE_VALUES } from '@/types/docker-inventory';
import { parseRowEnum, parseRowEnumOr } from '@/lib/database/repositories/row-enum';

const CONTAINER_EVENT_TYPE_VALUES = ['upsert', 'destroy'] as const;

export type NewContainerEvent =
  | {
      at: Date;
      host: string;
      containerId: string;
      eventType: 'upsert';
      state: ContainerState;
      name: string;
      image: string;
      /** Manifest digest the image was pulled by, null for locally built images. */
      imageDigest: string | null;
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
  imageDigest: string | null;
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

/** The fields_match_type CHECK keeps state/name/image set on upsert rows and NULL on destroy rows, so they are only read on the upsert branch. */
interface ContainerEventQueryRow {
  at: Date;
  host: string;
  container_id: string;
  event_type: string;
  state: string;
  name: string;
  image: string;
  image_digest: string | null;
  labels: Record<string, string>;
  ports: ContainerPort[];
  mounts: ContainerMount[];
  compose_project: string | null;
  service_key: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  exit_code: number | null;
}

function rowToEventRow(row: ContainerEventQueryRow): DockerContainerEventRow {
  const eventType = parseRowEnum('docker_container_events.event_type', row.event_type, CONTAINER_EVENT_TYPE_VALUES);
  const base = {
    at: row.at,
    host: row.host,
    containerId: row.container_id,
  };

  if (eventType === 'destroy') {
    return { ...base, eventType };
  }

  return {
    ...base,
    eventType,
    state: parseRowEnumOr('docker_container_events.state', row.state, CONTAINER_STATE_VALUES, 'unknown'),
    name: row.name,
    image: row.image,
    imageDigest: row.image_digest,
    labels: row.labels,
    ports: row.ports,
    mounts: row.mounts,
    composeProject: row.compose_project,
    serviceKey: row.service_key,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    exitCode: row.exit_code,
  };
}

export class DockerContainerEventRepository {
  constructor(private readonly pool: Pool) {}

  /** Append one event row. Returns the inserted row. */
  async insert(event: NewContainerEvent): Promise<DockerContainerEventRow> {
    const isUpsert = event.eventType === 'upsert';
    const { rows } = await this.pool.query<ContainerEventQueryRow>(
      `INSERT INTO docker_container_events
         (at, host, container_id, event_type, state, name, image, image_digest, labels, ports, mounts,
          service_key, started_at, finished_at, exit_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
       RETURNING
         at, host, container_id, event_type, state, name, image, image_digest, labels, ports, mounts,
         compose_project, service_key, started_at, finished_at, exit_code`,
      [
        event.at,
        event.host,
        event.containerId,
        event.eventType,
        isUpsert ? event.state : null,
        isUpsert ? event.name : null,
        isUpsert ? event.image : null,
        isUpsert ? event.imageDigest : null,
        JSON.stringify(isUpsert ? event.labels : {}),
        JSON.stringify(isUpsert ? event.ports : []),
        JSON.stringify(isUpsert ? event.mounts : []),
        isUpsert ? event.serviceKey : null,
        isUpsert ? event.startedAt : null,
        isUpsert ? event.finishedAt : null,
        isUpsert ? event.exitCode : null,
      ],
    );
    return rowToEventRow(rows[0]);
  }

  /** Latest event per (host, container_id) across all hosts. Used for init snapshots. */
  async getCurrentSnapshot(): Promise<DockerContainerEventRow[]> {
    const { rows } = await this.pool.query<ContainerEventQueryRow>(
      `SELECT DISTINCT ON (host, container_id)
         at, host, container_id, event_type, state, name, image, image_digest, labels, ports, mounts,
         compose_project, service_key, started_at, finished_at, exit_code
       FROM docker_container_events
       ORDER BY host, container_id, at DESC`,
    );
    return rows.map(rowToEventRow);
  }

}
