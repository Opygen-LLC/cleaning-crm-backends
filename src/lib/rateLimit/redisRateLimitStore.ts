import { createHash } from "node:crypto";
import type { IncrementResponse, Store } from "express-rate-limit";
import redis from "../../config/redis";
import { BoundedTtlCache } from "../cache/boundedTtlCache";

interface LocalCounter {
  totalHits: number;
  resetAt: number;
}

interface RedisRateLimitStoreOptions {
  prefix: string;
  windowMs: number;
  maxFallbackEntries?: number;
}

/**
 * Shared express-rate-limit store backed by Redis.
 *
 * Public website traffic is served by multiple API replicas, so the default
 * in-memory store would give every replica an independent allowance. This
 * store keeps the enforcement window global while hashing the limiter key so
 * raw visitor IPs are never persisted in Redis keys.
 *
 * Redis remains an acceleration/protection dependency rather than an
 * availability dependency: if it is down we fall back to a bounded per-process
 * counter so public forms are still protected without turning a cache outage
 * into a public-site outage.
 */
export class RedisRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private readonly windowMs: number;
  private readonly fallback: BoundedTtlCache<LocalCounter>;

  constructor(options: RedisRateLimitStoreOptions) {
    this.prefix = options.prefix.replace(/[^a-zA-Z0-9:_-]/g, "-").slice(0, 80);
    this.windowMs = Math.max(1_000, Math.trunc(options.windowMs));
    this.fallback = new BoundedTtlCache<LocalCounter>({
      maxEntries: options.maxFallbackEntries ?? 20_000,
    });
  }

  private storageKey(key: string): string {
    const digest = createHash("sha256").update(key).digest("hex").slice(0, 40);
    return `rate:${this.prefix}:${digest}`;
  }

  private localIncrement(storageKey: string): IncrementResponse {
    const now = Date.now();
    const current = this.fallback.get(storageKey);
    const resetAt = current && current.resetAt > now
      ? current.resetAt
      : now + this.windowMs;
    const next: LocalCounter = {
      totalHits: (current?.totalHits ?? 0) + 1,
      resetAt,
    };
    this.fallback.set(storageKey, next, Math.max(1, resetAt - now));
    return { totalHits: next.totalHits, resetTime: new Date(resetAt) };
  }

  async increment(key: string): Promise<IncrementResponse> {
    const storageKey = this.storageKey(key);
    try {
      const result = await redis.eval(
        `
          local count = redis.call('INCR', KEYS[1])
          if count == 1 then
            redis.call('PEXPIRE', KEYS[1], ARGV[1])
          end
          local ttl = redis.call('PTTL', KEYS[1])
          if ttl < 0 then
            redis.call('PEXPIRE', KEYS[1], ARGV[1])
            ttl = tonumber(ARGV[1])
          end
          return { count, ttl }
        `,
        1,
        storageKey,
        String(this.windowMs),
      ) as [number | string, number | string];
      const totalHits = Math.max(1, Number(result?.[0]) || 1);
      const ttlMs = Math.max(1, Number(result?.[1]) || this.windowMs);
      return { totalHits, resetTime: new Date(Date.now() + ttlMs) };
    } catch {
      return this.localIncrement(storageKey);
    }
  }

  async decrement(key: string): Promise<void> {
    const storageKey = this.storageKey(key);
    try {
      await redis.eval(
        `
          local value = redis.call('GET', KEYS[1])
          if not value then return 0 end
          if tonumber(value) <= 1 then
            redis.call('DEL', KEYS[1])
            return 0
          end
          return redis.call('DECR', KEYS[1])
        `,
        1,
        storageKey,
      );
      return;
    } catch {
      const current = this.fallback.get(storageKey);
      if (!current) return;
      if (current.totalHits <= 1) {
        this.fallback.delete(storageKey);
        return;
      }
      this.fallback.set(
        storageKey,
        { ...current, totalHits: current.totalHits - 1 },
        Math.max(1, current.resetAt - Date.now()),
      );
    }
  }

  async resetKey(key: string): Promise<void> {
    const storageKey = this.storageKey(key);
    this.fallback.delete(storageKey);
    try {
      await redis.del(storageKey);
    } catch {
      // Local fallback has already been cleared. Redis recovery will naturally
      // discard the old key when its short limiter TTL expires.
    }
  }
}
