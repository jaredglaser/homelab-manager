/**
 * Wire-protocol types shared by the agent and the web app.
 * The agent emits these over the `/containers/events` SSE stream;
 * the web side consumes them via the `@homelab-manager/agent` path alias.
 *
 * Schemas and types live together: types are inferred via `z.infer<...>` so a
 * change to a schema cannot drift from its type.
 *
 * Discriminated union note: both `InventorySnapshotContainer` (from `init`)
 * and `InventoryUpdateContainer` (from `upsert`) carry the full `labels` map.
 * `zInventoryUpdateContainer` is an alias for `zInventorySnapshotContainer` —
 * the agent enriches every Docker event with a full inspect() call so labels
 * are always available at the agent→worker streaming layer.
 */

import { z } from 'zod';

export const zContainerState = z.enum([
  'running',
  'exited',
  'paused',
  'restarting',
  'created',
  'dead',
  'removing',
  'unknown',
]);
export type ContainerState = z.infer<typeof zContainerState>;

export const zContainerPort = z.object({
  containerPort: z.number(),
  protocol: z.string(),
  hostIp: z.string().nullable(),
  hostPort: z.number().nullable(),
});
export type ContainerPort = z.infer<typeof zContainerPort>;

export const zContainerMount = z.object({
  type: z.string(),
  source: z.string(),
  destination: z.string(),
  rw: z.boolean(),
});
export type ContainerMount = z.infer<typeof zContainerMount>;

/**
 * Snapshot shape: emitted only on `op: 'init'`, sourced from `listContainers`
 * + inspect(). Labels are populated with real values.
 */
export const zInventorySnapshotContainer = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  state: zContainerState,
  labels: z.record(z.string(), z.string()),
  /** ISO timestamp; null when the container has not yet started. */
  startedAt: z.string().nullable(),
  /** ISO timestamp; null when the container is still running. */
  finishedAt: z.string().nullable(),
  /** Only meaningful when state is 'exited' or 'dead'. */
  exitCode: z.number().nullable(),
  ports: z.array(zContainerPort).default([]),
  mounts: z.array(zContainerMount).default([]),
});
export type InventorySnapshotContainer = z.infer<typeof zInventorySnapshotContainer>;

/**
 * Update shape: emitted on `op: 'upsert'`. Includes labels because the agent
 * augments each Docker event with a full inspect(), which has the label map.
 * The downstream NOTIFY omits labels (8 kB cap), but that path uses the
 * generated `compose_project` column derived from labels in the DB row, so
 * labels only need to be correct at the time of the DB insert.
 */
export const zInventoryUpdateContainer = zInventorySnapshotContainer;
export type InventoryUpdateContainer = z.infer<typeof zInventoryUpdateContainer>;

export const zAgentContainerEvent = z.discriminatedUnion('op', [
  z.object({ op: z.literal('init'), containers: z.array(zInventorySnapshotContainer) }),
  z.object({ op: z.literal('upsert'), container: zInventoryUpdateContainer }),
  z.object({ op: z.literal('destroy'), containerId: z.string() }),
]);
export type AgentContainerEvent = z.infer<typeof zAgentContainerEvent>;
