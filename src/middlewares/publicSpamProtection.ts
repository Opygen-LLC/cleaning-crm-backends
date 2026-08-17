import type { NextFunction, Request, Response } from "express";
import { TURNSTILE_SECRET_KEY } from "../config/ENV";

const trapFields = ["companyWebsite", "website", "_gotcha", "fax"] as const;
const MIN_FORM_AGE_MS = 750;
const MAX_FORM_AGE_MS = 24 * 60 * 60 * 1000;

const fail = (res: Response, message = "Invalid public submission") =>
  res.status(400).json({
    success: false,
    message,
    error: { code: "PUBLIC_SPAM_REJECTED", retryable: false },
  });

const guard = async (
  req: Request,
  res: Response,
  next: NextFunction,
  options: { requireStartedAt: boolean },
) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  for (const field of trapFields) {
    const value = body[field];
    if (typeof value === "string" && value.trim()) return fail(res);
  }

  // Website forms always send the time at which the form became interactive.
  // Requiring it on the new tenant website endpoints blocks basic scripted
  // POSTs before they reach tenant/database work. Legacy shared form URLs keep
  // it optional so existing embeds are not broken during migration.
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
    if (!token) return fail(res, "Spam verification is required");
    try {
      const form = new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: token });
      if (req.ip) form.set("remoteip", req.ip);
      const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(2500),
      });
      const result = await response.json() as { success?: boolean };
      if (!result.success) return fail(res, "Spam verification failed");
    } catch {
      return res.status(503).json({
        success: false,
        message: "Spam verification is temporarily unavailable. Please try again.",
        error: { code: "SPAM_VERIFICATION_UNAVAILABLE", retryable: true },
      });
    }
  }

  return next();
};

/** Backward-compatible protection for legacy shared public forms. */
export const publicSpamGuard = (req: Request, res: Response, next: NextFunction) =>
  guard(req, res, next, { requireStartedAt: false });

/** Stronger protection for the Phase 3+ tenant website acquisition endpoints. */
export const publicWebsiteSpamGuard = (req: Request, res: Response, next: NextFunction) =>
  guard(req, res, next, { requireStartedAt: true });
