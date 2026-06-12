import type Dockerode from 'dockerode';
import { subscribe as broadcasterSubscribe } from '../lib/docker-events-broadcaster';
import type { MinimalContainerInfo, BroadcasterEvent } from '../lib/docker-events-broadcaster';
import { sendSSE, startSseHeartbeat } from '../lib/sse-utils';
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
 * @param heartbeatIntervalMs - Comment ping period in milliseconds (default: 25s)
 */
export async function handleContainerEvents(
  docker: Dockerode,
  request: Request,
  heartbeatIntervalMs?: number,
): Promise<Response> {
  const encoder = new TextEncoder();
  const closed = { value: false };
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let stopHeartbeat: () => void = () => {};

      request.signal.addEventListener('abort', () => {
        closed.value = true;
        stopHeartbeat();
        unsubscribe?.();
        try {
          controller.close();
        } catch {}
      });

      if (request.signal.aborted) {
        closed.value = true;
        try {
          controller.close();
        } catch {}
        return;
      }

      // Inventory events only fire on container state changes, which can be
      // hours apart; a comment ping keeps proxies and Bun's idleTimeout from
      // killing the quiet stream.
      stopHeartbeat = startSseHeartbeat(
        controller,
        encoder,
        () => closed.value,
        heartbeatIntervalMs,
      );

      const sub = await broadcasterSubscribe(docker, (event: BroadcasterEvent) => {
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

        sendSSE(controller, encoder, closed, JSON.stringify(message));
      });

      // If abort fired while subscribe was pending, the abort handler saw a
      // null unsubscribe. Tear down the late subscriber ourselves.
      if (closed.value) {
        sub();
        return;
      }

      unsubscribe = sub;
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
