import { describe, expect, it, vi } from "vitest";
import { buildWebsiteDraftConflictPayload, sendWebsiteDraftConflict } from "./websiteDraftConflictResponse";

const conflict = {
  message: "This website draft changed in another session.",
  expectedRevisionNumber: 15,
  currentRevisionNumber: 17,
};

describe("Website draft conflict HTTP contract", () => {
  it("includes both editor and server revisions in the 409 payload", () => {
    expect(buildWebsiteDraftConflictPayload(conflict, "request-123")).toEqual({
      success: false,
      code: "WEBSITE_DRAFT_CONFLICT",
      kind: "LIFECYCLE_CONFLICT",
      message: conflict.message,
      fieldErrors: {},
      retryable: false,
      requestId: "request-123",
      expectedRevisionNumber: 15,
      currentRevisionNumber: 17,
    });
  });

  it("sends private no-store 409 responses", () => {
    const json = vi.fn((value) => value);
    const status = vi.fn(() => ({ json }));
    const setHeader = vi.fn();
    const res = { locals: { requestId: "request-456" }, setHeader, status };

    sendWebsiteDraftConflict(res, conflict);

    expect(setHeader).toHaveBeenCalledWith("X-Request-Id", "request-456");
    expect(setHeader).toHaveBeenCalledWith("Cache-Control", "private, no-store");
    expect(status).toHaveBeenCalledWith(409);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({
      code: "WEBSITE_DRAFT_CONFLICT",
      retryable: false,
      expectedRevisionNumber: 15,
      currentRevisionNumber: 17,
    }));
  });
});
