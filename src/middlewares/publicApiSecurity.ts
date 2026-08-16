import { rateLimit } from "express-rate-limit";
import type { Request } from "express";

const jsonMessage = (message: string) => ({
    success: false,
    message,
    error: { code: "PUBLIC_RATE_LIMITED", retryable: true },
});

const base = {
    windowMs: 15 * 60 * 1000,
    standardHeaders: "draft-8" as const,
    legacyHeaders: false,
};

/** Per-IP protection for unauthenticated reads. */
export const publicReadRateLimit = rateLimit({
    ...base,
    limit: 180,
    message: jsonMessage("Too many requests. Please try again shortly."),
});

/** Per-IP protection for unauthenticated writes/calculations. */
export const publicMutationRateLimit = rateLimit({
    ...base,
    limit: 30,
    message: jsonMessage("Too many submissions. Please wait and try again."),
});

/**
 * A second limiter protects each public resource/tenant even when abusive
 * traffic is distributed across many IPs. Route params are opaque public
 * identifiers; no tenant database lookup is required in middleware.
 */
export const publicResourceMutationRateLimit = rateLimit({
    ...base,
    limit: 240,
    keyGenerator: (req: Request) => {
        const key = req.params.slug ?? req.params.token ?? "public";
        return `public-resource:${String(key).slice(0, 160)}`;
    },
    message: jsonMessage("This public form is receiving too many requests. Please try again shortly."),
});
