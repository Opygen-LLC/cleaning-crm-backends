import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import {
    DATABASE_URL,
    DB_POOL_CONNECTION_TIMEOUT_MS,
    DB_POOL_IDLE_TIMEOUT_MS,
    DB_POOL_MAX,
    DB_POOL_MIN,
    SLOW_QUERY_THRESHOLD_MS,
} from "../../config/ENV";
import { PrismaClient } from "../../generated/prisma/client";
import logger from "../logger";
import { recordDatabaseQueryMetric } from "../monitoring/performanceMetrics";
import { instrumentPgPool, summarizeSql } from "../monitoring/pgInstrumentation";

if (!DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is not set. Check your .env file — the app cannot start without a database connection string.",
    );
}

const connectionString = DATABASE_URL;

const pool = new pg.Pool({
    connectionString,
    max: DB_POOL_MAX,
    min: DB_POOL_MIN,
    idleTimeoutMillis: DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: DB_POOL_CONNECTION_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 5_000,
});

const safeDriverCode = (error: unknown): string | undefined => {
    if (!error || typeof error !== "object") return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" && code.trim() ? code.trim().toUpperCase() : undefined;
};

pool.on("error", (error) => {
    // Never log DATABASE_URL or driver messages here: both can contain host or
    // credential details. The code + pool counters are enough to diagnose the
    // common network/provider failures while keeping production logs safe.
    logger.error("database_pool_error", {
        event: "database_pool_error",
        code: safeDriverCode(error) ?? "UNKNOWN",
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
    });
});

// Capture the request at checkout/query invocation. Prisma query event emitters
// may run outside the originating ALS scope, so do not count those a second time.
instrumentPgPool(pool, ({ durationMs, query, error, trace }) => {
    recordDatabaseQueryMetric(durationMs, query, error);
    const summary = summarizeSql(query);
    const requestId = trace?.requestId ?? "background";
    const threshold = trace ? SLOW_QUERY_THRESHOLD_MS : Math.max(SLOW_QUERY_THRESHOLD_MS, 1500);
    if (durationMs > threshold) {
        logger.warn("slow_database_query", { event: "slow_database_query", durationMs: Math.round(durationMs * 10) / 10,
            operation: summary.operation, table: summary.table, requestId, failed: error });
        // Never log values, URLs or raw SQL, even for prepared statements. SQL
        // shape fingerprints in performanceMetrics redact inline literals.
    }
});
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

export const getDatabasePoolSnapshot = () => ({
    configuredMin: DB_POOL_MIN,
    configuredMax: DB_POOL_MAX,
    idleTimeoutMs: DB_POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMs: DB_POOL_CONNECTION_TIMEOUT_MS,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
});

export const probeDatabaseConnection = async () => {
    const started = process.hrtime.bigint();
    try {
        await pool.query("SELECT 1");
        return {
            ok: true as const,
            latencyMs: Math.round((Number(process.hrtime.bigint() - started) / 1_000_000) * 10) / 10,
        };
    } catch (error) {
        return {
            ok: false as const,
            latencyMs: Math.round((Number(process.hrtime.bigint() - started) / 1_000_000) * 10) / 10,
            errorCode: safeDriverCode(error) ?? "DATABASE_CONNECTION_FAILED",
        };
    }
};

export { prisma };
