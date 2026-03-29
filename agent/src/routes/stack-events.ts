import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const RECONNECT_DELAY_MS = 5_000;

/** Actions that trigger state updates. Hoisted to avoid re-allocation per event. */
const RELEVANT_ACTIONS = new Set(['start', 'stop', 'die', 'restart', 'create', 'destroy']);

/** Minimal shape we store in memory — avoids force-casting to the full Dockerode.ContainerInfo. */
export interface MinimalContainerInfo {
  Id: string;
  Names: string[];
  State: string;
  Image: string;
  Labels: Record<string, string>;
}

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

/** Enqueue an SSE data event, silently swallowing enqueue-after-close TypeError. */
export function _sendSSE(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  closed: { value: boolean },
  data: string,
): void {
  if (closed.value) return;
  try {
    controller.enqueue(encoder.encode(`data: ${data}\n\n`));
  } catch (err) {
    if (!(err instanceof TypeError)) console.error('Unexpected error during SSE enqueue:', err);
  }
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

/** Shared singleton state across all SSE clients. */
interface EventsState {
  /** All compose-labelled containers, keyed by container ID. */
  containers: Map<string, MinimalContainerInfo>;
  /** Active SSE subscriber callbacks. */
  subscribers: Set<(snapshot: StackSnapshot) => void>;
  /** The active Docker events stream, if any. */
  eventsStream: Readable | null;
  /** True while a reconnect loop is running. */
  reconnecting: boolean;
  /** Pending reconnect timer, if any. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

const state: EventsState = {
  containers: new Map(),
  subscribers: new Set(),
  eventsStream: null,
  reconnecting: false,
  reconnectTimer: null,
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
 * Handle a single Docker event by updating in-memory state and broadcasting
 * the affected stack snapshot. Non-compose containers are silently ignored.
 */
export async function _handleDockerEvent(docker: Dockerode, event: DockerEventMessage): Promise<void> {
  const eventType = event.Type;
  const action = event.Action;
  const containerId = event.Actor?.ID ?? event.id;

  if (eventType !== 'container') return;

  if (!action || !RELEVANT_ACTIONS.has(action)) return;
  if (!containerId) return;

  if (action === 'destroy') {
    const existing = state.containers.get(containerId);
    const stackName = existing ? _getStackName(existing) : null;
    state.containers.delete(containerId);
    if (stackName) _broadcastStack(stackName);
    return;
  }

  // For other actions, refresh container info from Docker
  try {
    const inspectData = await docker.getContainer(containerId).inspect();
    const stackName = inspectData.Config?.Labels?.[COMPOSE_PROJECT_LABEL] ?? null;
    if (stackName === null) {
      // Container lost its label somehow — remove it and move on
      state.containers.delete(containerId);
      return;
    }
    const containerInfo: MinimalContainerInfo = {
      Id: inspectData.Id,
      Names: [inspectData.Name],
      State: inspectData.State?.Status ?? 'unknown',
      Image: inspectData.Config?.Image ?? '',
      Labels: inspectData.Config?.Labels ?? {},
    };
    state.containers.set(containerId, containerInfo);
    _broadcastStack(stackName);
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
      // Container was removed — clean up
      const existing = state.containers.get(containerId);
      const stackName = existing ? _getStackName(existing) : null;
      state.containers.delete(containerId);
      if (stackName) _broadcastStack(stackName);
    } else {
      console.error(`Failed to refresh container info after '${action}' event for ${containerId}:`, err);
    }
  }
}

export interface DockerEventMessage {
  Type?: string;
  Action?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  id?: string;
  status?: string;
}

/**
 * Subscribe to Docker events and fan out to all SSE subscribers.
 * Automatically re-subscribes after disconnect.
 */
async function ensureEventsSubscription(docker: Dockerode): Promise<void> {
  if (state.reconnecting) return;
  state.reconnecting = true;

  const subscribe = async (): Promise<void> => {
    try {
      const stream = await docker.getEvents({
        filters: { type: ['container'] },
      }) as unknown as Readable;

      state.eventsStream = stream;

      let buffer = '';
      stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let newlineIdx;
        while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newlineIdx).trim();
          buffer = buffer.slice(newlineIdx + 1);
          if (!line) continue;
          let event: DockerEventMessage;
          try {
            event = JSON.parse(line);
          } catch {
            // Skip malformed event frames
            continue;
          }
          _handleDockerEvent(docker, event).catch((err) => {
            console.error('Error handling Docker event:', err);
          });
        }
      });

      stream.on('error', (err: Error) => {
        console.error('Docker events stream error:', err.message);
        state.eventsStream = null;
        scheduleReconnect(docker);
      });

      stream.on('end', () => {
        state.eventsStream = null;
        if (state.subscribers.size > 0) {
          scheduleReconnect(docker);
        } else {
          state.reconnecting = false;
        }
      });

      state.reconnecting = false;
    } catch (err) {
      console.error('Failed to subscribe to Docker events:', err);
      state.eventsStream = null;
      scheduleReconnect(docker);
    }
  };

  await subscribe();
}

function scheduleReconnect(docker: Dockerode): void {
  state.reconnecting = true;
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    if (state.subscribers.size === 0) {
      state.reconnecting = false;
      return;
    }
    await ensureEventsSubscription(docker);
  }, RECONNECT_DELAY_MS);
}

/**
 * Create an SSE Response that streams Docker container lifecycle events grouped by
 * compose stack.
 *
 * On connect, the current status of all known stacks is emitted immediately.
 * Subsequent events are emitted whenever a container lifecycle event (start, stop,
 * die, restart, create, destroy) affects a compose-labelled container.
 *
 * A single Docker events subscription is shared across all connected clients. The
 * subscription is started on first client connection and reconnects automatically
 * after Docker daemon disconnects.
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
        _sendSSE(controller, encoder, closed, JSON.stringify(snapshot));
      };

      request.signal.addEventListener('abort', () => {
        closed.value = true;
        state.subscribers.delete(send);
        if (state.subscribers.size === 0 && state.eventsStream) {
          state.eventsStream.destroy?.();
          state.eventsStream = null;
          state.reconnecting = false;
        }
        try {
          controller.close();
        } catch {
          // controller already closed
        }
      });

      // Populate initial container state, preserving any entries already set by
      // concurrent Docker events that arrived while listContainers was in-flight.
      try {
        const allContainers = await docker.listContainers({ all: true });
        for (const c of allContainers) {
          if (_getStackName(c) !== null && !state.containers.has(c.Id)) {
            state.containers.set(c.Id, c);
          }
        }
      } catch (err) {
        console.error('Failed to list containers on initial connection:', err);
      }

      // Register subscriber before sending initial snapshots to avoid race
      state.subscribers.add(send);

      // Emit current status of all known stacks immediately
      const stackMap = _buildStackMap([...state.containers.values()]);
      for (const [stackName, containers] of stackMap) {
        const snapshot: StackSnapshot = {
          stack: stackName,
          containers: containers.map(_toSnapshot),
        };
        _sendSSE(controller, encoder, closed, JSON.stringify(snapshot));
      }

      // Ensure shared Docker events subscription is active
      if (!state.eventsStream && !state.reconnecting) {
        await ensureEventsSubscription(docker);
      }
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
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }
  if (state.eventsStream) {
    state.eventsStream.destroy?.();
    state.eventsStream = null;
  }
  state.containers.clear();
  state.subscribers.clear();
  state.reconnecting = false;
}
