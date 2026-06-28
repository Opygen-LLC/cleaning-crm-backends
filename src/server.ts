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
import path from "path";
import { BETTER_AUTH_URL, FRONTEND_URL } from "./config/ENV";

import "../src/cron/staffStatus.cron";
import "../src/cron/recurringBooking.cron";
import "../src/cron/invoiceOverdue.cron";
import "../src/cron/subscriptionExpiry.cron";
import logRequestResponse from "./middlewares/logger.middleware";

const app = express();

app.set("view engine", "ejs");
app.set("views", path.resolve(process.cwd(), `src/lib/templates`));

app.use(express.json());
app.use(express.static("./public"));
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Add your production Next.js domain to FRONTEND_URL in the environment.
// The static list below covers local dev and the known Vercel staging URL.
const allowedOrigins = [
    FRONTEND_URL,
    BETTER_AUTH_URL,
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:5000",
    "https://cleaning-crm-clients.vercel.app",
].filter(Boolean) as string[];

app.use(
    cors({
        origin: (origin, callback) => {
            if (!origin) return callback(null, true); // server-to-server / curl
            if (allowedOrigins.includes(origin)) return callback(null, true);
            callback(new Error(`CORS: origin '${origin}' not allowed`));
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization", "Cookie", "X-Requested-With", "Accept", "Origin"],
        // Allow FE to read Content-Disposition header for CSV file downloads
        exposedHeaders: ["Content-Disposition"],
    }),
);

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
    } catch { /* db unavailable */ }

    try {
        const redis = (await import("./config/redis")).default;
        redisOk = (await redis.ping()) === "PONG";
    } catch { /* redis unavailable */ }

    const allOk = dbOk && redisOk;
    res.status(allOk ? 200 : 503).json({
        success: allOk,
        status: allOk ? "ok" : "degraded",
        timestamp: new Date().toISOString(),
        checks: { database: dbOk, redis: redisOk },
    });
});

app.get("/", (_req: Request, res: Response) => {
    res.status(200).json({ success: true, message: "Cleaning CRM API is running...." });
});

app.use("/api/v1", routes);

app.use(globalErrorHandler);
app.use(notFound);

export default app;
