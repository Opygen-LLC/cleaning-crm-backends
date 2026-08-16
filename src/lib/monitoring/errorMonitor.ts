import {
  ERROR_MONITOR_SERVICE_NAME,
  ERROR_MONITOR_WEBHOOK_TOKEN,
  ERROR_MONITOR_WEBHOOK_URL,
  NODE_ENV,
} from "../../config/ENV";
import logger from "../logger";

interface MonitorEvent {
  level: "error" | "warning";
  source: "backend" | "public-website";
  message: string;
  requestId?: string | null;
  path?: string | null;
  method?: string | null;
  statusCode?: number | null;
  code?: string | null;
  stack?: string | null;
  websiteId?: string | null;
  digest?: string | null;
  metadata?: Record<string, unknown>;
}

const trim = (value: string | null | undefined, max: number): string | null =>
  value ? value.slice(0, max) : null;

const post = async (event: MonitorEvent): Promise<void> => {
  if (!ERROR_MONITOR_WEBHOOK_URL) return;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(ERROR_MONITOR_WEBHOOK_URL, {
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
        path: trim(event.path, 800),
      }),
      signal: controller.signal,
    });
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

const capturePublicWebsiteError = (event: Omit<MonitorEvent, "source" | "level">) =>
  post({ ...event, source: "public-website", level: "error" });

export const ErrorMonitor = {
  captureBackendError,
  capturePublicWebsiteError,
};
