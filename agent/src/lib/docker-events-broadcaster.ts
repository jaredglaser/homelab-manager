import type { Readable } from 'node:stream';
import type Dockerode from 'dockerode';

const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 32_000;

/** Docker's sentinel for an unset timestamp. Normalized to null. */
const ZERO_TIMESTAMP = '0001-01-01T00:00:00Z';

/** States in which ExitCode is meaningful. Docker returns 0 while running, which is misleading. */
const TERMINAL_STATES = new Set(['exited', 'dead']);

/** Actions that trigger state updates. */
const RELEVANT_ACTIONS = new Set(['start', 'stop', 'die', 'restart', 'create', 'destroy', 'pause', 'unpause']);

/** Minimal shape stored in the in-memory map. Avoids force-casting to the full Dockerode.ContainerInfo. */
export interface MinimalContainerInfo {
  Id: string;
  Names: string[];
  State: string;
  Image: string;
  Labels: Record<string, string>;
  StartedAt: string | null;
  FinishedAt: string | null;
  ExitCode: number | null;
}

function normalizeTimestamp(value: string | null | undefined): string | null {
  if (!value || value === ZERO_TIMESTAMP) return null;
  return value;
}

function normalizeExitCode(state: string, exitCode: number | null | undefined): number | null {
  if (!TERMINAL_STATES.has(state)) return null;
  return typeof exitCode === 'number' ? exitCode : null;
}

function buildFromInspect(inspectData: Dockerode.ContainerInspectInfo): MinimalContainerInfo {
  const state = inspectData.State?.Status ?? 'unknown';
  return {
    Id: inspectData.Id,
    Names: [inspectData.Name],
    State: state,
    Image: inspectData.Config?.Image ?? '',
    Labels: inspectData.Config?.Labels ?? {},
    StartedAt: normalizeTimestamp(inspectData.State?.StartedAt),
    FinishedAt: normalizeTimestamp(inspectData.State?.FinishedAt),
    ExitCode: normalizeExitCode(state, inspectData.State?.ExitCode),
  };
}

function buildFromListEntry(c: Dockerode.ContainerInfo): MinimalContainerInfo {
  return {
    Id: c.Id,
    Names: c.Names,
    State: c.State,
    Image: c.Image,
    Labels: c.Labels,
    StartedAt: null,
    FinishedAt: null,
    ExitCode: null,
  };
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
    try {
      cb(event);
    } catch (err) {
      console.error('[DockerEventsBroadcaster] Subscriber callback threw:', err);
    }
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
    const containerInfo = buildFromInspect(inspectData);
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

/**
 * List all containers and enrich each with inspect() in parallel so we can
 * populate StartedAt/FinishedAt/ExitCode (not available from listContainers).
 * If an individual inspect fails, fall back to the listContainers fields for
 * that container with null timestamps/exit code — don't fail the whole init.
 */
async function listAndEnrichContainers(docker: Dockerode): Promise<MinimalContainerInfo[]> {
  const listed = await docker.listContainers({ all: true });
  const enriched = await Promise.all(
    listed.map(async (c): Promise<MinimalContainerInfo> => {
      try {
        const inspectData = await docker.getContainer(c.Id).inspect();
        return buildFromInspect(inspectData);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[DockerEventsBroadcaster] Inspect failed for ${c.Id} during init, using listContainers fallback:`, message);
        return buildFromListEntry(c);
      }
    }),
  );
  return enriched;
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
  state.reconnecting = true;

  try {
    const stream = await docker.getEvents({
      filters: { type: ['container'] },
    }) as unknown as Readable;

    // On reconnect, rebuild state from a fresh container list and emit a new init
    // so subscribers catch up on any events missed during the outage.
    if (isReconnect) {
      try {
        const freshList = await listAndEnrichContainers(docker);
        state.containers.clear();
        for (const c of freshList) {
          state.containers.set(c.Id, c);
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
  // Register synchronously before any await so concurrent subscribe() calls
  // see a non-zero size and skip the bootstrap.
  const isFirst = state.subscribers.size === 0;
  state.subscribers.add(callback);
  state.docker = docker;

  if (isFirst) {
    try {
      const allContainers = await listAndEnrichContainers(docker);
      for (const c of allContainers) {
        // Preserve entries set by events that arrived during listContainers.
        if (!state.containers.has(c.Id)) {
          state.containers.set(c.Id, c);
        }
      }
    } catch (err) {
      console.error('Failed to list containers during broadcaster init:', err);
    }
  }

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
