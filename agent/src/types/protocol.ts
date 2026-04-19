/**
 * Wire-protocol types shared by the agent and the web app.
 * The agent emits these over the `/containers/events` SSE stream;
 * the web side consumes them via the `@homelab-manager/agent` path alias.
 *
 * Schemas and types live together: types are inferred via `z.infer<...>` so a
 * change to a schema cannot drift from its type.
 *
 * Discriminated union note: `InventorySnapshotContainer` (from `init`) carries
 * the full container `labels` map; `InventoryUpdateContainer` (from `upsert`)
 * omits labels because the upsert-generating paths (NOTIFY trigger, Docker
 * event stream) do not carry them. Consumers that need labels must narrow to
 * the snapshot shape via the event discriminator (`op: 'init'`).
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
});
export type InventorySnapshotContainer = z.infer<typeof zInventorySnapshotContainer>;

/**
 * Update shape: emitted on `op: 'upsert'`. Labels are intentionally absent —
 * the Docker event stream does not deliver them, and the NOTIFY payload
 * downstream omits them (8 kB cap). Callers that need labels must fetch from
 * the snapshot path (init / DB).
 */
export const zInventoryUpdateContainer = zInventorySnapshotContainer.omit({ labels: true });
export type InventoryUpdateContainer = z.infer<typeof zInventoryUpdateContainer>;

export const zAgentContainerEvent = z.discriminatedUnion('op', [
  z.object({ op: z.literal('init'), containers: z.array(zInventorySnapshotContainer) }),
  z.object({ op: z.literal('upsert'), container: zInventoryUpdateContainer }),
  z.object({ op: z.literal('destroy'), containerId: z.string() }),
]);
export type AgentContainerEvent = z.infer<typeof zAgentContainerEvent>;
