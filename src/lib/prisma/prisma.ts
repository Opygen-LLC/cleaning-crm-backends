import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import {
    DATABASE_URL,
    DB_POOL_CONNECTION_TIMEOUT_MS,
    DB_POOL_IDLE_TIMEOUT_MS,
    DB_POOL_MAX,
    DB_POOL_MIN,
    LOG_SQL_DETAILS,
    NODE_ENV,
    SLOW_QUERY_THRESHOLD_MS,
} from "../../config/ENV";
import { PrismaClient } from "../../generated/prisma/client";
import logger from "../logger";
import { recordDatabaseQueryMetric } from "../monitoring/performanceMetrics";
import { getRequestTrace, recordTraceDatabaseQuery } from "../monitoring/requestTrace";

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

const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
    adapter,
    log: [{ level: "query", emit: "event" }],
});

// PERF FIX (Phase 1.3): there was no visibility into query duration before
// this, so "it feels slow" had no concrete numbers to point at. Any query
// over SLOW_QUERY_THRESHOLD_MS (default 300ms) is logged via the existing
// winston logger (not console.warn, so it's captured by the same rotating
// file transport as the rest of the app) — use this to confirm the Phase
// 2–4 fixes actually move the needle, and to catch regressions later.
const summarizeQuery = (query: string) => {
    const normalized = query.replace(/\s+/g, " ").trim();
    const operation = normalized.match(/^(SELECT|INSERT|UPDATE|DELETE|WITH)/i)?.[1]?.toUpperCase() ?? "QUERY";
    const table =
        normalized.match(/(?:FROM|INTO|UPDATE|JOIN)\s+"(?:public)"\."([^"]+)"/i)?.[1]
        ?? normalized.match(/(?:FROM|INTO|UPDATE|JOIN)\s+"([^"]+)"/i)?.[1]
        ?? "database";
    return { operation, table, normalized };
};

prisma.$on("query", (e: { query: string; params: string; duration: number }) => {
    recordDatabaseQueryMetric(e.duration, e.query);
    const summary = summarizeQuery(e.query);
    recordTraceDatabaseQuery(e.duration, {
        operation: summary.operation,
        table: summary.table,
    });

    if (e.duration > SLOW_QUERY_THRESHOLD_MS) {
        // Query parameters are never logged: they can contain emails, tokens,
        // customer data or payment metadata. Local operators get a concise
        // operation/table summary; production keeps a structured event for
        // Google Cloud Logging. Full SQL is opt-in only for local debugging.
        const trace = getRequestTrace();
        const requestId = trace?.requestId ?? "background";
        const durationMs = Math.round(e.duration * 10) / 10;
        if (NODE_ENV === "production") {
            logger.warn("slow_database_query", {
                event: "slow_database_query",
                durationMs,
                operation: summary.operation,
                table: summary.table,
                requestId,
            });
        } else {
            const isBackground = requestId === "background";
            const threshold = isBackground ? Math.max(SLOW_QUERY_THRESHOLD_MS, 1500) : Math.max(SLOW_QUERY_THRESHOLD_MS, 800);
            if (e.duration > threshold || LOG_SQL_DETAILS) {
                const reqLabel = isBackground ? "background" : requestId.slice(0, 8);
                logger.warn(
                    `Slow database query — ${durationMs}ms · ${summary.operation} ${summary.table} · request ${reqLabel}`,
                );
                if (LOG_SQL_DETAILS) logger.debug(summary.normalized.slice(0, 1_500));
            }
        }
    }
});

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
