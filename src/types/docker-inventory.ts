/**
 * Domain types for the Docker container inventory pipeline.
 *
 * Agent → worker → `docker_container_events` hypertable → NOTIFY →
 * web broadcast service → `/api/docker-inventory` SSE → `useDockerInventory()` hook.
 */

/** Canonical container state vocabulary exposed across the pipeline. */
export type ContainerState =
  | 'running'
  | 'exited'
  | 'paused'
  | 'restarting'
  | 'created'
  | 'dead'
  | 'removing'
  | 'unknown';

/**
 * Raw container snapshot emitted by the agent's `/containers/events` SSE endpoint.
 * Values come straight from Dockerode. Worker normalizes these into
 * `DockerContainerEventRow` writes plus `DockerContainerInventory` broadcasts.
 */
export interface InventoryContainer {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  labels: Record<string, string>;
  /** ISO timestamp, null when not yet started. */
  startedAt: string | null;
  /** ISO timestamp, null when still running. */
  finishedAt: string | null;
  /** Present for `exited`/`dead`; null otherwise. */
  exitCode: number | null;
}

/** Event shapes emitted by the agent's `/containers/events` SSE stream. */
export type AgentContainerEvent =
  | { op: 'init'; containers: InventoryContainer[] }
  | { op: 'upsert'; container: InventoryContainer }
  | { op: 'destroy'; containerId: string };

/**
 * Current-state view of one container, derived from the latest event in
 * `docker_container_events` or streamed directly as an incremental upsert.
 * The web broadcast service and frontend hook both deal in this shape.
 */
export interface DockerContainerInventory {
  host: string;
  containerId: string;
  name: string;
  image: string;
  state: ContainerState;
  composeProject: string | null;
  serviceKey: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  exitCode: number | null;
  /**
   * Full label map. Present only on init snapshots (read from the DB);
   * streaming upsert events omit labels to keep NOTIFY payloads small.
   */
  labels: Record<string, string>;
  /** Timestamp of the last state-change event. */
  updatedAt: Date;
}

/** Events fanned out from `DockerInventoryBroadcastService` to SSE subscribers. */
export type DockerInventoryBroadcastEvent =
  | { type: 'init'; containers: DockerContainerInventory[] }
  | { type: 'upsert'; container: DockerContainerInventory }
  | { type: 'destroy'; host: string; containerId: string; at: Date };
