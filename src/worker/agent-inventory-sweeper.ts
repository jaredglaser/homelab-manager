import { abortableSleep, isAbortError } from '@/lib/utils/abortable-sleep';
import { AGENT_INVENTORY_NOTIFY_CHANNEL } from '@/lib/hosts/agent-inventory';
import type { AgentInventoryEntry } from '@/lib/hosts/agent-inventory';

export const AGENT_INVENTORY_SWEEP_INTERVAL_MS = 60_000;

export interface AgentInventorySweeperDeps {
  sweep: () => Promise<AgentInventoryEntry[]>;
  notifySweep: (at: Date) => Promise<void>;
  intervalMs?: number;
}

/**
 * Worker-owned periodic agent health sweep. There is exactly one instance in
 * the worker process, so N hosts are probed once per tick no matter how many
 * clients are subscribed to the inventory SSE channel. After each sweep it
 * fires one pg NOTIFY so the server's broadcast service can push the fresh
 * snapshot to subscribers.
 */
export class AgentInventorySweeper {
  private readonly intervalMs: number;
  private readonly abortController: AbortController;
  readonly signal: AbortSignal;

  constructor(
    private readonly deps: AgentInventorySweeperDeps,
    abortController?: AbortController,
  ) {
    this.intervalMs = deps.intervalMs ?? AGENT_INVENTORY_SWEEP_INTERVAL_MS;
    this.abortController = abortController ?? new AbortController();
    this.signal = this.abortController.signal;
  }

  /** Runs sweeps on the interval until aborted. */
  async run(): Promise<void> {
    while (!this.signal.aborted) {
      try {
        await this.sweepOnce();
      } catch (err) {
        if (isAbortError(err) || this.signal.aborted) break;
        console.error('[AgentInventorySweeper] Sweep failed:', err instanceof Error ? err.message : err);
      }
      try {
        await abortableSleep(this.intervalMs, this.signal);
      } catch {
        break;
      }
    }
    console.log('[AgentInventorySweeper] Stopped');
  }

  /** One sweep plus its NOTIFY; a NOTIFY failure never fails the sweep. */
  async sweepOnce(): Promise<void> {
    await this.deps.sweep();
    try {
      await this.deps.notifySweep(new Date());
    } catch (err) {
      console.error(
        `[AgentInventorySweeper] pg_notify(${AGENT_INVENTORY_NOTIFY_CHANNEL}) failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  stop(): void {
    if (!this.signal.aborted) {
      this.abortController.abort(new DOMException('Sweeper stopped', 'AbortError'));
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.stop();
  }
}
