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
import { BETTER_AUTH_URL, FRONTEND_URL, NODE_ENV, WEBSITE_BASE_DOMAIN } from "./config/ENV";
import { WebsiteHostResolverService } from "./modules/Website/websiteHostResolver.service";

import "../src/cron/staffStatus.cron";
import "../src/cron/recurringBooking.cron";
import "../src/cron/invoiceOverdue.cron";
// PERF FIX (Phase 1.1): keeps the Neon Postgres compute instance warm so
// requests don't pay a multi-second cold-start cost after idle periods.
// See dbKeepAlive.cron.ts for full context.
import "../src/cron/dbKeepAlive.cron";
// BUGFIX: unlike the three crons above (which self-schedule via a top-level
// cron.schedule() call the moment their module is imported), subscriptionExpiry.cron.ts
// deliberately wraps its scheduling in an exported scheduleSubscriptionExpiryJob()
// function (see that file's own header comment). A bare side-effect import
// never called it, so trial/paid subscription expiry silently never ran in
// production — accounts whose trial or billing period lapsed stayed ACTIVE
// forever with full feature access. Import the function and invoke it.
import { scheduleSubscriptionExpiryJob } from "../src/cron/subscriptionExpiry.cron";
import logRequestResponse from "./middlewares/logger.middleware";
import { requestContext } from "./middlewares/requestContext";

scheduleSubscriptionExpiryJob();

const app = express();

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
const allowedOrigins = [
  FRONTEND_URL,
  BETTER_AUTH_URL,
  "http://localhost:3000",
  "http://localhost:3001",
  "http://localhost:5000",
  "https://cleaning-crm-clients.vercel.app",
  "https://cleaningcrm.opygen.com",
].filter(Boolean) as string[];

const corsCommon = {
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "Cookie",
    "X-Requested-With",
    "Accept",
    "Origin",
    "Idempotency-Key",
  ],
  exposedHeaders: ["Content-Disposition", "X-Request-Id", "X-Response-Time"],
};

const authenticatedCors = cors({
  ...corsCommon,
  origin: true,
  credentials: true,
});
const publicWebsiteCors = cors({
  ...corsCommon,
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

// ─── Health check ─────────────────────────────────────────────────────────────
// Configure Railway / Render / Render healthcheck to hit GET /health.
// Returns 200 when DB + Redis are reachable, 503 when either is down.
app.get("/health", async (_req: Request, res: Response) => {
  let dbOk = false;
  let redisOk = false;

  try {
    const { prisma } = await import("./lib/prisma/prisma");
    await prisma.$queryRaw`SELECT 1`;
    dbOk = true;
  } catch {
    /* db unavailable */
  }

  try {
    const redis = (await import("./config/redis")).default;
    redisOk = (await redis.ping()) === "PONG";
  } catch {
    /* redis unavailable */
  }

  const allOk = dbOk && redisOk;
  res.status(allOk ? 200 : 503).json({
    success: allOk,
    status: allOk ? "ok" : "degraded",
    timestamp: new Date().toISOString(),
    checks: { database: dbOk, redis: redisOk },
  });
});

app.get("/", (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    message: "Cleaning CRM API is running....",
  });
});

app.use("/api/v1", maintenanceModeGate, routes);

app.use(globalErrorHandler);
app.use(notFound);

export default app;
