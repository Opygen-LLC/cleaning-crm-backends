import type { NextFunction, Request, Response } from "express";
import { TURNSTILE_SECRET_KEY } from "../config/ENV";

const trapFields = ["companyWebsite", "website", "_gotcha", "fax"] as const;

const fail = (res: Response, message = "Invalid public submission") =>
  res.status(400).json({
    success: false,
    message,
    error: { code: "PUBLIC_SPAM_REJECTED", retryable: false },
  });

export const publicSpamGuard = async (req: Request, res: Response, next: NextFunction) => {
  const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
  for (const field of trapFields) {
    const value = body[field];
    if (typeof value === "string" && value.trim()) return fail(res);
  }

  // New website clients send the time at which the form became interactive.
  // The header is optional for legacy shared form URLs, but if supplied it must
  // be plausible: sub-second automated posts and stale replay payloads fail.
  const startedAtHeader = req.get("X-Form-Started-At");
  if (startedAtHeader) {
    const startedAt = Number(startedAtHeader);
    const age = Date.now() - startedAt;
    if (!Number.isFinite(startedAt) || age < 750 || age > 24 * 60 * 60 * 1000) {
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
