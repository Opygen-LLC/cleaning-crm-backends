import { describe, expect, it } from "vitest";
import { normalizeSubscriptionPlanFeatures } from "./subscriptionPlanFeatures";

describe("normalizeSubscriptionPlanFeatures", () => {
    it("preserves canonical feature objects including disabled rows", () => {
        expect(
            normalizeSubscriptionPlanFeatures([
                { label: "Online Booking", included: false, limit: "2 forms" },
            ]),
        ).toEqual([
            { label: "Online Booking", included: false, limit: "2 forms" },
        ]);
    });

    it("migrates legacy JSON-encoded feature strings without enabling disabled rows", () => {
        expect(
            normalizeSubscriptionPlanFeatures([
                JSON.stringify({ label: "Coupons", included: false }),
            ]),
        ).toEqual([{ label: "Coupons", included: false }]);
    });

    it("keeps legacy plain strings enabled for backwards compatibility", () => {
        expect(normalizeSubscriptionPlanFeatures(["Reports"])).toEqual([
            { label: "Reports", included: true },
        ]);
    });

    it("deduplicates labels using feature-gate normalisation and keeps the last state", () => {
        expect(
            normalizeSubscriptionPlanFeatures([
                { label: "Auto-Dispatch", included: true },
                { label: "auto dispatch", included: false },
            ]),
        ).toEqual([{ label: "auto dispatch", included: false }]);
    });
});
