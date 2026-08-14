/**
 * Counting semaphore bounding how many container analysts hold a model call at
 * once. A homelab endpoint typically serves one or two requests at a time, and
 * a fleet of thirty containers all flushing a batch at once would queue inside
 * the server, where the wait is invisible and unbounded rather than here.
 */
export class Semaphore {
  private available: number;
  private readonly waiters: (() => void)[] = [];

  constructor(permits: number) {
    if (!Number.isInteger(permits) || permits < 1) {
      throw new Error(`Semaphore needs at least 1 permit, got ${permits}`);
    }
    this.available = permits;
  }

  get free(): number {
    return this.available;
  }

  get queued(): number {
    return this.waiters.length;
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available += 1;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.available > 0) {
      this.available -= 1;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
