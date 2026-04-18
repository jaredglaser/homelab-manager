import type Dockerode from 'dockerode';
import { subscribe as broadcasterSubscribe } from '../lib/docker-events-broadcaster';
import type { MinimalContainerInfo, BroadcasterEvent } from '../lib/docker-events-broadcaster';
import { sendSSE } from '../lib/sse-utils';
import type { AgentContainerEvent, ContainerState, InventoryContainer } from '../types/protocol';

/** Normalize a Docker state string to our typed ContainerState. */
function toContainerState(raw: string): ContainerState {
  const known: ContainerState[] = [
    'running', 'exited', 'paused', 'restarting', 'created', 'dead', 'removing',
  ];
  return (known as string[]).includes(raw) ? (raw as ContainerState) : 'unknown';
}

/**
 * Convert a MinimalContainerInfo (from listContainers or inspect) to InventoryContainer.
 *
 * startedAt, finishedAt, and exitCode are not available from listContainers output —
 * they require an inspect call. To keep subscribe latency low, these are set to null
 * here. A future refinement can add a lightweight inspect-on-create to populate them.
 */
function toInventoryContainer(c: MinimalContainerInfo): InventoryContainer {
  const rawName = c.Names?.[0] ?? c.Id;
  return {
    id: c.Id,
    name: rawName.replace(/^\//, ''),
    image: c.Image,
    state: toContainerState(c.State),
    labels: c.Labels ?? {},
    startedAt: null,
    finishedAt: null,
    exitCode: null,
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
export async function handleContainerEvents(docker: Dockerode, request: Request): Promise<Response> {
  const encoder = new TextEncoder();
  const closed = { value: false };
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      request.signal.addEventListener('abort', () => {
        closed.value = true;
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      });

      unsubscribe = await broadcasterSubscribe(docker, (event: BroadcasterEvent) => {
        let message: AgentContainerEvent;

        if (event.op === 'init') {
          message = {
            op: 'init',
            containers: event.containers.map(toInventoryContainer),
          };
        } else if (event.op === 'upsert') {
          message = {
            op: 'upsert',
            container: toInventoryContainer(event.container),
          };
        } else {
          message = { op: 'destroy', containerId: event.containerId };
        }

        sendSSE(controller, encoder, closed, JSON.stringify(message));
      });
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
