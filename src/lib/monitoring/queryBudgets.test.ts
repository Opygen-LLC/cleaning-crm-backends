import { describe, expect, it } from "vitest";
import { ENDPOINT_QUERY_BUDGETS, evaluateEndpointQueryBudget } from "./queryBudgets";

describe("endpoint query budgets", () => {
  it("contains the Phase 3 critical-path budgets", () => {
    expect(ENDPOINT_QUERY_BUDGETS).toMatchObject({
      "GET /api/v1/auth/session": 2,
      "GET /api/v1/admin/bootstrap": 3,
      "GET /api/v1/notification/inbox": 2,
      "PUT /api/v1/website/booking-setup": 10,
      "POST /api/v1/website/launch": 15,
      "POST /api/v1/auth/register": 12,
    });
  });

  it("fails only when the route exceeds its budget", () => {
    expect(evaluateEndpointQueryBudget("GET", "/api/v1/auth/session", 2)).toBeNull();
    expect(evaluateEndpointQueryBudget("GET", "/api/v1/auth/session", 3)).toEqual({ budget: 2, exceededBy: 1 });
  });
});
