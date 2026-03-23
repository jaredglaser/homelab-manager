import type { StackStatusRepository } from '@/lib/database/repositories/stack-status-repository';
import type { StackContainer } from '@/types/stacks';

/** Shape of SSE events emitted by the agent's GET /stacks/events endpoint */
interface StackEvent {
  stack: string;
  containers: StackContainer[];
}

export interface ManagedHostInfo {
  name: string;
  agentUrl: string;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Connects to an agent's /stacks/events SSE endpoint and persists stack container
 * status to the database. Implements its own reconnection loop with exponential
 * backoff — does NOT extend BaseCollector (which is coupled to StatsRepository).
 */
export class StackStatusCollector implements AsyncDisposable {
  private readonly abortController: AbortController;
  private consecutiveErrors = 0;
  private static readonly BASE_DELAY_MS = 500;
  private static readonly MAX_DELAY_MS = 32_000;
  private readonly fetchFn: FetchFn;

  constructor(
    private readonly host: ManagedHostInfo,
    private readonly token: string,
    private readonly repository: StackStatusRepository,
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

  /**
   * Main entry point. Runs the collection loop until aborted.
   * Handles reconnection with exponential backoff on errors.
   */
  async run(): Promise<void> {
    console.info(`[StackStatusCollector] Starting for ${this.host.name}`);

    while (!this.signal.aborted) {
      try {
        await this.collect();
        this.consecutiveErrors = 0;
      } catch (error) {
        if (this.signal.aborted) break;
        this.consecutiveErrors++;
        const delay = Math.min(
          StackStatusCollector.BASE_DELAY_MS * 2 ** (this.consecutiveErrors - 1),
          StackStatusCollector.MAX_DELAY_MS,
        );
        console.error(
          `[StackStatusCollector] ${this.host.name} error (retry in ${delay}ms):`,
          error,
        );
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
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

    console.info(`[StackStatusCollector] Stopped for ${this.host.name}`);
  }

  private async collect(): Promise<void> {
    const url = `${this.host.agentUrl}/stacks/events`;

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
          let event: StackEvent;
          try {
            event = JSON.parse(json);
          } catch {
            // Skip malformed JSON silently
            continue;
          }
          try {
            await this.repository.upsertStackStatus(event.stack, this.host.name, event.containers);
          } catch (dbErr) {
            console.error(`[StackStatusCollector] DB error for ${this.host.name}/${event.stack}:`, dbErr);
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.abortController.abort();
  }
}
