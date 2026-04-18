import type { Pool } from 'pg';
import type { DatabaseClient } from '@/lib/clients/database-client';
import type { WorkerConfig } from '@/lib/config/worker-config';
import type {
  AgentContainerEvent,
  ContainerState,
  InventorySnapshotContainer,
  InventoryUpdateContainer,
} from '@/types/docker-inventory';
import { zAgentContainerEvent } from '@homelab-manager/agent/types/protocol';
import type { DockerContainerEventRepository } from '@/lib/database/repositories/docker-container-event-repository';
import { computeServiceKey } from '@/lib/utils/docker-hierarchy-builder';
import { BaseCollector } from './base-collector';

/** Minimal host descriptor shared by agent-based collectors. */
export interface ManagedHostInfo {
  name: string;
  agentUrl: string;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Per-container state held in memory to avoid redundant DB writes. */
interface CachedContainerState {
  state: ContainerState | null;
  eventType: 'upsert' | 'destroy';
}

/**
 * BaseCollector eagerly instantiates a StatsRepository from `db.getPool()`.
 * The inventory collector persists via its own DockerContainerEventRepository
 * instead and never touches the base repository, so we hand super() a stub
 * whose pool is never dereferenced. Keeps the (host, token, repo, ...)
 * constructor shape that callers + tests depend on.
 */
const STUB_DB = { getPool: () => ({} as Pool) } as DatabaseClient;
const STUB_CONFIG = {} as WorkerConfig;

export class ContainerInventoryCollector extends BaseCollector {
  readonly name: string;
  /** Widen base `signal` visibility so callers can observe lifecycle abort state. */
  override readonly signal: AbortSignal;
  /**
   * Per-cycle controller for the in-flight SSE fetch. Distinct from BaseCollector's
   * lifecycle `signal` so a DB-write failure can abort just the current cycle —
   * run()'s catch path then drives reconnect via the base backoff.
   */
  private collectAbort: AbortController | null = null;
  /** 250 ms coalesce window per container to collapse flapping state transitions. */
  // 250ms = typical restart-loop settle window; coalesces A→B→A flap into zero writes
  private static readonly FLAP_WINDOW_MS = 250;
  private readonly host: ManagedHostInfo;
  private readonly token: string;
  private readonly eventRepository: DockerContainerEventRepository;
  private readonly fetchFn: FetchFn;

