/**
 * Domain types for the Docker container inventory pipeline.
 *
 * Agent → worker → `docker_container_events` hypertable → NOTIFY →
 * web broadcast service → `/api/docker-inventory` SSE → `useDockerInventory()` hook.
 *
 * Discriminated union note: on this web-broadcast layer the `init` frame
 * (`DockerInventorySnapshotContainer`) carries the full label map sourced from
 * the DB snapshot, while the `upsert` frame (`DockerInventoryUpdateContainer`)
 * intentionally omits labels because the PostgreSQL NOTIFY payload excludes
 * them (8 kB cap). Consumers that need labels must narrow on `type: 'init'` or
 * fetch from the DB. The agent→worker streaming layer (see `protocol.ts`) does
 * include labels in upsert frames so that `compose_project` is correctly stored
 * at insert time.
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

/** Duplicated from the agent protocol's `zContainerPort` to keep agent zod out of the client bundle. */
const zContainerPortWeb = z.object({
  containerPort: z.number(),
  protocol: z.string(),
  hostIp: z.string().nullable(),
  hostPort: z.number().nullable(),
});
export type ContainerPort = z.infer<typeof zContainerPortWeb>;

/** Duplicated from the agent protocol's `zContainerMount` to keep agent zod out of the client bundle. */
const zContainerMountWeb = z.object({
  type: z.string(),
  source: z.string(),
  destination: z.string(),
  rw: z.boolean(),
});
export type ContainerMount = z.infer<typeof zContainerMountWeb>;

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
  ports: z.array(zContainerPortWeb).default([]),
  /** Timestamp of the last state-change event. */
  updatedAt: z.date(),
});

/**
 * Snapshot shape emitted on `type: 'init'`. Populated from the DB via
 * `getCurrentSnapshot()`; labels and mounts reflect the container's real values.
 */
export const zDockerInventorySnapshotContainer = zInventoryContainerBase.extend({
  labels: z.record(z.string(), z.string()),
  mounts: z.array(zContainerMountWeb).default([]),
});
export type DockerInventorySnapshotContainer = z.infer<typeof zDockerInventorySnapshotContainer>;

/**
 * Update shape emitted on `type: 'upsert'`. Labels and mounts are intentionally absent:
 * the NOTIFY trigger in migration 026 omits them (8 kB cap on PG NOTIFY, mount paths
 * are unbounded). Consumers that need them must narrow to the snapshot shape and fetch
 * from the init / DB path.
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

