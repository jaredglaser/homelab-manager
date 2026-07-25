import type Dockerode from 'dockerode';
import { subscribe as broadcasterSubscribe } from '../lib/docker-events-broadcaster';
import type { MinimalContainerInfo, BroadcasterEvent } from '../lib/docker-events-broadcaster';
import { createSseStream } from '../lib/sse-stream';
import type {
  AgentContainerEvent,
  ContainerState,
  InventorySnapshotContainer,
  InventoryUpdateContainer,
} from '../types/protocol';

const KNOWN_CONTAINER_STATES = new Set<string>([
  'running', 'exited', 'paused', 'restarting', 'created', 'dead', 'removing',
]);

/** Normalize a Docker state string to our typed ContainerState. */
function toContainerState(raw: string): ContainerState {
  return KNOWN_CONTAINER_STATES.has(raw) ? (raw as ContainerState) : 'unknown';
}

/** Snapshot shape: includes labels, emitted on `init`. */
function toSnapshotContainer(c: MinimalContainerInfo): InventorySnapshotContainer {
  const rawName = c.Names?.[0] ?? c.Id;
  return {
    id: c.Id,
    name: rawName.replace(/^\//, ''),
    image: c.Image,
    state: toContainerState(c.State),
    labels: c.Labels ?? {},
    startedAt: c.StartedAt,
    finishedAt: c.FinishedAt,
    exitCode: c.ExitCode,
    ports: c.Ports,
    mounts: c.Mounts,
  };
}

function toUpdateContainer(c: MinimalContainerInfo): InventoryUpdateContainer {
  const rawName = c.Names?.[0] ?? c.Id;
  return {
    id: c.Id,
    name: rawName.replace(/^\//, ''),
    image: c.Image,
    state: toContainerState(c.State),
    labels: c.Labels ?? {},
    startedAt: c.StartedAt,
    finishedAt: c.FinishedAt,
    exitCode: c.ExitCode,
    ports: c.Ports,
    mounts: c.Mounts,
  };
}

/**
 * Create an SSE Response that streams container inventory events for ALL containers
 * (running, stopped, paused, etc., both compose and non-compose).
 *
 * On connect, an `init` event is emitted with all currently known containers, then
 * incremental `upsert` and `destroy` events follow as containers change.
 *
 * SSE event shape (one JSON message per `data:` line):
 * ```
 * data: {"op":"init","containers":[...]}
 * data: {"op":"upsert","container":{...}}
 * data: {"op":"destroy","containerId":"abc123"}
 * ```
 *
 * @param docker - Dockerode client used to interact with the Docker daemon
 * @param request - The HTTP request; its abort signal triggers cleanup
 */
export function handleContainerEvents(docker: Dockerode, request: Request): Response {
  return createSseStream(request, {
    onStart: async (emit) =>
      broadcasterSubscribe(docker, (event: BroadcasterEvent) => {
        let message: AgentContainerEvent;

        if (event.op === 'init') {
          message = {
            op: 'init',
            containers: event.containers.map(toSnapshotContainer),
          };
        } else if (event.op === 'upsert') {
          message = {
            op: 'upsert',
            container: toUpdateContainer(event.container),
          };
        } else {
          message = { op: 'destroy', containerId: event.containerId };
        }

        emit.data(message);
      }),
  });
}
