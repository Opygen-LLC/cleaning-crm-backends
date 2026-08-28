import { describe, expect, it, vi } from "vitest";

vi.mock("../../config/ENV", () => ({
  APP_REGION: "aws-us-east-1",
  DATABASE_REGION: "aws-us-east-1",
  DEPLOYMENT_PROFILE: "primary-region",
  PRIMARY_REGION: "aws-us-east-1",
  PROCESS_REGION: "aws-us-east-1",
  PROCESS_ROLE: "api",
  REDIS_REGION: "local",
  REQUIRE_COLOCATED_INFRA: true,
}));

import { assertInfrastructureAlignment, getInfrastructureAlignment } from "./infrastructure";

describe("infrastructure primary-region contract", () => {
  it("resolves local Redis to the API region and accepts a colocated stack", () => {
    const alignment = getInfrastructureAlignment();
    expect(alignment.topology).toBe("global-edge-primary-region");
    expect(alignment.redisRegion).toBe("aws-us-east-1");
    expect(alignment.aligned).toBe(true);
    expect(() => assertInfrastructureAlignment()).not.toThrow();
  });
});
