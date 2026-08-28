import { createHash } from "node:crypto";
import { ErrorMonitor } from "../../lib/monitoring/errorMonitor";
import type { ClientErrorPayload } from "./telemetry.validation";

const identityHash = (value: string | null | undefined): string | null =>
  value
    ? createHash("sha256").update(`dashboard-client:v1:${value}`).digest("hex").slice(0, 32)
    : null;

const reportClientError = async (input: {
  userId: string;
  tenantId?: string | null;
  requestId?: string | null;
  traceId?: string | null;
  payload: ClientErrorPayload;
}) => {
  await ErrorMonitor.captureDashboardClientError({
    message: input.payload.message,
    stack: input.payload.stack ?? null,
    digest: input.payload.digest ?? null,
    path: input.payload.route,
    userIdHash: identityHash(input.userId),
    tenantIdHash: identityHash(input.tenantId ?? input.userId),
    apiRequestId: input.payload.apiRequestId ?? input.requestId ?? null,
    releaseVersion: input.payload.releaseVersion,
    browser: input.payload.browser,
    requestId: input.requestId ?? null,
    code: "DASHBOARD_CLIENT_ERROR",
    metadata: {
      section: input.payload.section,
      componentStack: input.payload.componentStack ?? null,
      traceId: input.traceId ?? null,
      relatedTraceId: input.payload.relatedTraceId ?? null,
    },
  });
};

export const TelemetryService = { reportClientError };
