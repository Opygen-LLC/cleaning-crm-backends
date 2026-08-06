import Redis from "ioredis";
import dotenv from "dotenv";
import logger from "../lib/logger";

dotenv.config();

/**
 * Redis — Reports caching only (see reports.service.ts getCached/setCache).
 *
 * This is a pure cache layer, never a source of truth, so Redis being slow,
 * misconfigured, or completely absent must NEVER crash the app or hang a
 * request. Two failure modes had to be handled explicitly (neither was
 * before):
 *
 *  1. ioredis is an EventEmitter. Connection-level errors (ECONNREFUSED on
 *     boot, the host disappearing later, auth failures, etc.) are emitted as
 *     "error" events. Node's rule for EventEmitter is: an "error" event with
 *     no listener attached is thrown as an uncaught exception, which crashes
 *     the process. There was no listener here — meaning a Redis outage would
 *     have taken the whole API down with it, not just degraded caching.
 *     The listener below is what makes "Redis is down" a background warning
 *     instead of a process crash.
 *
 *  2. `host`/`port` were read straight from `process.env` with no fallback,
 *     so a missing REDIS_HOST/REDIS_PORT produced `host: undefined` /
 *     `port: NaN` instead of failing predictably.
 *
 * `lazyConnect` + a small `maxRetriesPerRequest` mean: if Redis is
 * unreachable, an individual `redis.get()`/`redis.set()` call fails fast
 * (rejects) instead of retrying for a long time or hanging the request —
 * `getCached`/`setCache` in reports.service.ts already treat that rejection
 * as a cache miss, so Reports simply falls back to querying Postgres
 * directly. `retryStrategy` keeps a background reconnect loop going (capped
 * backoff) so Redis coming back online is picked up automatically without a
 * restart.
 */

const redis = new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB) || 0,
    lazyConnect: true, // don't open a socket (or log a connection attempt) until the first command actually runs
    enableOfflineQueue: false, // reject commands immediately if Redis is not connected instead of queuing/hanging
    maxRetriesPerRequest: 1, // fail a pending command fast instead of queueing/retrying it repeatedly
    retryStrategy(times) {
        return Math.min(times * 500, 10_000);
    },
});

// REQUIRED — see file header. Without this, any connection-level Redis
// error is an unhandled EventEmitter "error" and crashes the process.
let hasLoggedOutage = false;
redis.on("error", (err) => {
    if (!hasLoggedOutage) {
        logger.warn(
            `Redis unavailable — Reports caching disabled, falling back to live queries until it recovers. (${err.message})`,
        );
        hasLoggedOutage = true;
    }
});

redis.on("connect", () => {
    if (hasLoggedOutage) {
        logger.info("Redis connection restored — caching re-enabled.");
    }
    hasLoggedOutage = false;
});

export default redis;
