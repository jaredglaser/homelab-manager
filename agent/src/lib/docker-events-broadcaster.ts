import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 32_000;

/** Actions that trigger state updates. */
const RELEVANT_ACTIONS = new Set(['start', 'stop', 'die', 'restart', 'create', 'destroy', 'pause', 'unpause']);

/** Minimal shape stored in the in-memory map. Avoids force-casting to the full Dockerode.ContainerInfo. */
export interface MinimalContainerInfo {
  Id: string;
  Names: string[];
  State: string;
  Image: string;
  Labels: Record<string, string>;
}

export type BroadcasterEvent =
  | { op: 'init'; containers: MinimalContainerInfo[] }
  | { op: 'upsert'; container: MinimalContainerInfo }
  | { op: 'destroy'; containerId: string };

export interface DockerEventMessage {
  Type?: string;
  Action?: string;
  Actor?: { ID?: string; Attributes?: Record<string, string> };
  id?: string;
  status?: string;
}

interface BroadcasterState {
  /** All containers, keyed by container ID. Populated from listContainers({ all: true }) on first subscribe. */
  containers: Map<string, MinimalContainerInfo>;
  subscribers: Set<(event: BroadcasterEvent) => void>;
  eventsStream: Readable | null;
  /** True while a reconnect is in progress or scheduled. */
  reconnecting: boolean;
  /** Pending reconnect timer, if any. */
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  /** The docker instance used by the current subscription. */
  docker: Dockerode | null;
  /** Consecutive reconnect failures for backoff calculation. */
  reconnectFailures: number;
}

const state: BroadcasterState = {
  containers: new Map(),
  subscribers: new Set(),
  eventsStream: null,
  reconnecting: false,
  reconnectTimer: null,
  docker: null,
  reconnectFailures: 0,
};

function broadcastToAll(event: BroadcasterEvent): void {
  for (const cb of state.subscribers) {
    cb(event);
  }
}

/**
 * Compute exponential backoff delay.
 * Base 500ms, doubles each failure, capped at 32s.
 */
function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** failures, BACKOFF_CAP_MS);
}

