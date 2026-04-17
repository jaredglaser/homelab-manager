import type Dockerode from 'dockerode';
import { subscribe, _resetBroadcasterForTesting, _handleDockerEventForTesting } from '../lib/docker-events-broadcaster';
import type { MinimalContainerInfo, BroadcasterEvent } from '../lib/docker-events-broadcaster';
import { sendSSE } from '../lib/sse-utils';

export type { MinimalContainerInfo };

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

export interface ContainerSnapshot {
  id: string;
  name: string;
  status: string;
  image: string;
}

export interface StackSnapshot {
  stack: string;
  containers: ContainerSnapshot[];
}

/** @deprecated Import from sse-utils instead. Kept for test compatibility. */
export function _sendSSE(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  closed: { value: boolean },
  data: string,
): void {
  sendSSE(controller, encoder, closed, data);
}

/** Extract the compose project name from container labels, or null if not a compose container. */
export function _getStackName(container: MinimalContainerInfo): string | null {
  return container.Labels?.[COMPOSE_PROJECT_LABEL] ?? null;
}

/** Build a ContainerSnapshot from a MinimalContainerInfo. */
export function _toSnapshot(container: MinimalContainerInfo): ContainerSnapshot {
  const rawName = container.Names?.[0] ?? container.Id;
  return {
    id: container.Id,
    name: rawName.replace(/^\//, ''),
    status: container.State,
    image: container.Image,
  };
}

/** Build a map of stackName → MinimalContainerInfo[] from a flat container list. */
export function _buildStackMap(containers: MinimalContainerInfo[]): Map<string, MinimalContainerInfo[]> {
  const map = new Map<string, MinimalContainerInfo[]>();
  for (const c of containers) {
    const stack = _getStackName(c);
    if (stack === null) continue;
    const existing = map.get(stack);
    if (existing) {
      existing.push(c);
    } else {
      map.set(stack, [c]);
    }
  }
  return map;
}

/** Shared singleton state across all SSE clients for this route. */
interface EventsState {
  /** Compose-labelled containers known to this route, keyed by container ID. */
  containers: Map<string, MinimalContainerInfo>;
  /** Active SSE subscriber callbacks. */
  subscribers: Set<(snapshot: StackSnapshot) => void>;
}

const state: EventsState = {
  containers: new Map(),
  subscribers: new Set(),
};

/**
 * Rebuild the snapshot for one stack from current in-memory container state and
 * broadcast it to all subscribers.
 */
export function _broadcastStack(stackName: string): void {
  const stackContainers: ContainerSnapshot[] = [];
  for (const c of state.containers.values()) {
    if (_getStackName(c) === stackName) {
      stackContainers.push(_toSnapshot(c));
    }
  }
  const snapshot: StackSnapshot = { stack: stackName, containers: stackContainers };
  for (const cb of state.subscribers) {
    cb(snapshot);
  }
}

/**
 * Proxy to the broadcaster's test helper. Exposed so existing tests that call
 * `_handleDockerEvent(docker, event)` continue to work after the refactor.
 */
export async function _handleDockerEvent(docker: Dockerode, event: Parameters<typeof _handleDockerEventForTesting>[1]): Promise<void> {
  return _handleDockerEventForTesting(docker, event);
}

/**
 * Create an SSE Response that streams Docker container lifecycle events grouped by
 * compose stack.
 *
 * On connect, the current status of all known stacks is emitted immediately.
 * Subsequent events are emitted whenever a container lifecycle event (start, stop,
 * die, restart, create, destroy) affects a compose-labelled container.
 *
 * A single Docker events subscription is shared across all connected clients via the
 * docker-events-broadcaster. The broadcaster handles reconnection automatically.
 *
 * SSE event shape:
 * ```
 * data: {"stack":"plex","containers":[{"id":"abc123","name":"plex-server","status":"running","image":"plexinc/pms-docker"}]}
 * ```
 *
 * @param docker - Dockerode client used to interact with the Docker daemon
 * @param request - The HTTP request; its abort signal triggers cleanup
 */
export function handleStackEvents(docker: Dockerode, request: Request): Response {
  const encoder = new TextEncoder();
  const closed = { value: false };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (snapshot: StackSnapshot) => {
        sendSSE(controller, encoder, closed, JSON.stringify(snapshot));
      };

      let unsubscribeBroadcaster: (() => void) | null = null;

      request.signal.addEventListener('abort', () => {
        closed.value = true;
        state.subscribers.delete(send);
        unsubscribeBroadcaster?.();
        if (state.subscribers.size === 0) {
          state.containers.clear();
        }
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      });

      state.subscribers.add(send);

      unsubscribeBroadcaster = await subscribe(docker, (event: BroadcasterEvent) => {
        if (event.op === 'init') {
          for (const c of event.containers) {
            if (_getStackName(c) !== null) {
              state.containers.set(c.Id, c);
            }
          }
          // Emit current status of all known stacks to this subscriber only
          const stackMap = _buildStackMap([...state.containers.values()]);
          for (const [stackName, containers] of stackMap) {
            const snapshot: StackSnapshot = {
              stack: stackName,
              containers: containers.map(_toSnapshot),
            };
            sendSSE(controller, encoder, closed, JSON.stringify(snapshot));
          }
        } else if (event.op === 'upsert') {
          const stackName = _getStackName(event.container);
          if (stackName !== null) {
            state.containers.set(event.container.Id, event.container);
            _broadcastStack(stackName);
          }
        } else {
          const existing = state.containers.get(event.containerId);
          const stackName = existing ? _getStackName(existing) : null;
          state.containers.delete(event.containerId);
          if (stackName) _broadcastStack(stackName);
        }
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

/**
 * Reset shared singleton state. Intended for use in tests only.
 */
export function _resetStateForTesting(): void {
  state.containers.clear();
  state.subscribers.clear();
  _resetBroadcasterForTesting();
}
