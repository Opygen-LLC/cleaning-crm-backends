import { PrismaPg } from "@prisma/adapter-pg";
import { DATABASE_URL, DB_POOL_MAX, SLOW_QUERY_THRESHOLD_MS } from "../../config/ENV";
import { PrismaClient } from "../../generated/prisma/client";
import logger from "../logger";

if (!DATABASE_URL) {
    throw new Error(
        "DATABASE_URL is not set. Check your .env file — the app cannot start without a database connection string.",
    );
}

// pg-connection-string currently treats sslmode=prefer/require/verify-ca as
// verify-full, but warns that their meaning will change in its next major
// version. Make the current secure behaviour explicit so upgrades cannot
// silently weaken certificate/hostname verification and local logs stay clean.
const connectionString = DATABASE_URL.replace(
    /([?&])sslmode=(?:prefer|require|verify-ca)(?=(&|$))/i,
    "$1sslmode=verify-full",
);

// Neon (and most serverless Postgres providers) can take several seconds to
// wake a suspended compute on the first query after idling, and the `pg`
// driver's default connectionTimeoutMillis is effectively unset / too short
// for that. These options give cold starts room to finish instead of
// failing fast with ETIMEDOUT, while still capping pool size sensibly for
// a serverless-friendly (pooled) connection string.
//
// PERF FIX (Phase 1.2): `max` was previously hardcoded to 10. A single
// dashboard load alone fires 13 parallel queries (see dashboard.service.ts),
// so two admins opening the dashboard at the same moment could already
// exceed a pool of 10, queueing every other in-flight request behind it —
// and with connectionTimeoutMillis at 20s, a starved request would hang for
// up to 20 seconds before failing. `max` is now configurable via
// DB_POOL_MAX (defaults to 10 if unset, matching the previous behaviour) so
// it can be raised to match what the Neon plan/compute size actually
// supports without a code change. Reducing the *number* of queries per
// request (Phase 2 adminId caching, Phase 3 pagination, Phase 4 SQL-side
// aggregation) still matters more than pool size alone — a bigger pool
// just buys headroom while those land.
//
// PERF FIX (Phase 1, performance audit — connection churn): the app server
// (AWS ap-south-1, Mumbai) and the database (Neon, us-east-1, Virginia) sit
// on different continents — every fresh connection pays for a full TCP + TLS
// + SCRAM-auth handshake across that link (roughly 6-10 network round trips)
// before a single query even runs. The previous config let the pool empty
// out (`idleTimeoutMillis: 30_000`) faster than real traffic or the 2-minute
// keep-alive cron would touch it again, so almost every query — including a
// bare `SELECT 1` — was silently paying for a full reconnect. That's the
// exact cause of "SELECT 1" logging 1.7-2.0s in production.
//
//   - `min`: keeps a small number of connections permanently open instead of
//     letting the pool drain to zero between requests, so a typical request
//     reuses a warm connection instead of re-handshaking from scratch.
//   - `idleTimeoutMillis`: raised well past the old 30s so connections
//     aren't evicted faster than normal request spacing (and faster than the
//     keep-alive cron, which is what made the old value actively harmful —
//     see dbKeepAlive.cron.ts).
//   - `keepAlive` / `keepAliveInitialDelayMillis`: TCP-level keepalive so
//     NAT gateways / load balancers along a long cross-region path don't
//     silently drop an idle-but-still-open socket before Postgres or the
//     pool itself would have closed it.
//
// This does NOT eliminate the ~250-300ms Mumbai<->Virginia network latency
// itself (that requires moving the DB and server into the same region —
// see Phase 0 of the performance audit) — it eliminates the *repeated
// reconnect tax* stacked on top of that latency on every request.
const adapter = new PrismaPg({
    connectionString,
    max: DB_POOL_MAX,
    min: Math.min(3, DB_POOL_MAX),
    idleTimeoutMillis: 10 * 60_000, // 10 min — was 30s (shorter than the keep-alive interval, which defeated its own purpose)
    // Raised from 20_000 -> 30_000: 20s could still time out during a slow
    // Neon cold-start wake (3-8s just to resume compute, before the query
    // itself even runs). 30s gives that headroom without masking genuine
    // connection failures.
    connectionTimeoutMillis: 30_000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
});

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
prisma.$on("query", (e: { query: string; params: string; duration: number }) => {
    if (e.duration > SLOW_QUERY_THRESHOLD_MS) {
        logger.warn(`[SLOW QUERY ${e.duration}ms] ${e.query} -- params: ${e.params}`);
    }
});

export { prisma };
