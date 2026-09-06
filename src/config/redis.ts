import Redis from "ioredis";
import {
    REDIS_COMMAND_TIMEOUT_MS,
    REDIS_CONNECT_TIMEOUT_MS,
    REDIS_KEEPALIVE_MS,
    REDIS_MAX_RETRIES_PER_REQUEST,
} from "./ENV";
import dotenv from "dotenv";
import logger from "../lib/logger";
import { recordRedisCommandMetric } from "../lib/monitoring/performanceMetrics";
import { getRequestTrace, recordTraceRedisCommand } from "../lib/monitoring/requestTrace";
import {
    RedisCircuitOpenError,
    acquireRedisCircuitPermit,
    forceCloseRedisCircuit,
    forceOpenRedisCircuit,
    getRedisCircuitSnapshot,
    recordRedisCircuitFailure,
    recordRedisCircuitSuccess,
} from "../lib/cache/redisCircuitBreaker";

dotenv.config();

/**
 * Redis is a cache/coordination layer, never the source of truth for customer
 * authorization. Commands fail fast and callers fall back to PostgreSQL where
 * safe. The circuit breaker below prevents every request from paying the Redis
 * timeout while an outage is already known, then permits a bounded recovery
 * probe after the cooldown.
 */
const redis = new Redis({
    host: process.env.REDIS_HOST || "127.0.0.1",
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB) || 0,
    lazyConnect: false,
    enableOfflineQueue: false,
    maxRetriesPerRequest: REDIS_MAX_RETRIES_PER_REQUEST,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
    keepAlive: REDIS_KEEPALIVE_MS,
    retryStrategy(times) {
        return Math.min(times * 500, 10_000);
    },
});

// Circuit-break at ioredis' common command dispatch point so existing services
// automatically gain fail-fast behavior without a risky application-wide API
// rewrite. PING is always allowed to become the recovery probe.
const installRedisCircuit = () => {
    const target = redis as any;
    const originalSendCommand = target.sendCommand.bind(redis);

    target.sendCommand = (...args: any[]) => {
        const command = args[0];
        const commandName = String(command?.name ?? "").toUpperCase();
        const trace = getRequestTrace();
        const started = process.hrtime.bigint();
        let done = false;
        const finish = (value: unknown, error = false) => {
            if (done) return; done = true;
            const read = ["GET", "HGET", "MGET", "HMGET"].includes(commandName);
            const values = read ? (Array.isArray(value) ? value : [value]) : [];
            const hits = error ? 0 : values.filter(item => item != null).length;
            const misses = error ? 0 : values.length - hits;
            const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
            try {
                recordTraceRedisCommand(durationMs, { hits, misses, error }, trace);
                recordRedisCommandMetric({ durationMs, hits, misses, error, read });
            } catch { /* Instrumentation cannot change a cache or lock operation. */ }
        };
        const permit = acquireRedisCircuitPermit({ forceProbe: commandName === "PING" });
        if (!permit) {
            const error = new RedisCircuitOpenError(getRedisCircuitSnapshot().retryAfterMs);
            finish(undefined, true);
            // Reject the Command as well as its returned promise. ioredis
            // pipelines settle command.promise, not the dispatch return value.
            command?.reject?.(error);
            const rejected = command?.promise ?? Promise.reject(error);
            return rejected;
        }
        try {
            const result = originalSendCommand(...args);
            // Observe without replacing the Command promise. Pipeline dispatch
            // ignores this return value and awaits command.promise; a rethrowing
            // observer would otherwise create an unhandled second rejection.
            void Promise.resolve(result).then(value => {
                recordRedisCircuitSuccess(); finish(value);
            }, error => { recordRedisCircuitFailure(error); finish(undefined, true); }).catch(() => { /* telemetry only */ });
            return result;
        } catch (error) {
            recordRedisCircuitFailure(error); finish(undefined, true); throw error;
        }
    };
};

installRedisCircuit();

// REQUIRED: without an error listener a Redis connection error can terminate
// the Node process. Connection-level failures open the circuit immediately;
// PostgreSQL-backed fallbacks therefore do not wait on Redis on every request.
let hasLoggedOutage = false;
redis.on("error", (err) => {
    forceOpenRedisCircuit();
    if (!hasLoggedOutage) {
        logger.warn("Redis unavailable; cache circuit opened and live-query fallback enabled", {
            event: "redis_circuit_open",
            error: err.message,
            circuit: getRedisCircuitSnapshot(),
        });
        hasLoggedOutage = true;
    }
});

redis.on("ready", () => {
    forceCloseRedisCircuit();
    if (hasLoggedOutage) {
        logger.info("Redis connection restored; cache circuit closed", {
            event: "redis_circuit_closed",
        });
    }
    hasLoggedOutage = false;
});

export { getRedisCircuitSnapshot };
export default redis;
