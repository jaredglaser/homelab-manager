/**
 * Domain types for the Docker container inventory pipeline.
 *
 * Agent → worker → `docker_container_events` hypertable → NOTIFY →
 * web broadcast service → `/api/docker-inventory` SSE → `useDockerInventory()` hook.
 */

import type { ContainerState } from '@homelab-manager/agent/types/protocol';

export type { ContainerState, InventoryContainer, AgentContainerEvent } from '@homelab-manager/agent/types/protocol';

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
