import type { NextFunction, Request, Response } from "express";
import { TURNSTILE_SECRET_KEY } from "../config/ENV";
import { traceAsyncOperation } from "../lib/monitoring/requestTrace";
import { sendStructuredError } from "../shared/sendStructuredError";

const trapFields = ["companyWebsite", "website", "_gotcha", "fax"] as const;
const MIN_FORM_AGE_MS = 750;
const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_TURNSTILE_TOKEN_LENGTH = 4096;

type WebsiteSpamAction = "website_booking" | "website_estimate" | "website_contact" | "website_review";

const fail = (res: Response, message = "Invalid public submission") =>
  sendStructuredError(res, {
    statusCode: 400,
    code: "PUBLIC_SPAM_REJECTED",
    message,
    retryable: false,
  });

const getRequestHostname = (req: Request): string | null => {
  const raw = req.get("Origin")?.trim() || req.get("Referer")?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
};

const guard = async (
  req: Request,
  res: Response,
  next: NextFunction,
  options: { requireStartedAt: boolean; action?: WebsiteSpamAction },
) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  for (const field of trapFields) {
    const value = body[field];
    if (typeof value === "string" && value.trim()) return fail(res);
  }

  const startedAtHeader = req.get("X-Form-Started-At");
  if (options.requireStartedAt && !startedAtHeader) return fail(res);
  if (startedAtHeader) {
    const startedAt = Number(startedAtHeader);
    const age = Date.now() - startedAt;
    if (!Number.isFinite(startedAt) || age < MIN_FORM_AGE_MS || age > MAX_FORM_AGE_MS) {
      return fail(res);
    }
  }

  if (TURNSTILE_SECRET_KEY) {
    const token = req.get("X-Turnstile-Token")?.trim();
    if (!token || token.length > MAX_TURNSTILE_TOKEN_LENGTH) return fail(res, "Spam verification is required");
    try {
      const form = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token });
      if (req.ip) form.set("remoteip", req.ip);
      const response = await traceAsyncOperation(
        "external",
        "cloudflare.turnstile.verify",
        () => fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
          signal: AbortSignal.timeout(2500),
        }),
      );
      const result = await response.json() as {
        success?: boolean;
        hostname?: string;
        action?: string;
        "error-codes"?: string[];
      };
      if (!result.success) return fail(res, "Spam verification failed");

      // Bind the one-time token to this website hostname and the exact form
      // action. A token generated on another website/form cannot be replayed
      // against a tenant acquisition endpoint.
      const expectedHostname = getRequestHostname(req);
      if (expectedHostname && result.hostname?.toLowerCase().replace(/\.$/, "") !== expectedHostname) {
        return fail(res, "Spam verification failed");
      }
      if (options.action && result.action !== options.action) {
        return fail(res, "Spam verification failed");
      }
    } catch {
      return sendStructuredError(res, {
        statusCode: 503,
        code: "SPAM_VERIFICATION_UNAVAILABLE",
        message: "Spam verification is temporarily unavailable. Please try again.",
        retryable: true,
      });
    }
  }

  return next();
};

/** Backward-compatible protection for legacy shared public forms. */
export const publicSpamGuard = (req: Request, res: Response, next: NextFunction) =>
  guard(req, res, next, { requireStartedAt: false });

/** Stronger tenant-website spam guard with Turnstile action binding. */
export const publicWebsiteSpamGuard = (action?: WebsiteSpamAction) =>
  (req: Request, res: Response, next: NextFunction) =>
    guard(req, res, next, { requireStartedAt: true, action });
