import { createHash } from "node:crypto";
import type { Request } from "express";

/**
 * Extracts or synthesizes a stable client device identifier for rate limiting.
 *
 * Checks explicit client device headers (e.g. mobile apps, SPA storage) and
 * falls back to a deterministic hash of browser client hints (User-Agent,
 * Sec-CH-UA, Platform, Language).
 */
export function extractDeviceIdentifier(req: Request): string {
  const explicit =
    req.headers["x-device-id"] ??
    req.headers["x-client-device-id"] ??
    req.headers["x-device-fingerprint"];

  if (typeof explicit === "string" && explicit.trim()) {
    return explicit.trim().replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "generic-device";
  }

  const ua = String(req.headers["user-agent"] ?? "");
  const chUa = String(req.headers["sec-ch-ua"] ?? "");
  const chPlatform = String(req.headers["sec-ch-ua-platform"] ?? "");
  const chMobile = String(req.headers["sec-ch-ua-mobile"] ?? "");
  const lang = String(req.headers["accept-language"] ?? "");

  const fingerprintSource = `${ua}|${chUa}|${chPlatform}|${chMobile}|${lang}`;
  return createHash("sha256")
    .update(fingerprintSource)
    .digest("hex")
    .slice(0, 32);
}

export function extractClientIp(req: Request): string {
  const cfIp = req.headers["cf-connecting-ip"];
  if (typeof cfIp === "string" && cfIp.trim()) {
    return cfIp.trim().slice(0, 45);
  }
  const xRealIp = req.headers["x-real-ip"];
  if (typeof xRealIp === "string" && xRealIp.trim()) {
    return xRealIp.trim().slice(0, 45);
  }
  const xForwarded = req.headers["x-forwarded-for"];
  if (typeof xForwarded === "string" && xForwarded.trim()) {
    return xForwarded.split(",")[0].trim().slice(0, 45);
  }
  return req.ip || req.socket?.remoteAddress || "unknown-ip";
}

export function extractCompositeRateLimitKey(req: Request, prefix = "rate"): string {
  const ip = extractClientIp(req);
  const device = extractDeviceIdentifier(req);
  return `${prefix}:ip:${ip}:dev:${device}`;
}
