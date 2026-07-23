import type {
  AgentContainerEvent,
  ContainerState,
  ContainerPort,
  ContainerMount,
  InventorySnapshotContainer,
  InventoryUpdateContainer,
} from '@/types/docker-inventory';
import { zAgentContainerEvent } from '@homelab-manager/agent/types/protocol';
import type { DockerContainerEventRepository } from '@/lib/database/repositories/docker-container-event-repository';
import { computeServiceKey } from '@/lib/utils/docker-hierarchy-builder';
import { BaseCollector } from './base-collector';
import { connectAgentSseStream } from './agent-sse-stream';

/** Minimal host descriptor shared by agent-based collectors. */
export interface ManagedHostInfo {
  name: string;
  agentUrl: string;
}

/** Injectable connector so tests can supply parsed events without opening a byte stream. */
type StreamConnector = typeof connectAgentSseStream;

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Mirrors the agent's comparePorts (docker-events-broadcaster.ts) so canonical ordering agrees. */
function comparePorts(a: ContainerPort, b: ContainerPort): number {
  if (a.containerPort !== b.containerPort) return a.containerPort - b.containerPort;
  if (a.protocol !== b.protocol) return compareStrings(a.protocol, b.protocol);
  const aHostIp = a.hostIp ?? '';
  const bHostIp = b.hostIp ?? '';
  if (aHostIp !== bHostIp) return compareStrings(aHostIp, bHostIp);
  return (a.hostPort ?? -1) - (b.hostPort ?? -1);
}

/** Mirrors the agent's compareMounts (docker-events-broadcaster.ts) so canonical ordering agrees. */
function compareMounts(a: ContainerMount, b: ContainerMount): number {
  return compareStrings(a.destination, b.destination);
}

/** PostgreSQL jsonb does not preserve object key order, so a hydrated DB row's ports/mounts never
 * JSON.stringify-match a live SSE frame with the same content; canonicalize through sorted tuple
 * arrays (positional, not key-order dependent) instead. */
function computeDetailsFingerprint(ports: ContainerPort[], mounts: ContainerMount[]): string {
  const portTuples = [...ports].sort(comparePorts).map((p) => [p.containerPort, p.protocol, p.hostIp, p.hostPort]);
  const mountTuples = [...mounts].sort(compareMounts).map((m) => [m.type, m.source, m.destination, m.rw]);
  return JSON.stringify([portTuples, mountTuples]);
}

/** Per-container state held in memory to avoid redundant DB writes. */
interface CachedContainerState {
  state: ContainerState | null;
  eventType: 'upsert' | 'destroy';
  detailsFingerprint: string;
}

export class ContainerInventoryCollector extends BaseCollector {
  readonly name: string;
  /** Widen base `signal` visibility so callers can observe lifecycle abort state. */
  override readonly signal: AbortSignal;
  /** Per-cycle controller for the in-flight SSE fetch, distinct from BaseCollector's lifecycle signal so a DB-write failure can abort just the current cycle. */
  private collectAbort: AbortController | null = null;
  /** Coalesce window per container; collapses a restart-loop's A→B→A flap into zero writes. */
  private static readonly FLAP_WINDOW_MS = 250;
  private readonly host: ManagedHostInfo;
  private readonly signer: () => Promise<string>;
  private readonly eventRepository: DockerContainerEventRepository;
  private readonly streamConnector: StreamConnector;

  /** In-memory cache of last-written (state, eventType) per containerId on this host. */
  private readonly stateCache = new Map<string, CachedContainerState>();
  /** Pending write timers keyed by containerId, holding the latest snapshot per container. */
  private readonly pendingWrites = new Map<string, { container: InventorySnapshotContainer | InventoryUpdateContainer | null; eventType: 'upsert' | 'destroy'; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    host: ManagedHostInfo,
    signer: () => Promise<string>,
    repository: DockerContainerEventRepository,
    parentAbortController?: AbortController,
    streamConnector?: StreamConnector,
  ) {
    super(undefined, undefined, parentAbortController);
    this.signal = this.abortController.signal;
    this.host = host;
    this.signer = signer;
    this.eventRepository = repository;
    this.name = `ContainerInventoryCollector[${host.name}]`;
    this.streamConnector = streamConnector ?? connectAgentSseStream;
  }

