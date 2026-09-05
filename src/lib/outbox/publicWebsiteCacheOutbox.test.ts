import { beforeEach, describe, expect, it, vi } from "vitest";

const { outboxCreateMock, traceAsyncOperationMock, loggerWarnMock } = vi.hoisted(() => ({
  outboxCreateMock: vi.fn(),
  traceAsyncOperationMock: vi.fn(async (_kind: string, _name: string, operation: () => Promise<unknown>) => operation()),
  loggerWarnMock: vi.fn(),
}));

vi.mock("../../config/ENV", () => ({
  NEXT_REVALIDATE_URL: "https://frontend.example.com/api/public-site/revalidate",
  NEXT_REVALIDATE_SECRET: "phase5-regression-secret-phase5-regression-secret",
  NEXT_REVALIDATE_TIMEOUT_MS: 2_500,
}));
vi.mock("../prisma/prisma", () => ({ prisma: { outboxEvent: { create: outboxCreateMock } } }));
vi.mock("../monitoring/requestTrace", () => ({
  getTracePropagationMetadata: vi.fn(() => null),
  traceAsyncOperation: traceAsyncOperationMock,
}));
vi.mock("../logger", () => ({ default: { warn: loggerWarnMock } }));

import { PublicWebsiteCacheRevalidation } from "./publicWebsiteCacheOutbox";

const payload = {
  websiteId: "123e4567-e89b-42d3-a456-426614174000",
  tenantIdentifier: "sparkle",
  tenantIdentifiers: ["sparkle", "www.sparkle.example"],
  reason: "website-published",
};

beforeEach(() => {
  vi.clearAllMocks();
  outboxCreateMock.mockResolvedValue({ id: "outbox-1" });
  vi.stubGlobal("fetch", vi.fn());
});

describe("public website cache revalidation fallback", () => {
  it("uses direct Next revalidation without creating an outbox row on success", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    await expect(PublicWebsiteCacheRevalidation.triggerWithFallback(payload)).resolves.toEqual({
      configured: true,
      delivered: true,
      queued: false,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outboxCreateMock).not.toHaveBeenCalled();
  });

  it("queues exactly one durable retry when the direct callback fails", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("frontend unavailable", { status: 503 }));

    await expect(PublicWebsiteCacheRevalidation.triggerWithFallback(payload)).resolves.toEqual({
      configured: true,
      delivered: false,
      queued: true,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outboxCreateMock).toHaveBeenCalledTimes(1);
    expect(outboxCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        topic: "PUBLIC_WEBSITE_CACHE_INVALIDATION_REQUESTED",
        maxAttempts: 8,
        payload: expect.objectContaining({
          websiteId: payload.websiteId,
          tenantIdentifier: "sparkle",
          tenantIdentifiers: ["sparkle", "www.sparkle.example"],
          reason: "website-published",
        }),
      }),
    }));
  });
});
