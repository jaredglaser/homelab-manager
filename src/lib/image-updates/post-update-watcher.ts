import type { DockerInventoryBroadcastEvent } from '@/types/docker-inventory';
import { dockerInventoryBroadcastService } from '@/lib/docker/docker-inventory-broadcast-service';
import { invalidateImageUpdateSummaryCache, loadStackContainers } from './image-update-service';
import { bumpCheckGeneration, runManualImageUpdateCheck } from './manual-check';

const FIRST_TEST_MS = 5_000;
const POLL_MS = 10_000;
const DEBOUNCE_MS = 2_000;
/** Container `at` stamps come from the agent host, so a small clock drift must not read as "not converged yet". */
const CLOCK_SKEW_MS = 90_000;
const GIVE_UP_MS = 3 * 60_000;

interface Waiter {
  stack: string;
  host: string;
  completedAt: number;
  deadline: number;
  nextTestAt: number;
  debounceTimer: ReturnType<typeof setTimeout> | null;
}

export interface PostUpdateWatcherDeps {
  loadSnapshot: (stack: string, host: string) => Promise<Array<{ at: Date }>>;
  runCheck: (stack: string, host: string) => Promise<unknown>;
  subscribe: (callback: (event: DockerInventoryBroadcastEvent) => void) => () => void;
  invalidate: (host: string, stack: string) => void;
  now: () => number;
}

/**
 * Waits for the container snapshot to reflect a finished image update before
 * re-checking the stack. A check against the pre-update snapshot would persist
 * a stale verdict with a fresh checked_at and never broadcast the correction,
 * so the convergence test gates the check and a deadline gives up without
 * running it at all.
 *
 * The docker_container_change subscription is permanent once started: besides
 * early convergence tests it invalidates the per-stack summary cache on every
 * upsert, making snapshot changes the invalidation source between ticks.
 */
export class PostUpdateWatcher {
  private waiters = new Map<string, Waiter>();
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribe: (() => void) | null = null;

  constructor(private readonly deps: PostUpdateWatcherDeps) {}

  /** Idempotent per stack: re-arming replaces the waiter and bumps the check generation. */
  arm(stack: string, host: string, completedAt: number): void {
    const key = host + '/' + stack;
    const existing = this.waiters.get(key);
    if (existing?.debounceTimer) clearTimeout(existing.debounceTimer);
    bumpCheckGeneration(host, stack);
    this.waiters.set(key, {
      stack,
      host,
      completedAt,
      deadline: completedAt + GIVE_UP_MS,
      nextTestAt: completedAt + FIRST_TEST_MS,
      debounceTimer: null,
    });
    this.ensureSubscription();
    this.schedulePoll();
  }

  pending(): number {
    return this.waiters.size;
  }

  stop(): void {
    for (const waiter of this.waiters.values()) {
      if (waiter.debounceTimer) clearTimeout(waiter.debounceTimer);
    }
    this.waiters.clear();
    if (this.pollTimer !== null) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private ensureSubscription(): void {
    if (this.unsubscribe === null) {
      this.unsubscribe = this.deps.subscribe((event) => this.onEvent(event));
    }
  }

  private onEvent(event: DockerInventoryBroadcastEvent): void {
    if (event.type === 'upsert') {
      const { host, composeProject } = event.container;
      if (composeProject) this.deps.invalidate(host, composeProject);
      const waiter = composeProject ? this.waiters.get(host + '/' + composeProject) : undefined;
      if (waiter && waiter.debounceTimer === null) {
        waiter.debounceTimer = setTimeout(() => {
          waiter.debounceTimer = null;
          void this.test(waiter);
        }, DEBOUNCE_MS);
      }
    }
  }

  private schedulePoll(): void {
    if (this.waiters.size === 0) {
      if (this.pollTimer !== null) {
        clearTimeout(this.pollTimer);
        this.pollTimer = null;
      }
      return;
    }
    const next = Math.min(...Array.from(this.waiters.values()).map((waiter) => waiter.nextTestAt));
    const delay = Math.max(0, next - this.deps.now());
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.testDue();
    }, delay);
  }

  private async testDue(): Promise<void> {
    const due = Array.from(this.waiters.values()).filter((waiter) => waiter.nextTestAt <= this.deps.now());
    for (const waiter of due) {
      await this.test(waiter);
    }
    this.schedulePoll();
  }

  private async test(waiter: Waiter): Promise<void> {
    const key = waiter.host + '/' + waiter.stack;
    if (this.waiters.get(key) !== waiter) return;
    let converged = false;
    try {
      const rows = await this.deps.loadSnapshot(waiter.stack, waiter.host);
      const latest = rows.reduce((max, row) => Math.max(max, row.at.getTime()), 0);
      converged = latest >= waiter.completedAt - CLOCK_SKEW_MS;
    } catch (err) {
      console.error(`[image-updates] snapshot read failed while waiting for ${waiter.host}/${waiter.stack}:`, err);
    }
    if (!converged) {
      if (this.deps.now() >= waiter.deadline) {
        console.error(
          `[image-updates] container snapshot for ${waiter.host}/${waiter.stack} did not reflect the update within ` +
            `${Math.round(GIVE_UP_MS / 1000)}s; skipping the post-update check (the next scheduled refresh or a manual re-check will cover it)`,
        );
        this.waiters.delete(key);
        this.schedulePoll();
      } else {
        waiter.nextTestAt = this.deps.now() + POLL_MS;
        this.schedulePoll();
      }
      return;
    }
    this.waiters.delete(key);
    this.schedulePoll();
    try {
      await this.deps.runCheck(waiter.stack, waiter.host);
    } catch (err) {
      console.error(`[image-updates] post-update check failed for ${waiter.host}/${waiter.stack}:`, err);
    }
  }
}

export const postUpdateWatcher = new PostUpdateWatcher({
  loadSnapshot: (stack, host) => loadStackContainers(stack, host),
  runCheck: (stack, host) => runManualImageUpdateCheck(stack, host),
  subscribe: (callback) => dockerInventoryBroadcastService.subscribe(callback),
  invalidate: (host, stack) => invalidateImageUpdateSummaryCache(host, stack),
  now: () => Date.now(),
});