  override async run(): Promise<void> {
    await this.hydrateCache();
    await super.run();
  }

  /** Populate the in-memory cache from the DB so restarts don't re-emit unchanged state. */
  private async hydrateCache(): Promise<void> {
    try {
      const snapshot = await this.eventRepository.getCurrentSnapshot();
      for (const row of snapshot) {
        if (row.host !== this.host.name) continue;
        const state = row.eventType === 'upsert' ? row.state : null;
        const detailsFingerprint = row.eventType === 'upsert'
          ? computeDetailsFingerprint(row.ports, row.mounts)
          : computeDetailsFingerprint([], []);
        this.stateCache.set(row.containerId, { state, eventType: row.eventType, detailsFingerprint });
      }
    } catch (err) {
      console.error(`[ContainerInventoryCollector] Failed to hydrate cache for ${this.host.name}:`, err);
    }
  }

  protected async collect(): Promise<void> {
    const cycleAbort = new AbortController();
    this.collectAbort = cycleAbort;
    const onLifecycleAbort = () => cycleAbort.abort();
    this.signal.addEventListener('abort', onLifecycleAbort, { once: true });
    if (this.signal.aborted) cycleAbort.abort();

    try {
      const stream = await this.streamConnector({
        agentUrl: this.host.agentUrl,
        path: '/containers/events',
        signer: this.signer,
        signal: cycleAbort.signal,
      });

      this.resetBackoff();

      for await (const raw of stream) {
        if (cycleAbort.signal.aborted) break;
        const parsed = zAgentContainerEvent.safeParse(raw);
        if (!parsed.success) {
          console.warn(
            '[ContainerInventoryCollector]',
            this.host.name,
            'dropped SSE frame failing schema validation:',
            parsed.error.issues,
          );
          continue;
        }
        await this.handleEvent(parsed.data);
      }

      // Aborted by triggerReconnect(), not the lifecycle: throw so run() drives reconnect.
      if (cycleAbort.signal.aborted && !this.signal.aborted) {
        throw new Error(`[ContainerInventoryCollector] ${this.host.name} cycle aborted to force reconnect`);
      }
    } catch (err) {
      // Drop pending flap-window timers so stale pre-error state doesn't fire after reconnect.
      for (const { timer } of this.pendingWrites.values()) {
        clearTimeout(timer);
      }
      this.pendingWrites.clear();
      throw err;
    } finally {
      this.signal.removeEventListener('abort', onLifecycleAbort);
      if (this.collectAbort === cycleAbort) this.collectAbort = null;
    }
  }

  /** Tears down the current cycle and reconnects; reconcileInit re-syncs state from the agent. */
  private triggerReconnect(reason: string): void {
    // Drop pending flap-window timers; racing more stale writes ahead of the resync is pointless.
    for (const { timer } of this.pendingWrites.values()) {
      clearTimeout(timer);
    }
    this.pendingWrites.clear();
    console.error(`[ContainerInventoryCollector] ${this.host.name} ${reason}; triggering reconnect to resync`);
    this.collectAbort?.abort();
  }

  private async handleEvent(event: AgentContainerEvent): Promise<void> {
    if (event.op === 'init') {
      // Narrowed to InventorySnapshotContainer[]; labels are authoritative here.
      await this.reconcileInit(event.containers);
    } else if (event.op === 'upsert') {
      // Labels intentionally absent here; reconcileInit() re-supplies them on reconnect.
      this.scheduleWrite(event.container, 'upsert');
    } else if (event.op === 'destroy') {
      this.scheduleDestroyWrite(event.containerId);
    }
  }

  /** On reconnect, diff the fresh snapshot against the cache: upsert changed containers, destroy vanished ones. */
  private async reconcileInit(containers: InventorySnapshotContainer[]): Promise<void> {
    // Cancel pending flap-window timers; they captured stale pre-reconnect state.
    for (const { timer } of this.pendingWrites.values()) {
      clearTimeout(timer);
    }
    this.pendingWrites.clear();

    const incomingIds = new Set(containers.map((c) => c.id));

    for (const container of containers) {
      const cached = this.stateCache.get(container.id);
      const fingerprint = computeDetailsFingerprint(container.ports, container.mounts);
      if (!cached || cached.state !== container.state || cached.eventType !== 'upsert' || cached.detailsFingerprint !== fingerprint) {
        await this.writeEvent(container, 'upsert');
      }
    }

    for (const [containerId, cached] of this.stateCache) {
      if (!incomingIds.has(containerId) && cached.eventType !== 'destroy') {
        await this.writeDestroyEvent(containerId);
      }
    }
  }

