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
} as const;

export type QueryBudgetKey = keyof typeof ENDPOINT_QUERY_BUDGETS;

export const getEndpointQueryBudget = (method: string, route: string): number | null => {
  const key = `${method.toUpperCase()} ${route}` as QueryBudgetKey;
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
