interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory cache with a hard entry cap. Eviction on overflow drops expired
 * entries first, then the oldest, so a growing key space cannot grow memory.
 */
export class BoundedCache<T> {
  private entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries: number) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    this.evict();
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries) break;
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}