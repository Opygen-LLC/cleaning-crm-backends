/**
 * server.ts — Phase 1 Production Version
 *
 * KEY CHANGES vs original:
 *  1. CORS now uses a dynamic origin callback (supports env-driven prod domain)
 *  2. exposedHeaders includes "Content-Disposition" for CSV export filename
 *  3. GET /health endpoint for uptime monitors and Railway healthchecks
 *
 * Before deploying to production, set FRONTEND_URL in your .env to your
 * live Next.js domain, e.g. FRONTEND_URL=https://app.yourdomain.com
 */

import express, { Request, Response } from "express";
import routes from "./routes/index";
import compression from "compression";
import cors from "cors";
import { globalErrorHandler } from "./middlewares/globalErrorHandler";
import cookieParser from "cookie-parser";
import { notFound } from "./middlewares/notFound";
import { maintenanceModeGate } from "./middlewares/maintenanceMode";
import path from "path";
import {
  DB_POOL_CONNECTION_TIMEOUT_MS,
  DB_POOL_IDLE_TIMEOUT_MS,
  DB_POOL_MAX,
  DB_POOL_MIN,
  NODE_ENV,
  PERFORMANCE_METRICS_TOKEN,
  TRUST_PROXY_HOPS,
  WEBSITE_BASE_DOMAIN,
} from "./config/ENV";
import { WebsiteHostResolverService } from "./modules/Website/websiteHostResolver.service";
import { inspectWebsiteWildcardInfrastructure } from "./modules/Website/websitePlatformConfig";

import logRequestResponse from "./middlewares/logger.middleware";
import { requestContext } from "./middlewares/requestContext";
import { getPerformanceSnapshot } from "./lib/monitoring/performanceMetrics";
import { getInfrastructureAlignment } from "./lib/monitoring/infrastructure";
import { getAuthenticatedOrigins } from "./config/authSecurity";
import { browserOriginGuard } from "./middlewares/browserOriginGuard";

const app = express();

// Public rate limits and privacy-preserving analytics depend on req.ip. Trust
// only the explicitly configured number of ingress hops; never blindly trust
// arbitrary X-Forwarded-For input from direct internet clients.
if (TRUST_PROXY_HOPS > 0) app.set("trust proxy", TRUST_PROXY_HOPS);

// Assign a correlation ID before any parser/CORS/router work so even early
// failures can be traced from the browser to server logs.
app.use(requestContext);

app.set("view engine", "ejs");
app.set("views", path.resolve(process.cwd(), `src/lib/templates`));

app.use(express.json({ limit: "64kb" }));
app.use(express.static("./public"));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: "64kb" }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Authenticated CRM traffic is allowed only from the application origins below.
// Public tenant websites are intentionally handled separately: they may call
// only /api/v1/website/public/* and receive NON-credentialed CORS. This lets
// free subdomains/custom domains submit booking/estimate/contact forms without
// granting those origins browser access to authenticated CRM endpoints.
const allowedOrigins = getAuthenticatedOrigins();

const authenticatedCors = cors({
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type", "Authorization", "Cookie", "X-Requested-With", "Accept",
    "Origin", "Idempotency-Key", "X-Form-Started-At", "X-Turnstile-Token",
  ],
  exposedHeaders: ["Content-Disposition", "X-Request-Id", "X-Response-Time", "Server-Timing", "X-Bootstrap-Schema-Version"],
  origin: true,
  credentials: true,
});

// Tenant websites never need dashboard credentials. Keep the browser contract
// deliberately narrower than authenticated CRM CORS: read + acquisition POSTs
// only, no Authorization/Cookie headers and no credentialed requests.
const publicWebsiteCors = cors({
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type", "Accept", "Origin", "Idempotency-Key",
    "X-Form-Started-At", "X-Turnstile-Token",
  ],
  exposedHeaders: ["X-Request-Id", "X-Response-Time", "Server-Timing", "X-Website-Resolver-Source", "X-Bootstrap-Schema-Version"],
  origin: true,
  credentials: false,
});

const isWebsitePublicApiPath = (pathname: string) =>
  pathname === "/api/v1/website/public" || pathname.startsWith("/api/v1/website/public/");

const isAllowedPublicWebsiteOrigin = async (origin: string): Promise<boolean> => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const secureProtocol = url.protocol === "https:" || (NODE_ENV !== "production" && url.protocol === "http:");
  if (!secureProtocol || !hostname) return false;

  // Free platform subdomains are controlled by this deployment. Require exactly
  // one tenant label so nested/unrelated hostnames are never wildcard-trusted.
  if (WEBSITE_BASE_DOMAIN) {
    const suffix = `.${WEBSITE_BASE_DOMAIN}`;
    if (hostname.endsWith(suffix)) {
      const label = hostname.slice(0, -suffix.length);
      if (label && !label.includes(".")) return true;
    }
  }

  // Custom domains must already be VERIFIED in WebsiteDomain. The resolver is
  // Redis-backed, so this check is cheap on the steady-state public path and
  // fails closed if the hostname is not a live website domain.
  try {
    const resolved = await WebsiteHostResolverService.resolveHost(hostname);
    return resolved.routeKind === "custom_domain";
  } catch {
    return false;
  }
};

