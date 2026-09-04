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
  APP_VERSION,
  BUILD_DATE,
  GIT_SHA,
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
import { getProductReliabilitySnapshot } from "./lib/monitoring/productReliabilityMetrics";
import { getMonitoringAlerts } from "./lib/monitoring/alerting";
import { getInfrastructureAlignment } from "./lib/monitoring/infrastructure";
import { getAuthenticatedOrigins } from "./config/authSecurity";
import { browserOriginGuard } from "./middlewares/browserOriginGuard";
import { getRedisCircuitSnapshot } from "./config/redis";
import { AUTH_ERROR_CODES } from "./modules/Auth/auth.codes";
import {
  getDatabasePoolSnapshot,
  probeDatabaseConnection,
} from "./lib/prisma/prisma";
import { getEmailOutboxHealth } from "./lib/monitoring/emailOutboxHealth";
import { getOperationalHealthSnapshot } from "./lib/monitoring/operationalHealth";
import { isTenantPublicApiPath } from "./lib/security/tenantPublicApiPolicy";

const app = express();

// Public rate limits and privacy-preserving analytics depend on req.ip. In
// production, trust only the explicitly configured ingress hop count. Local
// development commonly runs through the Next.js dev server / local reverse
// proxy, which sets X-Forwarded-For; trust exactly one hop there so
// express-rate-limit can resolve the real client IP without emitting its
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR validation error.
const effectiveTrustProxyHops =
  TRUST_PROXY_HOPS > 0 ? TRUST_PROXY_HOPS : NODE_ENV !== "production" ? 1 : 0;
if (effectiveTrustProxyHops > 0)
  app.set("trust proxy", effectiveTrustProxyHops);

// Assign a correlation ID before any parser/CORS/router work so even early
// failures can be traced from the browser to server logs.
app.use(requestContext);
// Log before parsers/CORS so malformed or rejected auth requests still receive correlation.
app.use(logRequestResponse);

app.set("view engine", "ejs");
app.set("views", path.resolve(process.cwd(), `src/lib/templates`));

app.use(express.json({ limit: "64kb" }));
app.use(express.static("./public"));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true, limit: "64kb" }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Authenticated CRM traffic is allowed only from the application origins below.
// Public tenant websites are intentionally handled separately: they may call
// only the explicitly classified tenant-public API families and receive
// NON-credentialed CORS. This lets free subdomains/custom domains submit forms
// and respond to public quotes/estimates without granting browser access to
// authenticated CRM endpoints.
const allowedOrigins = getAuthenticatedOrigins();

const authenticatedCors = cors({
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Cookie",
    "X-Requested-With",
    "Accept",
    "Origin",
    "Idempotency-Key",
    "X-Form-Started-At",
    "X-Turnstile-Token",
    "X-Request-Id",
    "X-Trace-Id",
    "Traceparent",
    "X-CSRF-Protection",
  ],
  exposedHeaders: [
    "Content-Disposition",
    "X-Request-Id",
    "X-Trace-Id",
    "X-Response-Time",
    "Server-Timing",
    "X-Bootstrap-Schema-Version",
    "X-Release-Sha",
  ],
  origin: true,
  credentials: true,
});

// Tenant websites never need dashboard credentials. Keep the browser contract
// deliberately narrower than authenticated CRM CORS: read + acquisition POSTs
// only, no Authorization/Cookie headers and no credentialed requests.
const tenantPublicApiCors = cors({
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Accept",
    "Origin",
    "Idempotency-Key",
    "X-Form-Started-At",
    "X-Turnstile-Token",
    "X-Request-Id",
    "X-Trace-Id",
    "Traceparent",
  ],
  exposedHeaders: [
    "X-Request-Id",
    "X-Trace-Id",
    "X-Response-Time",
    "Server-Timing",
    "X-Website-Resolver-Source",
    "X-Bootstrap-Schema-Version",
    "X-Release-Sha",
  ],
  origin: true,
  credentials: false,
});

const isAllowedPublicWebsiteOrigin = async (
  origin: string,
): Promise<boolean> => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  const secureProtocol =
    url.protocol === "https:" ||
    (NODE_ENV !== "production" && url.protocol === "http:");
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

  if (
    isTenantPublicApiPath(req.path) &&
    (await isAllowedPublicWebsiteOrigin(origin))
  ) {
    return tenantPublicApiCors(req, res, next);
  }

  res.locals.authErrorCode = AUTH_ERROR_CODES.AUTH_ORIGIN_NOT_ALLOWED;
  return res.status(403).json({
    statusCode: 403,
    success: false,
    code: AUTH_ERROR_CODES.AUTH_ORIGIN_NOT_ALLOWED,
    message: "Origin is not allowed",
    retryable: false,
    errorSources: [],
    fieldErrors: {},
    requestId:
      typeof res.locals.requestId === "string"
        ? res.locals.requestId
        : undefined,
  });
});

app.use(compression());

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
      const probe = await probeDatabaseConnection();
      dbOk = probe.ok;
      databaseLatencyMs = probe.latencyMs;
    })().catch(() => {}),
    (async () => {
      const started = process.hrtime.bigint();
      try {
        const redis = (await import("./config/redis")).default;
        redisOk = (await redis.ping()) === "PONG";
      } finally {
        redisLatencyMs = safeDurationMs(started);
      }
    })().catch(() => {}),
  ]);

  return {
    database: { ok: dbOk, latencyMs: databaseLatencyMs },
    redis: { ok: redisOk, latencyMs: redisLatencyMs },
  };
};

