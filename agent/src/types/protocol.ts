/**
 * Wire-protocol types shared by the agent and the web app.
 * The agent emits these over the `/containers/events` SSE stream;
 * the web side consumes them via the `@homelab-manager/agent` path alias.
 */

export type ContainerState =
  | 'running'
  | 'exited'
  | 'paused'
  | 'restarting'
  | 'created'
  | 'dead'
  | 'removing'
  | 'unknown';

export interface InventoryContainer {
  id: string;
  name: string;
  image: string;
  state: ContainerState;
  labels: Record<string, string>;
  /** ISO timestamp; null when the container has not yet started. */
  startedAt: string | null;
  /** ISO timestamp; null when the container is still running. */
  finishedAt: string | null;
  /** Only meaningful when state is 'exited' or 'dead'. */
  exitCode: number | null;
}

export type AgentContainerEvent =
  | { op: 'init'; containers: InventoryContainer[] }
  | { op: 'upsert'; container: InventoryContainer }
  | { op: 'destroy'; containerId: string };
