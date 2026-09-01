export const QUERY_BUDGET_EXCEEDED_CODE = "QUERY_BUDGET_EXCEEDED";

export const ENDPOINT_QUERY_BUDGETS = {
  "GET /api/v1/auth/session": 2,
  "GET /api/v1/admin/bootstrap": 3,
  "GET /api/v1/notification/inbox": 2,
  "GET /api/v1/admin/usage": 5,
  "PUT /api/v1/website/booking-setup": 10,
  "PUT /api/v1/website/draft": 10,
  "POST /api/v1/website/launch": 15,
  "POST /api/v1/auth/register": 12,

  // Phase 3 hot CRUD/query paths. List endpoints should normally be one data
  // query + one count query; staff-specific paths may need one additional
  // profile/assignment lookup. Dashboard budgets reflect their purpose-built
  // aggregate projections rather than allowing unbounded query fan-out.
  "GET /api/v1/client": 2,
  "GET /api/v1/client/detail/:id": 2,
  "GET /api/v1/client/lookup": 1,
  "GET /api/v1/lead": 2,
  "GET /api/v1/lead/follow-ups": 3,
  "GET /api/v1/lead/follow-ups/calendar": 2,
  "GET /api/v1/booking": 2,
  "GET /api/v1/dashboard/overview": 8,
  "GET /api/v1/dashboard/staff": 6,
  "GET /api/v1/job": 3,
  "GET /api/v1/staff": 2,
  "GET /api/v1/staff/lookup": 1,
  "GET /api/v1/invoice": 2,
  "GET /api/v1/payment": 2,
  "GET /api/v1/payment/stats": 3,
} as const;

export type QueryBudgetKey = keyof typeof ENDPOINT_QUERY_BUDGETS;

export const getEndpointQueryBudget = (method: string, route: string): number | null => {
  const normalizedRoute = route.length > 1 ? route.replace(/\/+$/, "") : route;
  const key = `${method.toUpperCase()} ${normalizedRoute}` as QueryBudgetKey;
  return ENDPOINT_QUERY_BUDGETS[key] ?? null;
};

export const evaluateEndpointQueryBudget = (
  method: string,
  route: string,
  queryCount: number,
): { budget: number; exceededBy: number } | null => {
  const budget = getEndpointQueryBudget(method, route);
  if (budget === null || queryCount <= budget) return null;
  return { budget, exceededBy: queryCount - budget };
};