async function handleDockerEvent(event: DockerEventMessage): Promise<void> {
  const eventType = event.Type;
  const action = event.Action;
  const containerId = event.Actor?.ID ?? event.id;

  if (eventType !== 'container') return;
  if (!action || !RELEVANT_ACTIONS.has(action)) return;
  if (!containerId) return;

  if (action === 'destroy') {
    state.containers.delete(containerId);
    broadcastToAll({ op: 'destroy', containerId });
    return;
  }

  const docker = state.docker;
  if (!docker) return;

  try {
    const inspectData = await docker.getContainer(containerId).inspect();
    const containerInfo: MinimalContainerInfo = {
      Id: inspectData.Id,
      Names: [inspectData.Name],
      State: inspectData.State?.Status ?? 'unknown',
      Image: inspectData.Config?.Image ?? '',
      Labels: inspectData.Config?.Labels ?? {},
    };
    state.containers.set(containerId, containerInfo);
    broadcastToAll({ op: 'upsert', container: containerInfo });
  } catch (err: unknown) {
    if (typeof err === 'object' && err !== null && 'statusCode' in err && (err as { statusCode: number }).statusCode === 404) {
      state.containers.delete(containerId);
      broadcastToAll({ op: 'destroy', containerId });
    } else {
      // Treat non-404 errors as transient — do not update state or broadcast.
      // The next event for this container will retry naturally.
      const statusCode = (typeof err === 'object' && err !== null && 'statusCode' in err)
        ? (err as { statusCode: number }).statusCode
        : undefined;
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[DockerEventsBroadcaster] Transient inspect error after '${action}' for ${containerId}:`, { action, containerId, statusCode, message });
    }
  }
}

function scheduleReconnect(docker: Dockerode): void {
  state.reconnecting = true;
  const delay = backoffDelay(state.reconnectFailures);
  const isFirstFailure = state.reconnectFailures === 0;
  const isLogInterval = state.reconnectFailures % 10 === 0 && state.reconnectFailures > 0;

  if (isFirstFailure) {
    console.error(`[DockerEventsBroadcaster] Events stream disconnected, reconnecting (attempt 1, delay ${delay}ms)`);
  } else if (isLogInterval) {
    console.warn(`[DockerEventsBroadcaster] Still reconnecting after ${state.reconnectFailures} attempts (delay ${delay}ms)`);
  } else {
    console.debug(`[DockerEventsBroadcaster] Reconnect attempt ${state.reconnectFailures + 1} (delay ${delay}ms)`);
  }

  state.reconnectFailures++;
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null;
    state.reconnecting = false; // Clear before calling startEventsSubscription
    if (state.subscribers.size === 0) {
      return;
    }
    await startEventsSubscription(docker, true);
  }, delay);
}

async function startEventsSubscription(docker: Dockerode, isReconnect = false): Promise<void> {
  if (state.reconnecting && !state.reconnectTimer) return;
  state.reconnecting = true;

  try {
    const stream = await docker.getEvents({
      filters: { type: ['container'] },
    }) as unknown as Readable;

    // On reconnect, rebuild state from a fresh container list and emit a new init
    // so subscribers catch up on any events missed during the outage.
    if (isReconnect) {
      try {
        const freshList = await docker.listContainers({ all: true });
        state.containers.clear();
        for (const c of freshList) {
          state.containers.set(c.Id, c as unknown as MinimalContainerInfo);
        }
        broadcastToAll({ op: 'init', containers: [...state.containers.values()] });
      } catch (listErr) {
        console.error('[DockerEventsBroadcaster] Failed to refresh container list on reconnect:', listErr);
      }
    }

    state.eventsStream = stream;
    state.reconnecting = false;
    state.reconnectFailures = 0; // Reset on success

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
          console.warn('[DockerEventsBroadcaster] Dropped malformed SSE frame:', line.slice(0, 200));
          continue;
        }
        handleDockerEvent(event).catch((err) => {
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
  } catch (err) {
    console.error('Failed to subscribe to Docker events:', err);
    state.eventsStream = null;
    scheduleReconnect(docker);
  }
}

/**
 * Subscribe to all Docker container lifecycle events.
 *
 * The callback immediately receives an `init` event with the current container
 * snapshot, then receives `upsert` and `destroy` events as containers change.
 *
 * Returns an unsubscribe function. When all subscribers unsubscribe, the shared
 * Docker events stream is torn down automatically.
 */
export async function subscribe(
  docker: Dockerode,
  callback: (event: BroadcasterEvent) => void,
): Promise<() => void> {
  // Populate the in-memory map if this is the first subscriber.
  // Preserve any entries already set by concurrent events that arrived during listContainers.
  if (state.subscribers.size === 0) {
    try {
      const allContainers = await docker.listContainers({ all: true });
      for (const c of allContainers) {
        if (!state.containers.has(c.Id)) {
          state.containers.set(c.Id, c);
        }
      }
    } catch (err) {
      console.error('Failed to list containers during broadcaster init:', err);
    }
  }

  state.subscribers.add(callback);
  state.docker = docker;

  // Send the current snapshot to this subscriber immediately.
  callback({ op: 'init', containers: [...state.containers.values()] });

  // Start the shared Docker events stream if not already running.
  if (!state.eventsStream && !state.reconnecting) {
    await startEventsSubscription(docker);
  }

  return function unsubscribe(): void {
    state.subscribers.delete(callback);
    if (state.subscribers.size === 0) {
      if (state.reconnectTimer) {
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = null;
      }
      if (state.eventsStream) {
        state.eventsStream.destroy?.();
        state.eventsStream = null;
      }
      state.reconnecting = false;
      state.reconnectFailures = 0;
      state.docker = null;
    }
  };
}

/** Reset shared singleton state. Intended for use in tests only. */
export function _resetBroadcasterForTesting(): void {
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
  state.reconnectFailures = 0;
  state.docker = null;
}

/**
 * Simulate a Docker event flowing through the broadcaster. Intended for tests only.
 * The docker parameter is accepted for API compatibility with callers that pass a
 * Dockerode instance — state.docker is used internally (already set by subscribe()).
 */
export async function _handleDockerEventForTesting(
  _docker: Dockerode,
  event: DockerEventMessage,
): Promise<void> {
  return handleDockerEvent(event);
}
