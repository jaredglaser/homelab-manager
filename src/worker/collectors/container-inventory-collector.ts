import type { AgentContainerEvent, ContainerState, InventoryContainer } from '@/types/docker-inventory';
import type { DockerContainerEventRepository } from '@/lib/database/repositories/docker-container-event-repository';
import { computeServiceKey } from '@/lib/utils/docker-hierarchy-builder';

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

export class ContainerInventoryCollector implements AsyncDisposable {
  private readonly abortController: AbortController;
  private consecutiveErrors = 0;
  private static readonly BASE_DELAY_MS = 500;
  private static readonly MAX_DELAY_MS = 32_000;
  /** 250 ms coalesce window per container to collapse flapping state transitions. */
  private static readonly FLAP_WINDOW_MS = 250;
  private readonly fetchFn: FetchFn;

  /** In-memory cache of last-written (state, eventType) per containerId on this host. */
  private readonly stateCache = new Map<string, CachedContainerState>();
  /** Pending write timers keyed by containerId. Each value is the latest container snapshot. */
  private readonly pendingWrites = new Map<string, { container: InventoryContainer | null; eventType: 'upsert' | 'destroy'; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly host: ManagedHostInfo,
    private readonly token: string,
    private readonly repository: DockerContainerEventRepository,
    parentAbortController?: AbortController,
    fetchFn?: FetchFn,
  ) {
    this.abortController = new AbortController();
    if (parentAbortController) {
      if (parentAbortController.signal.aborted) {
        this.abortController.abort();
      } else {
        parentAbortController.signal.addEventListener('abort', () => this.abortController.abort(), { once: true });
      }
    }
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  async run(): Promise<void> {
    console.info(`[ContainerInventoryCollector] Starting for ${this.host.name}`);

    await this.hydrateCache();

    while (!this.signal.aborted) {
      try {
        await this.collect();
        this.consecutiveErrors = 0;
      } catch (error) {
        if (this.signal.aborted) break;
        this.consecutiveErrors++;
        const delay = Math.min(
          ContainerInventoryCollector.BASE_DELAY_MS * 2 ** (this.consecutiveErrors - 1),
          ContainerInventoryCollector.MAX_DELAY_MS,
        );
        console.error(
          `[ContainerInventoryCollector] ${this.host.name} error (retry in ${delay}ms):`,
          error,
        );
        await new Promise<void>((resolve) => {
          const timer = globalThis.setTimeout(resolve, delay);
          this.signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    }

    console.info(`[ContainerInventoryCollector] Stopped for ${this.host.name}`);
  }

  /** Populate the in-memory cache from the DB so restarts don't re-emit unchanged state. */
  private async hydrateCache(): Promise<void> {
    try {
      const snapshot = await this.repository.getCurrentSnapshot();
      for (const row of snapshot) {
        if (row.host === this.host.name) {
          this.stateCache.set(row.containerId, { state: row.state, eventType: row.eventType });
        }
      }
    } catch (err) {
      console.error(`[ContainerInventoryCollector] Failed to hydrate cache for ${this.host.name}:`, err);
    }
  }

  private async collect(): Promise<void> {
    const url = `${this.host.agentUrl}/containers/events`;

    const response = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: this.signal,
    });

    if (!response.ok) {
      throw new Error(`Agent ${this.host.name} returned ${response.status}`);
    }
    if (!response.body) {
      throw new Error(`Agent ${this.host.name} returned no body`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (!this.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split('\n\n');
        buffer = messages.pop() ?? '';

        for (const msg of messages) {
          if (this.signal.aborted) break;
          const dataLine = msg.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          const json = dataLine.slice(6);
          let event: AgentContainerEvent;
          try {
            event = JSON.parse(json) as AgentContainerEvent;
          } catch {
            continue;
          }
          await this.handleEvent(event);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async handleEvent(event: AgentContainerEvent): Promise<void> {
    if (event.op === 'init') {
      await this.reconcileInit(event.containers);
    } else if (event.op === 'upsert') {
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
  private async reconcileInit(containers: InventoryContainer[]): Promise<void> {
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
  private scheduleWrite(container: InventoryContainer, eventType: 'upsert' | 'destroy'): void {
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
      });
    }, ContainerInventoryCollector.FLAP_WINDOW_MS);

    this.pendingWrites.set(containerId, { container: null, eventType: 'destroy', timer });
  }

  private async writeEvent(container: InventoryContainer, eventType: 'upsert' | 'destroy'): Promise<void> {
    const serviceKey = computeServiceKey(container.labels, container.name);
    try {
      await this.repository.insert({
        at: new Date(),
        host: this.host.name,
        containerId: container.id,
        eventType,
        state: container.state,
        name: container.name,
        image: container.image,
        labels: container.labels,
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
      await this.repository.insert({
        at: new Date(),
        host: this.host.name,
        containerId,
        eventType: 'destroy',
        state: null,
        name: null,
        image: null,
        labels: {},
        serviceKey: null,
        startedAt: null,
        finishedAt: null,
        exitCode: null,
      });
      this.stateCache.set(containerId, { state: null, eventType: 'destroy' });
    } catch (err) {
      console.error(`[ContainerInventoryCollector] DB destroy error for ${this.host.name}/${containerId}:`, err);
      throw err;
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.abortController.abort();
    for (const { timer } of this.pendingWrites.values()) {
      clearTimeout(timer);
    }
    this.pendingWrites.clear();
  }
}
