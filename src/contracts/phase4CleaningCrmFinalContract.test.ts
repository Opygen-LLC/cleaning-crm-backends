import { describe, expect, it } from "vitest";
import { reviewValidation } from "../modules/Review/review.validation";
import { serviceCatalogValidation } from "../modules/ServiceCatalog/serviceCatalog.validation";
import { subscriptionValidation } from "../modules/Subscription/subscription.validation";

const id = "8f3d9a46-6a85-4f7b-9e3e-df8c26b0c774";

describe("Cleaning CRM Phase 4 route validation contracts", () => {
  it("rejects malformed public/admin review identifiers", () => {
    expect(reviewValidation.reviewTokenParams.safeParse({ token: "bad" }).success).toBe(false);
    expect(reviewValidation.reviewIdParams.safeParse({ id }).success).toBe(true);
    expect(reviewValidation.reviewJobIdParams.safeParse({ jobId: id }).success).toBe(true);
  });

  it("rejects invalid/reversed review dates and empty moderation patches", () => {
    expect(reviewValidation.reviewFilters.safeParse({ dateFrom: "2026-09-12", dateTo: "2026-09-11" }).success).toBe(false);
    expect(reviewValidation.reviewFilters.safeParse({ dateFrom: "2026-02-31" }).success).toBe(false);
    expect(reviewValidation.updateReview.safeParse({}).success).toBe(false);
    expect(reviewValidation.updateReview.safeParse({ adminReply: "Thanks" }).success).toBe(true);
  });

  it("coerces bounded service pagination and rejects malformed service ids", () => {
    const parsed = serviceCatalogValidation.serviceCatalogFilters.safeParse({ page: "2", limit: "25" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toMatchObject({ page: 2, limit: 25 });
    expect(serviceCatalogValidation.serviceCatalogFilters.safeParse({ limit: "101" }).success).toBe(false);
    expect(serviceCatalogValidation.serviceCatalogIdParams.safeParse({ id: "not-a-uuid" }).success).toBe(false);
  });

  it("validates billing history page bounds", () => {
    expect(subscriptionValidation.billingHistoryQuerySchema.safeParse({ page: "1", limit: "100" }).success).toBe(true);
    expect(subscriptionValidation.billingHistoryQuerySchema.safeParse({ page: "0" }).success).toBe(false);
    expect(subscriptionValidation.billingHistoryQuerySchema.safeParse({ limit: "101" }).success).toBe(false);
  });
});