  /** In-memory cache of last-written (state, eventType) per containerId on this host. */
  private readonly stateCache = new Map<string, CachedContainerState>();
  /**
   * Pending write timers keyed by containerId. Each value is the latest container
   * snapshot. Accepts either event shape — `InventorySnapshotContainer` (from init)
   * carries labels; `InventoryUpdateContainer` (from upsert) does not.
   */
  private readonly pendingWrites = new Map<string, { container: InventorySnapshotContainer | InventoryUpdateContainer | null; eventType: 'upsert' | 'destroy'; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    host: ManagedHostInfo,
    token: string,
    repository: DockerContainerEventRepository,
    parentAbortController?: AbortController,
    fetchFn?: FetchFn,
  ) {
    super(STUB_DB, STUB_CONFIG, parentAbortController);
    this.signal = this.abortController.signal;
    this.host = host;
    this.token = token;
    this.eventRepository = repository;
    this.name = `ContainerInventoryCollector[${host.name}]`;
    this.fetchFn = fetchFn ?? globalThis.fetch;
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
        this.stateCache.set(row.containerId, { state, eventType: row.eventType });
      }
    } catch (err) {
      console.error(`[ContainerInventoryCollector] Failed to hydrate cache for ${this.host.name}:`, err);
    }
  }

  protected async collect(): Promise<void> {
    const url = `${this.host.agentUrl}/containers/events`;

    const cycleAbort = new AbortController();
    this.collectAbort = cycleAbort;
    const onLifecycleAbort = () => cycleAbort.abort();
    this.signal.addEventListener('abort', onLifecycleAbort, { once: true });
    if (this.signal.aborted) cycleAbort.abort();

    try {
      const response = await this.fetchFn(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        signal: cycleAbort.signal,
      });

      if (!response.ok) {
        throw new Error(`Agent ${this.host.name} returned ${response.status}`);
      }
      if (!response.body) {
        throw new Error(`Agent ${this.host.name} returned no body`);
      }

      this.resetBackoff();

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      try {
        while (!cycleAbort.signal.aborted) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const messages = buffer.split('\n\n');
          buffer = messages.pop() ?? '';

          for (const msg of messages) {
            if (cycleAbort.signal.aborted) break;
            const dataLine = msg.split('\n').find((line) => line.startsWith('data: '));
            if (!dataLine) continue;
            const json = dataLine.slice(6);
            let raw: unknown;
            try {
              raw = JSON.parse(json);
            } catch {
              console.warn('[ContainerInventoryCollector]', this.host.name, 'dropped malformed SSE frame:', json.slice(0, 200));
              continue;
            }
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
        }
      } finally {
        reader.releaseLock();
      }

      // If the cycle was aborted by triggerReconnect() (not the lifecycle), throw
      // so run()'s catch path drives reconnect via BaseCollector's backoff.
      if (cycleAbort.signal.aborted && !this.signal.aborted) {
        throw new Error(`[ContainerInventoryCollector] ${this.host.name} cycle aborted to force reconnect`);
      }
    } catch (err) {
      // Cancel pending flap-window timers so they don't fire after reconnect with
      // stale pre-error state. reconcileInit will re-derive diffs from the new snapshot.
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

  /**
   * Force the current collect cycle to tear down and reconnect. Used when a DB write
   * fails from a flap-window timer so reconcileInit can re-sync state from the agent.
   */
  private triggerReconnect(reason: string): void {
    // Drop pending flap-window timers — reconcileInit will reassess state from the
    // post-reconnect snapshot, so racing more stale writes is pointless.
    for (const { timer } of this.pendingWrites.values()) {
      clearTimeout(timer);
    }
    this.pendingWrites.clear();
    console.error(`[ContainerInventoryCollector] ${this.host.name} ${reason}; triggering reconnect to resync`);
    this.collectAbort?.abort();
  }

  private async handleEvent(event: AgentContainerEvent): Promise<void> {
    if (event.op === 'init') {
      // Narrowed to InventorySnapshotContainer[] — labels are authoritative here.
      await this.reconcileInit(event.containers);
    } else if (event.op === 'upsert') {
      // Narrowed to InventoryUpdateContainer — labels intentionally absent; the
      // writer fills an empty map. reconcileInit() re-supplies labels on reconnect.
      this.scheduleWrite(event.container, 'upsert');
    } else if (event.op === 'destroy') {
      this.scheduleDestroyWrite(event.containerId);
    }
  }

  /**
   * On agent reconnect, compare the fresh snapshot against the in-memory cache.
   * Write upserts for containers whose state changed and destroys for containers
   * that disappeared while offline.
   */
  private async reconcileInit(containers: InventorySnapshotContainer[]): Promise<void> {
    // Cancel pending flap-window timers — they captured stale pre-reconnect state.
    for (const { timer } of this.pendingWrites.values()) {
      clearTimeout(timer);
    }
    this.pendingWrites.clear();

    const incomingIds = new Set(containers.map((c) => c.id));

    for (const container of containers) {
      const cached = this.stateCache.get(container.id);
      if (!cached || cached.state !== container.state || cached.eventType !== 'upsert') {
        await this.writeEvent(container, 'upsert');
      }
    }

    for (const [containerId, cached] of this.stateCache) {
      if (!incomingIds.has(containerId) && cached.eventType !== 'destroy') {
        await this.writeDestroyEvent(containerId);
      }
    }
  }

  /**
   * Schedule a write with a 250 ms coalesce window.
   * If the same container receives another event within the window, only the final
   * state is written. If the final state matches the last-written state, nothing is written.
   */
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
      if (cached && cached.eventType === 'upsert' && cached.state === container.state) {
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
    // Snapshot containers carry labels; update containers (streaming upserts) do not.
    // When labels are absent, serviceKey falls back to container name — the next
    // reconcileInit will re-derive the full key from the snapshot labels.
    const labels = 'labels' in container ? container.labels : {};
    const serviceKey = computeServiceKey(labels, container.name);
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
        serviceKey,
        startedAt: container.startedAt ? new Date(container.startedAt) : null,
        finishedAt: container.finishedAt ? new Date(container.finishedAt) : null,
        exitCode: container.exitCode,
      });
      this.stateCache.set(container.id, { state: container.state, eventType });
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
      this.stateCache.set(containerId, { state: null, eventType: 'destroy' });
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
