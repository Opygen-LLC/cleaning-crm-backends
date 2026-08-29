import { beforeEach, describe, expect, it } from "vitest";
import {
  getProductReliabilitySnapshot,
  recordClientReliabilitySignals,
  recordProductReliabilitySignal,
  resetProductReliabilityMetricsForTests,
} from "./productReliabilityMetrics";

beforeEach(() => resetProductReliabilityMetricsForTests());

describe("product reliability signals", () => {
  it("classifies onboarding render, chunk and contract failures without storing payload data", () => {
    recordClientReliabilitySignals({
      section: "active-step",
      errorKind: "chunk-load",
      message: "SERVICE_CATALOG_SCHEMA_MISMATCH",
      releaseVersion: "sha-123",
      route: "/admin/onboarding",
      onboardingStep: "services",
      requestId: "req-1",
      traceId: "trace-1",
    });

    const snapshot = getProductReliabilitySnapshot();
    expect(snapshot.counts.ONBOARDING_STEP_RENDER_ERROR).toBe(1);
    expect(snapshot.counts.CHUNK_LOAD_ERROR).toBe(1);
    expect(snapshot.counts.SERVICE_CATALOG_SCHEMA_MISMATCH).toBe(1);
    expect(snapshot.recent[0]).toMatchObject({
      releaseVersion: "sha-123",
      onboardingStep: "services",
      requestId: "req-1",
      traceId: "trace-1",
    });
  });

  it("tracks transactional and preview failures independently", () => {
    recordProductReliabilitySignal({
      code: "ONBOARDING_TRANSACTION_FAILURE",
      releaseVersion: "sha-1",
      route: "/api/v1/admin/onboarding/services",
      onboardingStep: "services",
      requestId: null,
      traceId: null,
    });
    recordProductReliabilitySignal({
      code: "WEBSITE_PREVIEW_FAILURE",
      releaseVersion: "sha-1",
      route: "/api/v1/website/preview",
      onboardingStep: null,
      requestId: null,
      traceId: null,
    });

    const snapshot = getProductReliabilitySnapshot();
    expect(snapshot.counts.ONBOARDING_TRANSACTION_FAILURE).toBe(1);
    expect(snapshot.counts.WEBSITE_PREVIEW_FAILURE).toBe(1);
  });
});