  /** Schedules a write behind FLAP_WINDOW_MS; only the final state within the window is written, and only if it changed. */
  private scheduleWrite(
    container: InventorySnapshotContainer | InventoryUpdateContainer,
    eventType: 'upsert',
  ): void {
    const existing = this.pendingWrites.get(container.id);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = globalThis.setTimeout(() => {
      this.pendingWrites.delete(container.id);
      const cached = this.stateCache.get(container.id);
      const fingerprint = computeDetailsFingerprint(container.ports, container.mounts);
      if (cached && cached.eventType === 'upsert' && cached.state === container.state && cached.detailsFingerprint === fingerprint) {
        return;
      }
      this.writeEvent(container, eventType).catch((err) => {
        console.error(`[ContainerInventoryCollector] Write error for ${this.host.name}/${container.id}:`, err);
        this.triggerReconnect(`DB write failed for ${container.id}`);
      });
    }, ContainerInventoryCollector.FLAP_WINDOW_MS);

    this.pendingWrites.set(container.id, { container, eventType, timer });
  }

  private scheduleDestroyWrite(containerId: string): void {
    const existing = this.pendingWrites.get(containerId);
    if (existing) {
      clearTimeout(existing.timer);
    }

    const timer = globalThis.setTimeout(() => {
      this.pendingWrites.delete(containerId);
      const cached = this.stateCache.get(containerId);
      if (cached?.eventType === 'destroy') return;
      this.writeDestroyEvent(containerId).catch((err) => {
        console.error(`[ContainerInventoryCollector] Destroy write error for ${this.host.name}/${containerId}:`, err);
        this.triggerReconnect(`DB destroy-write failed for ${containerId}`);
      });
    }, ContainerInventoryCollector.FLAP_WINDOW_MS);

    this.pendingWrites.set(containerId, { container: null, eventType: 'destroy', timer });
  }

  private async writeEvent(
    container: InventorySnapshotContainer | InventoryUpdateContainer,
    eventType: 'upsert',
  ): Promise<void> {
    // Streaming upserts carry no labels; serviceKey falls back to name until the next reconcileInit.
    const labels = 'labels' in container ? container.labels : {};
    const serviceKey = computeServiceKey(labels, container.name);
    const detailsFingerprint = computeDetailsFingerprint(container.ports, container.mounts);
    try {
      await this.eventRepository.insert({
        at: new Date(),
        host: this.host.name,
        containerId: container.id,
        eventType,
        state: container.state,
        name: container.name,
        image: container.image,
        labels,
        ports: container.ports,
        mounts: container.mounts,
        serviceKey,
        startedAt: container.startedAt ? new Date(container.startedAt) : null,
        finishedAt: container.finishedAt ? new Date(container.finishedAt) : null,
        exitCode: container.exitCode,
      });
      this.stateCache.set(container.id, { state: container.state, eventType, detailsFingerprint });
    } catch (err) {
      console.error(`[ContainerInventoryCollector] DB error for ${this.host.name}/${container.id}:`, err);
      throw err;
    }
  }

  private async writeDestroyEvent(containerId: string): Promise<void> {
    try {
      await this.eventRepository.insert({
        at: new Date(),
        host: this.host.name,
        containerId,
        eventType: 'destroy',
      });
      this.stateCache.set(containerId, { state: null, eventType: 'destroy', detailsFingerprint: computeDetailsFingerprint([], []) });
    } catch (err) {
      console.error(`[ContainerInventoryCollector] DB destroy error for ${this.host.name}/${containerId}:`, err);
      throw err;
    }
  }

  override async [Symbol.asyncDispose](): Promise<void> {
    await super[Symbol.asyncDispose]();
    for (const { timer } of this.pendingWrites.values()) {
      clearTimeout(timer);
    }
    this.pendingWrites.clear();
  }
}
