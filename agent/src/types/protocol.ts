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
  /** Manifest digest the image was pulled by; null for locally built images. Defaulted so an old agent streaming to a new worker still validates. */
  imageDigest: z.string().nullable().default(null),
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

export const zComposeAction = z.enum(['deploy', 'update', 'teardown', 'restart', 'start', 'stop']);
export type ComposeAction = z.infer<typeof zComposeAction>;

export const zComposePhase = z.enum(['prepare', 'pull', 'up', 'down', 'restart', 'start', 'stop']);
export type ComposePhase = z.infer<typeof zComposePhase>;

/** The largest SSE frame the manager will accept from the agent, framing included. */
export const COMPOSE_MAX_FRAME_BYTES = 64 * 1024;

const zSeq = z.number().int().positive();
const zCount = z.number().int().nonnegative();

export const zComposeStartFrame = z.object({
  v: z.literal(1),
  runId: z.string(),
  action: zComposeAction,
  stack: z.string(),
});
export type ComposeStartFrame = z.infer<typeof zComposeStartFrame>;

export const zComposePhaseFrame = z.object({
  seq: zSeq,
  phase: zComposePhase,
  timeoutMs: zCount.optional(),
});
export type ComposePhaseFrame = z.infer<typeof zComposePhaseFrame>;

export const zComposeLineFrame = z.object({
  seq: zSeq,
  stream: z.enum(['stdout', 'stderr']),
  text: z.string(),
  truncated: z.literal(true).optional(),
});
export type ComposeLineFrame = z.infer<typeof zComposeLineFrame>;

/** `code` stays a plain string so a code the manager does not know still parses. Narrow it with `isAgentRouteFailureCode`. */
export const zComposeResultFrame = z.object({
  seq: zSeq,
  status: z.enum(['success', 'failed']),
  exitCode: z.number().int().nullable(),
  timedOut: z.boolean(),
  timeoutMs: zCount.optional(),
  failedPhase: zComposePhase.optional(),
  code: z.string().optional(),
  detail: z.string().optional(),
  /** Lines dropped by the caps only. Output lost because a pipe never closed is not counted here, see `outputIncomplete`. */
  droppedLines: zCount,
  /** UTF-8 bytes of line text not delivered: whole dropped lines plus the overflow cut off lines over 4096 characters. Caps only, like `droppedLines`. */
  droppedBytes: zCount,
  /** The runner stopped waiting on a pipe that never closed, so some output may be missing without being counted in `droppedLines`. */
  outputIncomplete: z.literal(true).optional(),
  tail: z
    .array(z.object({ stream: z.enum(['stdout', 'stderr']), text: z.string(), truncated: z.literal(true).optional() }))
    .max(100)
    .optional(),
});
export type ComposeResultFrame = z.infer<typeof zComposeResultFrame>;

/** SSE event name to payload schema for POST /stacks/{deploy,update,teardown,restart,start,stop} with `Accept: text/event-stream`. */
export const zComposeFrames = {
  start: zComposeStartFrame,
  phase: zComposePhaseFrame,
  line: zComposeLineFrame,
  result: zComposeResultFrame,
} as const;

export type ComposeFrameEvent =
  | { event: 'phase'; data: ComposePhaseFrame }
  | { event: 'line'; data: ComposeLineFrame }
  | { event: 'result'; data: ComposeResultFrame };

/** A byte count as decimal digits: pool sizes can pass 2^53, which a JSON number cannot carry exactly. */
const zZfsByteCount = z.string().regex(/^\d+$/);
const zZfsRate = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const zZfsCapacity = z.object({
  allocBytes: zZfsByteCount,
  freeBytes: zZfsByteCount,
});
export type ZfsCapacity = z.infer<typeof zZfsCapacity>;

/** Per-second rates over the sample interval. */
export const zZfsIo = z.object({
  readOps: zZfsRate,
  writeOps: zZfsRate,
  readBytes: zZfsRate,
  writeBytes: zZfsRate,
});
export type ZfsIo = z.infer<typeof zZfsIo>;

export const ZFS_GROUP_KINDS = ['special', 'dedup', 'logs', 'cache', 'spares'] as const;
export const zZfsGroupKind = z.enum(ZFS_GROUP_KINDS);
export type ZfsGroupKind = z.infer<typeof zZfsGroupKind>;

/** `capacity` is null where zpool reports none (leaf devices, spares). `io` is null for spares, which zpool iostat never reports. */
export const zZfsDisk = z.object({
  kind: z.literal('disk'),
  name: z.string().min(1),
  capacity: zZfsCapacity.nullable(),
  io: zZfsIo.nullable(),
});
export type ZfsDisk = z.infer<typeof zZfsDisk>;

export const zZfsVdev = z.object({
  kind: z.literal('vdev'),
  name: z.string().min(1),
  capacity: zZfsCapacity.nullable(),
  io: zZfsIo.nullable(),
  get children() {
    return z.array(zZfsDevice).min(1);
  },
});
export type ZfsVdev = z.infer<typeof zZfsVdev>;

export const zZfsDevice: z.ZodDiscriminatedUnion<[typeof zZfsDisk, typeof zZfsVdev]> = z.discriminatedUnion('kind', [zZfsDisk, zZfsVdev]);
export type ZfsDevice = z.infer<typeof zZfsDevice>;

export const zZfsGroup = z.object({
  kind: z.literal('group'),
  group: zZfsGroupKind,
  children: z.array(zZfsDevice).min(1),
});
export type ZfsGroup = z.infer<typeof zZfsGroup>;

export const zZfsPool = z.object({
  name: z.string().min(1),
  capacity: zZfsCapacity,
  io: zZfsIo,
  children: z.array(z.discriminatedUnion('kind', [zZfsDisk, zZfsVdev, zZfsGroup])),
});
export type ZfsPool = z.infer<typeof zZfsPool>;

/** One `data:` frame per `zpool iostat` sample on GET /zfs/stats/stream, carrying every imported pool. */
export const zZfsStatsFrame = z.object({
  v: z.literal(1),
  /** Epoch ms when the sample was read. */
  time: z.number().int().positive(),
  pools: z.array(zZfsPool),
});
export type ZfsStatsFrame = z.infer<typeof zZfsStatsFrame>;

/** The `{ line, timestamp }` frame agents sent before `zZfsStatsFrame`. Recognized only to tell the operator to update the agent. */
export function isLegacyZfsLineFrame(frame: unknown): boolean {
  return z.object({ line: z.string() }).safeParse(frame).success;
}
