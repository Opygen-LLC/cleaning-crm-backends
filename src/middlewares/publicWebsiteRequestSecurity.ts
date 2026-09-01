import type { NextFunction, Request, Response } from "express";
import { NODE_ENV } from "../config/ENV";
import { PublicWebsiteService } from "../modules/Website/publicWebsite.service";
import { WebsiteHostResolverService } from "../modules/Website/websiteHostResolver.service";
import { sendStructuredError } from "../shared/sendStructuredError";

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

const fail = (res: Response, code: string, message: string, statusCode = 403) =>
  sendStructuredError(res, { statusCode, code, message, retryable: false });

const originHost = (req: Request): string | null => {
  const raw = req.get("Origin")?.trim() || req.get("Referer")?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (NODE_ENV === "production" && url.protocol !== "https:") return null;
    if (NODE_ENV !== "production" && url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
};

/**
 * Website-scoped public POSTs are browser-facing acquisition endpoints, not a
 * generic server-to-server API. In production require a real tenant Origin and
 * prove that Origin resolves to the exact website named by the route. This is
 * an explicit second boundary after CORS (which browsers enforce but curl does
 * not) and prevents one tenant origin from submitting against another tenant.
 * Legacy shared BookingForm/EstimateForm URLs intentionally do not use this
 * middleware so existing third-party embeds remain backward-compatible.
 */
export const publicWebsiteMutationOriginGuard = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const identifier = String(req.params.identifier ?? "").trim();
  if (!identifier) return fail(res, "PUBLIC_WEBSITE_TENANT_INVALID", "Website not found", 404);

  const host = originHost(req);
  if (!host) {
    if (NODE_ENV !== "production") return next();
    return fail(res, "PUBLIC_WEBSITE_ORIGIN_REQUIRED", "This request must come from the business website");
  }
  if (NODE_ENV !== "production" && LOCAL_HOSTS.has(host)) return next();

  try {
    const [target, origin] = await Promise.all([
      PublicWebsiteService.resolveIdentifier(identifier),
      WebsiteHostResolverService.resolveHost(host),
    ]);
    if (target.websiteId !== origin.websiteId || origin.availability !== "live") {
      return fail(res, "PUBLIC_WEBSITE_ORIGIN_MISMATCH", "This request does not belong to this business website");
    }
    return next();
  } catch {
    return fail(res, "PUBLIC_WEBSITE_ORIGIN_INVALID", "This request must come from the business website");
  }
};


/**
 * Canonical Quote/Estimate tenant-root actions carry an explicit websiteId.
 * Bind the browser Origin to that exact website before the token service sees
 * the mutation. The quote/estimate service then performs the independent
 * token -> website ownership check, giving public document writes two tenant
 * isolation boundaries.
 */
export const publicDocumentMutationOriginGuard = async (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");

  const websiteId = String(req.params.websiteId ?? "").trim();
  if (!websiteId) return fail(res, "PUBLIC_DOCUMENT_TENANT_INVALID", "Website not found", 404);

  const host = originHost(req);
  if (!host) {
    if (NODE_ENV !== "production") return next();
    return fail(res, "PUBLIC_DOCUMENT_ORIGIN_REQUIRED", "This request must come from the business website");
  }
  if (NODE_ENV !== "production" && LOCAL_HOSTS.has(host)) return next();

  try {
    const origin = await WebsiteHostResolverService.resolveHost(host);
    if (origin.websiteId !== websiteId || origin.availability !== "live") {
      return fail(res, "PUBLIC_DOCUMENT_ORIGIN_MISMATCH", "This request does not belong to this business website");
    }
    return next();
  } catch {
    return fail(res, "PUBLIC_DOCUMENT_ORIGIN_INVALID", "This request must come from the business website");
  }
};

export const publicJsonOnly = (req: Request, res: Response, next: NextFunction) => {
  if (!req.is("application/json")) {
    return fail(res, "PUBLIC_JSON_REQUIRED", "Content-Type must be application/json", 415);
  }
  return next();
};

export const requestBodyLimit = (maxBytes: number) => (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const declared = Number(req.get("Content-Length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    return fail(res, "PUBLIC_REQUEST_TOO_LARGE", "Request payload is too large", 413);
  }

  // The global JSON parser already caps bodies at 64 KiB. Re-measure the
  // parsed JSON so chunked requests cannot bypass the endpoint-specific cap by
  // omitting Content-Length.
  try {
    const actual = Buffer.byteLength(JSON.stringify(req.body ?? {}), "utf8");
    if (actual > maxBytes) {
      return fail(res, "PUBLIC_REQUEST_TOO_LARGE", "Request payload is too large", 413);
    }
  } catch {
    return fail(res, "PUBLIC_REQUEST_INVALID", "Invalid request payload", 400);
  }
  return next();
};

export const publicTelemetryBodyLimit = requestBodyLimit(8 * 1024);
export const publicContactBodyLimit = requestBodyLimit(12 * 1024);
export const publicEstimateCalculationBodyLimit = requestBodyLimit(16 * 1024);
export const publicFormSubmissionBodyLimit = requestBodyLimit(32 * 1024);
