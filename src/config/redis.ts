import Redis from "ioredis";
import {
    REDIS_COMMAND_TIMEOUT_MS,
    REDIS_CONNECT_TIMEOUT_MS,
    REDIS_KEEPALIVE_MS,
    REDIS_MAX_RETRIES_PER_REQUEST,
} from "./ENV";
import dotenv from "dotenv";
import logger from "../lib/logger";
import { recordRedisReadMetric } from "../lib/monitoring/performanceMetrics";
import { recordTraceRedisCommand } from "../lib/monitoring/requestTrace";
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
        const isRecoveryProbe = commandName === "PING";
        const permit = acquireRedisCircuitPermit({ forceProbe: isRecoveryProbe });
        if (!permit) {
            const snapshot = getRedisCircuitSnapshot();
            return Promise.reject(new RedisCircuitOpenError(snapshot.retryAfterMs));
        }

        try {
            const result = originalSendCommand(...args);
            return Promise.resolve(result).then(
                (value) => {
                    recordRedisCircuitSuccess();
                    return value;
                },
                (error) => {
                    recordRedisCircuitFailure(error);
                    throw error;
                },
            );
        } catch (error) {
            recordRedisCircuitFailure(error);
            throw error;
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

// Instrument the cache commands used throughout the application without
// forcing every service to adopt a new Redis wrapper. Fast circuit-open
// rejections are recorded as Redis errors and are expected to be caught by
// cache callers, which then use PostgreSQL/source-of-truth paths.
const instrumentRedisCommands = () => {
    const target = redis as any;

    const wrapSingle = (command: "get" | "hget") => {
        const original = target[command].bind(redis);
        target[command] = async (...args: unknown[]) => {
            const started = process.hrtime.bigint();
            try {
                const value = await original(...args);
                const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
                recordTraceRedisCommand(durationMs, { hits: value == null ? 0 : 1, misses: value == null ? 1 : 0 });
                recordRedisReadMetric({ durationMs, hits: value == null ? 0 : 1, misses: value == null ? 1 : 0 });
                return value;
            } catch (error) {
                const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
                recordTraceRedisCommand(durationMs, { error: true });
                recordRedisReadMetric({ durationMs, hits: 0, misses: 0, error: true });
                throw error;
            }
        };
    };

    const originalMget = target.mget.bind(redis);
    target.mget = async (...args: unknown[]) => {
        const started = process.hrtime.bigint();
        try {
            const values = await originalMget(...args) as Array<string | null>;
            const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
            const hits = values.filter((value) => value != null).length;
            recordTraceRedisCommand(durationMs, { hits, misses: Math.max(0, values.length - hits) });
            recordRedisReadMetric({ durationMs, hits, misses: Math.max(0, values.length - hits) });
            return values;
        } catch (error) {
            const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
            recordTraceRedisCommand(durationMs, { error: true });
            recordRedisReadMetric({ durationMs, hits: 0, misses: 0, error: true });
            throw error;
        }
    };

    const wrapCommand = (command: string) => {
        if (typeof target[command] !== "function") return;
        const original = target[command].bind(redis);
        target[command] = async (...args: unknown[]) => {
            const started = process.hrtime.bigint();
            try {
                const value = await original(...args);
                recordTraceRedisCommand(Number(process.hrtime.bigint() - started) / 1_000_000);
                return value;
            } catch (error) {
                recordTraceRedisCommand(Number(process.hrtime.bigint() - started) / 1_000_000, { error: true });
                throw error;
            }
        };
    };

    wrapSingle("get");
    wrapSingle("hget");
    [
        "set", "setex", "del", "unlink", "sadd", "srem", "expire", "hset",
        "incr", "incrby", "decr", "scan", "sscan", "smembers", "eval",
        "publish", "ping", "call",
    ].forEach(wrapCommand);
};

instrumentRedisCommands();

export { getRedisCircuitSnapshot };
export default redis;
