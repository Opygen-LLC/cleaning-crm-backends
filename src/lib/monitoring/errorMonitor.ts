import { createHash } from "node:crypto";
import {
  ERROR_MONITOR_SERVICE_NAME,
  ERROR_MONITOR_WEBHOOK_TOKEN,
  ERROR_MONITOR_WEBHOOK_URL,
  NODE_ENV,
  WEBSITE_ERROR_DEDUPE_TTL_SECONDS,
} from "../../config/ENV";
import redis from "../../config/redis";
import logger from "../logger";
import { traceAsyncOperation } from "./requestTrace";

interface MonitorEvent {
  level: "error" | "warning";
  source: "backend" | "public-website" | "dashboard-client";
  message: string;
  requestId?: string | null;
  traceId?: string | null;
  path?: string | null;
  method?: string | null;
  statusCode?: number | null;
  code?: string | null;
  kind?: string | null;
  stack?: string | null;
  websiteId?: string | null;
  digest?: string | null;
  userIdHash?: string | null;
  tenantIdHash?: string | null;
  apiRequestId?: string | null;
  releaseVersion?: string | null;
  browser?: string | null;
  bootstrapSchemaVersion?: number | null;
  metadata?: Record<string, unknown>;
}

const trim = (value: string | null | undefined, max: number): string | null =>
  value ? value.slice(0, max) : null;

const sanitizePath = (value: string | null | undefined): string | null => {
  const trimmed = trim(value, 800);
  if (!trimmed) return null;
  try {
    // Public client errors send pathnames, but strip search/hash defensively in
    // case an older client reports a full URL containing customer query data.
    if (/^https?:\/\//i.test(trimmed)) {
      const url = new URL(trimmed);
      return `${url.pathname}`.slice(0, 800);
    }
    return trimmed.split("?", 1)[0]!.split("#", 1)[0]!.slice(0, 800);
  } catch {
    return "/";
  }
};

const shouldSendDashboardClientError = async (event: MonitorEvent): Promise<boolean> => {
  const fingerprint = createHash("sha256")
    .update([
      event.userIdHash ?? "unknown",
      event.tenantIdHash ?? "unknown",
      event.digest ?? "",
      event.message,
      sanitizePath(event.path) ?? "",
      event.metadata?.section ? String(event.metadata.section) : "",
      event.metadata?.onboardingStep ? String(event.metadata.onboardingStep) : "",
    ].join("|"))
    .digest("hex");

  try {
    const result = await redis.set(
      `dashboard-error-dedupe:v1:${fingerprint}`,
      "1",
      "EX",
      WEBSITE_ERROR_DEDUPE_TTL_SECONDS,
      "NX",
    );
    return result === "OK";
  } catch {
    return true;
  }
};

const shouldSendPublicWebsiteError = async (event: MonitorEvent): Promise<boolean> => {
  const fingerprint = createHash("sha256")
    .update([
      event.websiteId ?? "unknown",
      event.digest ?? "",
      event.message,
      sanitizePath(event.path) ?? "",
    ].join("|"))
    .digest("hex");

  try {
    const result = await redis.set(
      `public-error-dedupe:v1:${fingerprint}`,
      "1",
      "EX",
      WEBSITE_ERROR_DEDUPE_TTL_SECONDS,
      "NX",
    );
    return result === "OK";
  } catch {
    // Monitoring is best-effort. If Redis is unavailable, still deliver the
    // event instead of losing the only diagnostic signal for a real outage.
    return true;
  }
};

const post = async (event: MonitorEvent): Promise<void> => {
  const webhookUrl = ERROR_MONITOR_WEBHOOK_URL;
  if (!webhookUrl) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await traceAsyncOperation("external", "monitoring.webhook", () =>
      fetch(webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(ERROR_MONITOR_WEBHOOK_TOKEN
            ? { Authorization: `Bearer ${ERROR_MONITOR_WEBHOOK_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({
          service: ERROR_MONITOR_SERVICE_NAME,
          environment: NODE_ENV || "unknown",
          timestamp: new Date().toISOString(),
          ...event,
          message: trim(event.message, 1000),
          stack: trim(event.stack, 6000),
          path: sanitizePath(event.path),
        }),
        signal: controller.signal,
      }),
    );
  } catch (error) {
    // Monitoring must never create a second application failure loop.
    if (NODE_ENV === "development") {
      logger.warn(`Error monitor delivery failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    clearTimeout(timeout);
  }
};

const captureBackendError = (event: Omit<MonitorEvent, "source" | "level">) =>
  post({ ...event, source: "backend", level: "error" });

const capturePublicWebsiteError = async (event: Omit<MonitorEvent, "source" | "level">) => {
  const normalized: MonitorEvent = { ...event, source: "public-website", level: "error" };
  if (!await shouldSendPublicWebsiteError(normalized)) return;
  await post(normalized);
};

const captureDashboardClientError = async (event: Omit<MonitorEvent, "source" | "level">) => {
  const normalized: MonitorEvent = { ...event, source: "dashboard-client", level: "error" };
  if (!await shouldSendDashboardClientError(normalized)) return;
  logger.error("dashboard_client_error", {
    event: "dashboard_client_error",
    route: sanitizePath(normalized.path) ?? "/",
    section: String(normalized.metadata?.section ?? "unknown"),
    errorName: String(normalized.metadata?.errorName ?? "Error"),
    errorKind: String(normalized.metadata?.errorKind ?? "unknown"),
    onboardingStep: normalized.metadata?.onboardingStep ?? null,
    userHash: normalized.userIdHash ?? null,
    tenantHash: normalized.tenantIdHash ?? null,
    releaseSha: normalized.releaseVersion ?? "unknown",
    requestId: normalized.requestId ?? null,
    traceId: normalized.traceId ?? normalized.metadata?.traceId ?? null,
    relatedTraceId: normalized.metadata?.relatedTraceId ?? null,
    apiRequestId: normalized.apiRequestId ?? null,
    digest: normalized.digest ?? null,
    errorMessage: trim(normalized.message, 400) ?? "unknown",
  });
  await post(normalized);
};

export const ErrorMonitor = {
  captureBackendError,
  capturePublicWebsiteError,
  captureDashboardClientError,
};
