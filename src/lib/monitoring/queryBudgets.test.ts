import { describe, expect, it } from "vitest";
import { ENDPOINT_QUERY_BUDGETS, evaluateEndpointQueryBudget } from "./queryBudgets";

describe("endpoint query budgets", () => {
  it("pins every hot Phase 1-3 read path to an explicit DB query ceiling", () => {
    expect(ENDPOINT_QUERY_BUDGETS).toMatchObject({
      "GET /api/v1/auth/session": 2,
      "GET /api/v1/admin/bootstrap": 3,
      "GET /api/v1/client": 2,
      "GET /api/v1/client/detail/:id": 2,
      "GET /api/v1/client/lookup": 1,
      "GET /api/v1/lead": 2,
      "GET /api/v1/lead/follow-ups": 3,
      "GET /api/v1/booking": 2,
      "GET /api/v1/dashboard/staff": 6,
      "GET /api/v1/job": 3,
      "GET /api/v1/staff": 2,
      "GET /api/v1/staff/lookup": 1,
      "GET /api/v1/invoice": 2,
      "GET /api/v1/payment": 2,
    });
  });

  it("reports a regression as soon as a route crosses its budget", () => {
    expect(evaluateEndpointQueryBudget("GET", "/api/v1/client", 2)).toBeNull();
    expect(evaluateEndpointQueryBudget("GET", "/api/v1/client", 17)).toEqual({ budget: 2, exceededBy: 15 });
    expect(evaluateEndpointQueryBudget("GET", "/api/v1/dashboard/staff", 7)).toEqual({ budget: 6, exceededBy: 1 });
  });
});