if (
  NODE_ENV === "production" &&
  (!PERFORMANCE_METRICS_TOKEN || PERFORMANCE_METRICS_TOKEN.length < 32)
) {
  throw new Error(
    "PERFORMANCE_METRICS_TOKEN must be configured with at least 32 characters in production",
  );
}

const monitoringTokenAllowed = (req: Request): boolean => {
  if (NODE_ENV !== "production") return true;
  const supplied =
    req.get("x-monitoring-token") ||
    req.get("authorization")?.replace(/^Bearer\s+/i, "");
  return Boolean(
    PERFORMANCE_METRICS_TOKEN && supplied === PERFORMANCE_METRICS_TOKEN,
  );
};

app.get("/", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(200).json({
    success: true,
    service: "Cleaning CRM Backend API 04 Sep 5:08 PM",
    status: "healthy",
    version: APP_VERSION,
    gitSha: GIT_SHA,
    buildDate: BUILD_DATE,
  });
});

app.get("/livez", (_req: Request, res: Response) => {
  return res.status(200).json({ success: true, status: "alive" });
});

app.get("/readyz", async (_req: Request, res: Response) => {
  const checks = await dependencyHealth();
  const infrastructure = getInfrastructureAlignment();
  const ready =
    checks.database.ok &&
    (!infrastructure.enforcementEnabled || infrastructure.aligned);
  const degraded = ready && !checks.redis.ok;
  return res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? (degraded ? "degraded" : "ready") : "not-ready",
  });
});

app.get("/health", async (_req: Request, res: Response) => {
  const checks = await dependencyHealth();
  const infrastructure = getInfrastructureAlignment();
  const ready =
    checks.database.ok &&
    (!infrastructure.enforcementEnabled || infrastructure.aligned);
  return res
    .status(ready ? 200 : 503)
    .json({ success: ready, status: ready ? "ok" : "not-ready" });
});

app.get("/health/details", async (req: Request, res: Response) => {
  if (!monitoringTokenAllowed(req))
    return res.status(404).json({ success: false, message: "Not found" });
  const checks = await dependencyHealth();
  const infrastructure = getInfrastructureAlignment();
  const ready =
    checks.database.ok &&
    (!infrastructure.enforcementEnabled || infrastructure.aligned);
  return res.status(ready ? 200 : 503).json({
    success: ready,
    status: ready ? (checks.redis.ok ? "ok" : "degraded") : "not-ready",
    timestamp: new Date().toISOString(),
    checks,
    infrastructure,
    redisCircuit: getRedisCircuitSnapshot(),
    databasePool: getDatabasePoolSnapshot(),
  });
});

app.get("/health/performance", (req: Request, res: Response) => {
  if (!monitoringTokenAllowed(req))
    return res.status(404).json({ success: false, message: "Not found" });
  return res.status(200).json({
    success: true,
    data: {
      ...getPerformanceSnapshot(),
      productReliability: getProductReliabilitySnapshot(),
      infrastructure: getInfrastructureAlignment(),
      databasePool: getDatabasePoolSnapshot(),
    },
  });
});

app.get("/health/alerts", (req: Request, res: Response) => {
  if (!monitoringTokenAllowed(req))
    return res.status(404).json({ success: false, message: "Not found" });
  const data = getMonitoringAlerts();
  res.setHeader("Cache-Control", "private, no-store");
  return res
    .status(data.healthy ? 200 : 503)
    .json({ success: data.healthy, data });
});

app.get("/health/email-outbox", async (req: Request, res: Response) => {
  if (!monitoringTokenAllowed(req))
    return res.status(404).json({ success: false, message: "Not found" });
  const data = await getEmailOutboxHealth();
  res.setHeader("Cache-Control", "private, no-store");
  return res
    .status(data.healthy ? 200 : 503)
    .json({ success: data.healthy, data });
});

app.get("/health/operations", async (req: Request, res: Response) => {
  if (!monitoringTokenAllowed(req))
    return res.status(404).json({ success: false, message: "Not found" });
  const data = await getOperationalHealthSnapshot();
  res.setHeader("Cache-Control", "private, no-store");
  return res
    .status(data.healthy ? 200 : 503)
    .json({ success: data.healthy, data });
});

app.get("/health/website-routing", async (req: Request, res: Response) => {
  if (!monitoringTokenAllowed(req))
    return res.status(404).json({ success: false, message: "Not found" });
  const data = await inspectWebsiteWildcardInfrastructure();
  return res.status(data.ok ? 200 : 503).json({
    success: data.ok,
    status: data.ok ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    data,
  });
});

app.get("/version", (_req: Request, res: Response) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  return res.status(200).json({
    version: APP_VERSION,
    gitSha: GIT_SHA,
    buildDate: BUILD_DATE,
  });
});

app.use("/api/v1", browserOriginGuard, maintenanceModeGate, routes);

app.use(globalErrorHandler);
app.use(notFound);

export default app;
