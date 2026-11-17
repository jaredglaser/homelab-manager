import type { Pool } from 'pg';
import type { ContainerState, ContainerPort, ContainerMount } from '@/types/docker-inventory';
import { isContainerState } from '@/types/docker-inventory';
import { parseRowEnum } from '@/lib/database/repositories/row-enum';

/** Values the docker_container_events.event_type CHECK constraint allows. */
const CONTAINER_EVENT_TYPE_VALUES = ['upsert', 'destroy'] as const;
type ContainerEventType = (typeof CONTAINER_EVENT_TYPE_VALUES)[number];

/** Narrows a persisted event type, so a value the union does not know is caught at the row. */
function isContainerEventType(value: unknown): value is ContainerEventType {
  return typeof value === 'string' && (CONTAINER_EVENT_TYPE_VALUES as readonly string[]).includes(value);
}

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

/**
 * Columns of docker_container_events, as node-postgres returns them. The
 * fields_match_type CHECK keeps state/name/image set on upsert rows and NULL on
 * destroy rows, so they are only read on the upsert branch.
 */
interface ContainerEventQueryRow {
  at: Date;
  host: string;
  container_id: string;
  event_type: string;
  state: string;
  name: string;
  image: string;
  image_digest: string | null;
  labels: Record<string, string> | null;
  ports: ContainerPort[] | null;
  mounts: ContainerMount[] | null;
  compose_project: string | null;
  service_key: string | null;
  started_at: Date | null;
  finished_at: Date | null;
  exit_code: number | null;
}

function rowToEventRow(row: ContainerEventQueryRow): DockerContainerEventRow {
  const eventType = parseRowEnum('docker_container_events.event_type', row.event_type, isContainerEventType);
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
    state: parseRowEnum('docker_container_events.state', row.state, isContainerState),
    name: row.name,
    image: row.image,
    imageDigest: row.image_digest ?? null,
    labels: row.labels ?? {},
    ports: row.ports ?? [],
    mounts: row.mounts ?? [],
    composeProject: row.compose_project ?? null,
    serviceKey: row.service_key ?? null,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    exitCode: row.exit_code ?? null,
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
