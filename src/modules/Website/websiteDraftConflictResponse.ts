import { randomUUID } from "crypto";
import status from "http-status";

export interface WebsiteDraftConflictLike {
  message: string;
  expectedRevisionNumber: number;
  currentRevisionNumber: number;
}

export const buildWebsiteDraftConflictPayload = (
  error: WebsiteDraftConflictLike,
  requestId?: string | null,
) => ({
  success: false as const,
  code: "WEBSITE_DRAFT_CONFLICT" as const,
  kind: "LIFECYCLE_CONFLICT" as const,
  message: error.message,
  fieldErrors: {},
  retryable: false as const,
  requestId: requestId?.trim() || randomUUID(),
  expectedRevisionNumber: error.expectedRevisionNumber,
  currentRevisionNumber: error.currentRevisionNumber,
});

export const sendWebsiteDraftConflict = (res: any, error: WebsiteDraftConflictLike) => {
  const payload = buildWebsiteDraftConflictPayload(error, res.locals?.requestId);
  res.setHeader("X-Request-Id", payload.requestId);
  res.setHeader("Cache-Control", "private, no-store");
  return res.status(status.CONFLICT).json(payload);
};
