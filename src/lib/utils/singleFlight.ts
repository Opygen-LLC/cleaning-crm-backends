/**
 * singleFlight.ts
 *
 * PERF FIX (Phase 4, performance audit — Redis cache-stampede):
 *
 * checkAuth.ts and checkSubscription.ts both cache their DB lookups in Redis
 * with a short TTL — good design, but production logs showed pairs of
 * *identical* uncached Postgres queries firing back-to-back for the same
 * user, a few milliseconds apart:
 *
 *   [SLOW QUERY 2007.14ms] SELECT ... FROM "user" WHERE "id" = $1 ... ["LqPD...", ...]
 *   [SLOW QUERY 2008.95ms] SELECT ... FROM "user" WHERE "id" = $1 ... ["LqPD...", ...]
 *
 * This is a classic cache stampede: two nearly-simultaneous requests for the
 * same user both check Redis, both find it empty (right after expiry, or
 * before either has had a chance to write the result back), and both
 * independently fall through to Postgres — doubling the network-latency tax
 * on an already-expensive cross-region query for no reason. The second
 * request should simply wait for the first one's result instead of doing
 * its own redundant round trip.
 *
 * `singleFlight(key, fn)` collapses concurrent calls for the same key
 * (within this one warm server process) into a single underlying call —
 * every caller that arrives while one is already in flight gets the same
 * Promise instead of starting a new one. This is purely an in-process
 * optimization: it does not change Redis TTLs, cache correctness, or
 * behavior across separate server instances/processes — it only prevents
 * the *same* process from doing duplicate work for a request that's already
 * running.
 */

const inFlight = new Map<string, Promise<unknown>>();

export function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) {
        return existing as Promise<T>;
    }

    const promise = fn().finally(() => {
        // Only clear the entry if it's still the one we set — avoids a rare
        // race where a fast subsequent call already replaced it.
        if (inFlight.get(key) === promise) {
            inFlight.delete(key);
        }
    });

    inFlight.set(key, promise);
    return promise;
}
