/**
 * Domain types for the Docker container inventory pipeline.
 *
 * Agent → worker → `docker_container_events` hypertable → NOTIFY →
 * web broadcast service → `/api/docker-inventory` SSE → `useDockerInventory()` hook.
 *
 * Discriminated union note: both `init` and `upsert` frames carry the full
 * label map. The agent augments each Docker event with inspect() so labels are
 * always available at the streaming layer. The downstream PostgreSQL NOTIFY
 * excludes labels (8 kB cap) but uses the generated `compose_project` column
 * which is computed from labels at insert time.
 *
 * Schemas and types live together: types are inferred via `z.infer<...>` so a
 * change to a schema cannot drift from its type. The schemas validate the
 * NOTIFY payload at the web broadcast service boundary (and would run on any
 * other SSE consumer that parses broadcast frames directly).
 */

import { z } from 'zod';

export type {
  ContainerState,
  InventorySnapshotContainer,
  InventoryUpdateContainer,
  AgentContainerEvent,
} from '@homelab-manager/agent/types/protocol';

const zContainerStateWeb = z.enum([
  'running',
  'exited',
  'paused',
  'restarting',
  'created',
  'dead',
  'removing',
  'unknown',
]);

const zInventoryContainerBase = z.object({
  host: z.string(),
  containerId: z.string(),
  name: z.string(),
  image: z.string(),
  state: zContainerStateWeb,
  composeProject: z.string().nullable(),
  serviceKey: z.string(),
  startedAt: z.date().nullable(),
  finishedAt: z.date().nullable(),
  exitCode: z.number().nullable(),
  /** Timestamp of the last state-change event. */
  updatedAt: z.date(),
});

/**
 * Snapshot shape emitted on `type: 'init'`. Populated from the DB via
 * `getCurrentSnapshot()`; labels reflect the container's real label map.
 */
export const zDockerInventorySnapshotContainer = zInventoryContainerBase.extend({
  labels: z.record(z.string(), z.string()),
});
export type DockerInventorySnapshotContainer = z.infer<typeof zDockerInventorySnapshotContainer>;

/**
 * Update shape emitted on `type: 'upsert'`. Labels are intentionally absent:
 * the NOTIFY trigger in migration 018 omits them (8 kB cap on PG NOTIFY).
 * Consumers that need labels must narrow to the snapshot shape and fetch from
 * the init / DB path.
 */
export const zDockerInventoryUpdateContainer = zInventoryContainerBase;
export type DockerInventoryUpdateContainer = z.infer<typeof zDockerInventoryUpdateContainer>;

/** Events fanned out from `DockerInventoryBroadcastService` to SSE subscribers. */
export const zDockerInventoryBroadcastEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('init'), containers: z.array(zDockerInventorySnapshotContainer) }),
  z.object({ type: z.literal('upsert'), container: zDockerInventoryUpdateContainer }),
  z.object({ type: z.literal('destroy'), host: z.string(), containerId: z.string(), at: z.date() }),
]);
export type DockerInventoryBroadcastEvent = z.infer<typeof zDockerInventoryBroadcastEvent>;