app.use(async (req, res, next) => {
  const origin = req.get("Origin");
  if (!origin) return authenticatedCors(req, res, next); // server-to-server / curl
  if (allowedOrigins.includes(origin)) return authenticatedCors(req, res, next);

  if (isWebsitePublicApiPath(req.path) && await isAllowedPublicWebsiteOrigin(origin)) {
    return publicWebsiteCors(req, res, next);
  }

  return res.status(403).json({
    success: false,
    message: "Origin is not allowed",
    error: { code: "CORS_ORIGIN_NOT_ALLOWED", retryable: false },
  });
});

app.use(compression());
app.use(logRequestResponse);

// ─── Health / performance diagnostics ───────────────────────────────────────
const safeDurationMs = (started: bigint) =>
  Math.round((Number(process.hrtime.bigint() - started) / 1_000_000) * 10) / 10;

const dependencyHealth = async () => {
  let dbOk = false;
  let redisOk = false;
  let databaseLatencyMs: number | null = null;
  let redisLatencyMs: number | null = null;

  await Promise.all([
    (async () => {
      const started = process.hrtime.bigint();
      try {
        const { prisma } = await import("./lib/prisma/prisma");
        await prisma.$queryRaw`SELECT 1`;
        dbOk = true;
      } finally { databaseLatencyMs = safeDurationMs(started); }
    })().catch(() => {}),
    (async () => {
      const started = process.hrtime.bigint();
      try {
        const redis = (await import("./config/redis")).default;
        redisOk = (await redis.ping()) === "PONG";
      } finally { redisLatencyMs = safeDurationMs(started); }
    })().catch(() => {}),
  ]);

  return {
    database: { ok: dbOk, latencyMs: databaseLatencyMs },
    redis: { ok: redisOk, latencyMs: redisLatencyMs },
  };
};

// Liveness must never depend on Postgres/Redis. Process managers should use
// this endpoint to decide whether the Node process itself needs restarting.
app.get("/livez", (_req: Request, res: Response) => {
  return res.status(200).json({ success: true, status: "alive", timestamp: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()) });
});

// Readiness requires the source-of-truth database. Redis is deliberately
// reported as degraded rather than fatal because every cache path has a DB
// fallback. This prevents a cache outage from causing a restart storm.
app.get("/readyz", async (_req: Request, res: Response) => {
  const checks = await dependencyHealth();
  const infrastructure = getInfrastructureAlignment();
  const ready = checks.database.ok && (!infrastructure.enforcementEnabled || infrastructure.aligned);
  const degraded = ready && !checks.redis.ok;
  return res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? (degraded ? "degraded" : "ready") : "not-ready",
    timestamp: new Date().toISOString(),
    checks,
    infrastructure,
  });
});

// Backward-compatible health endpoint. Keep existing monitors working while
// deployment health checks move to /livez and /readyz.
app.get("/health", async (_req: Request, res: Response) => {
  const checks = await dependencyHealth();
  const infrastructure = getInfrastructureAlignment();
  const ready = checks.database.ok && (!infrastructure.enforcementEnabled || infrastructure.aligned);
  return res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? (checks.redis.ok ? "ok" : "degraded") : "not-ready",
    timestamp: new Date().toISOString(),
    checks,
    infrastructure,
  });
});

app.get("/health/performance", (req: Request, res: Response) => {
  const supplied = req.get("x-monitoring-token") || req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (NODE_ENV === "production" && (!PERFORMANCE_METRICS_TOKEN || supplied !== PERFORMANCE_METRICS_TOKEN)) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  return res.status(200).json({
    success: true,
    data: {
      ...getPerformanceSnapshot(),
      infrastructure: getInfrastructureAlignment(),
      databasePool: {
        min: DB_POOL_MIN,
        max: DB_POOL_MAX,
        idleTimeoutMs: DB_POOL_IDLE_TIMEOUT_MS,
        connectionTimeoutMs: DB_POOL_CONNECTION_TIMEOUT_MS,
      },
    },
  });
});

app.get("/health/website-routing", async (req: Request, res: Response) => {
  const supplied = req.get("x-monitoring-token") || req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (NODE_ENV === "production" && (!PERFORMANCE_METRICS_TOKEN || supplied !== PERFORMANCE_METRICS_TOKEN)) {
    return res.status(404).json({ success: false, message: "Not found" });
  }

  const data = await inspectWebsiteWildcardInfrastructure();
  return res.status(data.ok ? 200 : 503).json({
    success: data.ok,
    status: data.ok ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    data,
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Cleaning CRM API is running....",
  });
});

app.use("/api/v1", browserOriginGuard, maintenanceModeGate, routes);

app.use(globalErrorHandler);
app.use(notFound);

export default app;
