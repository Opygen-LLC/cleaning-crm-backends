interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  bytes: number;
}

interface BoundedTtlCacheOptions {
  maxEntries: number;
  maxBytes?: number;
}

/**
 * Small dependency-free L1 cache for data that is already safe to cache.
 * Map insertion order provides O(1) LRU eviction and both entry and byte
 * limits prevent a busy API process from growing without bounds.
 */
export class BoundedTtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private totalBytes = 0;

  constructor(private readonly options: BoundedTtlCacheOptions) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.remove(key, entry);
      return undefined;
    }

    // Touch the entry so the oldest item remains at the front of the Map.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number, bytes = 1): void {
    if (ttlMs <= 0 || bytes > (this.options.maxBytes ?? Number.MAX_SAFE_INTEGER)) {
      return;
    }

    const existing = this.entries.get(key);
    if (existing) this.remove(key, existing);

    this.entries.set(key, {
      value,
      expiresAt: Date.now() + ttlMs,
      bytes: Math.max(1, bytes),
    });
    this.totalBytes += Math.max(1, bytes);
    this.evictOverflow();
  }

  delete(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.remove(key, entry);
  }

  deleteByPrefix(prefix: string): void {
    for (const [key, entry] of this.entries) {
      if (key.startsWith(prefix)) this.remove(key, entry);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  get size(): number {
    return this.entries.size;
  }

  private remove(key: string, entry: CacheEntry<T>): void {
    this.entries.delete(key);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
  }

  private evictOverflow(): void {
    const maxBytes = this.options.maxBytes ?? Number.MAX_SAFE_INTEGER;
    while (
      this.entries.size > this.options.maxEntries ||
      this.totalBytes > maxBytes
    ) {
      const oldest = this.entries.entries().next().value as
        | [string, CacheEntry<T>]
        | undefined;
      if (!oldest) break;
      this.remove(oldest[0], oldest[1]);
    }
  }
}
