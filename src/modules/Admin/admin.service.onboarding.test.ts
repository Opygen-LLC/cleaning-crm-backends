/**
 * admin.service.onboarding.test.ts
 *
 * Regression coverage for the Phase 3 test matrix:
 *   1. Skip step 4 (team) -> skip step 5 (client) -> land on step 6
 *      (booking) with no dead end at the data layer (isComplete stays
 *      false, but the request never throws/crashes and each step reports
 *      a coherent status).
 *   2. Mandatory steps 1-3 can never be skipped, even by calling the
 *      service directly (the real enforcement point, not just Zod).
 *   3. Going back and actually completing a previously-skipped step
 *      (client) makes it report "completed", not "skipped" — real data
 *      always outranks a stale skip choice.
 *   4. Skipped state is derived from the DB (`admin.skippedSteps`), not
 *      anything client-side — re-running getOnboardingStatus against the
 *      same mocked "row" reproduces the same result, which is what
 *      "survives a refresh" actually depends on server-side.
 *   5. Skipping is idempotent, and a no-op once onboarding is already
 *      complete.
 *
 * prisma is mocked so this runs with no real database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma/prisma", () => ({
    prisma: {
        adminProfile: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        serviceCatalog: { count: vi.fn() },
        workLocation: { count: vi.fn() },
        staffProfile: { count: vi.fn() },
        client: { count: vi.fn() },
        booking: { count: vi.fn() },
    },
}));

import { prisma } from "../../lib/prisma/prisma";
import { adminService } from "./admin.service";

const mockPrisma = prisma as unknown as {
    adminProfile: {
        findUnique: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
    };
    serviceCatalog: { count: ReturnType<typeof vi.fn> };
    workLocation: { count: ReturnType<typeof vi.fn> };
    staffProfile: { count: ReturnType<typeof vi.fn> };
    client: { count: ReturnType<typeof vi.fn> };
    booking: { count: ReturnType<typeof vi.fn> };
};

const USER_ID = "user-1";
const ADMIN_ID = "admin-1";

/** In-memory "row" standing in for the AdminProfile record. */
function makeAdminRow(overrides: Partial<{
    skippedSteps: string[];
    onboardingCompletedAt: Date | null;
    businessProfileComplete: boolean;
}> = {}) {
    const businessProfileComplete = overrides.businessProfileComplete ?? true;
    return {
        id: ADMIN_ID,
        userId: USER_ID,
        skippedSteps: overrides.skippedSteps ?? [],
        onboardingCompletedAt: overrides.onboardingCompletedAt ?? null,
        address: businessProfileComplete ? "1 Main St" : null,
        city: businessProfileComplete ? "Springfield" : null,
        mobileNumber: businessProfileComplete ? "+15555550100" : null,
        businessType: businessProfileComplete ? "Residential" : null,
    };
}

/** Counts for steps 2/3/4/5/6 (service, service_area, team, client, booking). */
function setDataCounts(counts: {
    service?: number;
    serviceArea?: number;
    team?: number;
    client?: number;
    booking?: number;
}) {
    mockPrisma.serviceCatalog.count.mockResolvedValue(counts.service ?? 0);
    mockPrisma.workLocation.count.mockResolvedValue(counts.serviceArea ?? 0);
    mockPrisma.staffProfile.count.mockResolvedValue(counts.team ?? 0);
    mockPrisma.client.count.mockResolvedValue(counts.client ?? 0);
    mockPrisma.booking.count.mockResolvedValue(counts.booking ?? 0);
}

function statusOf(steps: { key: string; status: string }[], key: string) {
    return steps.find((s) => s.key === key)?.status;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("onboarding skip/back matrix", () => {
    it("mandatory steps 1-3 are rejected server-side regardless of what's posted", async () => {
        await expect(
            adminService.skipOnboardingStep(USER_ID, "business_profile" as any),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            adminService.skipOnboardingStep(USER_ID, "service" as any),
        ).rejects.toMatchObject({ statusCode: 400 });
        await expect(
            adminService.skipOnboardingStep(USER_ID, "service_area" as any),
        ).rejects.toMatchObject({ statusCode: 400 });

        // None of those should have touched the DB at all.
        expect(mockPrisma.adminProfile.findUnique).not.toHaveBeenCalled();
        expect(mockPrisma.adminProfile.update).not.toHaveBeenCalled();
    });

    it("skip team (step 4) -> skip client (step 5) -> booking (step 6) is reachable with a coherent, non-throwing status", async () => {
        // --- skip "team" ---
        mockPrisma.adminProfile.findUnique.mockResolvedValueOnce(
            makeAdminRow({ skippedSteps: [] }),
        );
        await adminService.skipOnboardingStep(USER_ID, "team" as any);
        expect(mockPrisma.adminProfile.update).toHaveBeenCalledWith({
            where: { id: ADMIN_ID },
            data: { skippedSteps: { push: "team" } },
        });

        // --- skip "client" (now skippedSteps already has "team") ---
        mockPrisma.adminProfile.findUnique.mockResolvedValueOnce(
            makeAdminRow({ skippedSteps: ["team"] }),
        );
        await adminService.skipOnboardingStep(USER_ID, "client" as any);
        expect(mockPrisma.adminProfile.update).toHaveBeenCalledWith({
            where: { id: ADMIN_ID },
            data: { skippedSteps: { push: "client" } },
        });

        // --- land on booking (step 6): no client and no booking yet ---
        mockPrisma.adminProfile.findUnique.mockResolvedValueOnce(
            makeAdminRow({ skippedSteps: ["team", "client"] }),
        );
        setDataCounts({ service: 1, serviceArea: 1, team: 0, client: 0, booking: 0 });

        const result = await adminService.getOnboardingStatus(USER_ID);

        expect(result.isComplete).toBe(false);
        expect(statusOf(result.steps, "team")).toBe("skipped");
        expect(statusOf(result.steps, "client")).toBe("skipped");
        expect(statusOf(result.steps, "booking")).toBe("pending");
        expect(result.skippedCount).toBe(2);
        // The key assertion: this resolves cleanly (no throw) even though
        // there are zero real clients — the old BookingStep dead end was a
        // frontend rendering gap, not a data-layer failure, and this
        // confirms the data layer was never the problem.
    });

    it("going back and actually completing client makes it report completed, not skipped", async () => {
        mockPrisma.adminProfile.findUnique.mockResolvedValueOnce(
            makeAdminRow({ skippedSteps: ["team", "client"] }),
        );
        // Client step was completed for real this time.
        setDataCounts({ service: 1, serviceArea: 1, team: 0, client: 1, booking: 0 });

        const result = await adminService.getOnboardingStatus(USER_ID);

        expect(statusOf(result.steps, "client")).toBe("completed");
        expect(result.steps.find((s) => s.key === "client")?.completed).toBe(true);
        // team is still genuinely skipped (no staff added) — real data only
        // overrides the skip for the step that actually got data.
        expect(statusOf(result.steps, "team")).toBe("skipped");
        expect(result.isComplete).toBe(false); // booking still pending
    });

    it("completing the final step (booking) marks isComplete and stamps onboardingCompletedAt", async () => {
        mockPrisma.adminProfile.findUnique.mockResolvedValueOnce(
            makeAdminRow({ skippedSteps: ["team"] }),
        );
        setDataCounts({ service: 1, serviceArea: 1, team: 0, client: 1, booking: 1 });

        const result = await adminService.getOnboardingStatus(USER_ID);

        expect(result.isComplete).toBe(true);
        expect(mockPrisma.adminProfile.update).toHaveBeenCalledWith({
            where: { id: ADMIN_ID },
            data: { onboardingCompletedAt: expect.any(Date) },
        });
    });

    it("skipped state comes from the DB row, not anything client-side — re-fetching reproduces the same result (this is what 'survives a refresh' relies on)", async () => {
        const row = makeAdminRow({ skippedSteps: ["team", "client"] });
        setDataCounts({ service: 1, serviceArea: 1, team: 0, client: 0, booking: 0 });

        mockPrisma.adminProfile.findUnique.mockResolvedValueOnce(row);
        const first = await adminService.getOnboardingStatus(USER_ID);

        mockPrisma.adminProfile.findUnique.mockResolvedValueOnce(row);
        const second = await adminService.getOnboardingStatus(USER_ID);

        expect(second.steps.map((s) => s.status)).toEqual(
            first.steps.map((s) => s.status),
        );
        expect(second.isComplete).toBe(first.isComplete);
    });

    it("short-circuits once onboardingCompletedAt is set, without re-querying counts, and still reflects real skippedSteps", async () => {
        mockPrisma.adminProfile.findUnique.mockResolvedValueOnce(
            makeAdminRow({
                skippedSteps: ["team"],
                onboardingCompletedAt: new Date("2026-01-01"),
            }),
        );

        const result = await adminService.getOnboardingStatus(USER_ID);

        expect(result.isComplete).toBe(true);
        expect(statusOf(result.steps, "team")).toBe("skipped");
        expect(statusOf(result.steps, "client")).toBe("completed");
        expect(statusOf(result.steps, "booking")).toBe("completed");
        // No count queries once already complete.
        expect(mockPrisma.serviceCatalog.count).not.toHaveBeenCalled();
        expect(mockPrisma.booking.count).not.toHaveBeenCalled();
    });

    it("skipping the same step twice is idempotent — no duplicate write", async () => {
        mockPrisma.adminProfile.findUnique.mockResolvedValueOnce(
            makeAdminRow({ skippedSteps: ["team"] }),
        );

        const result = await adminService.skipOnboardingStep(USER_ID, "team" as any);

        expect(result).toEqual({ step: "team", skipped: true });
        expect(mockPrisma.adminProfile.update).not.toHaveBeenCalled();
    });

    it("skipping once onboarding is already complete is a harmless no-op", async () => {
        mockPrisma.adminProfile.findUnique.mockResolvedValueOnce(
            makeAdminRow({ onboardingCompletedAt: new Date("2026-01-01") }),
        );

        const result = await adminService.skipOnboardingStep(USER_ID, "booking" as any);

        expect(result).toEqual({ step: "booking", skipped: true });
        expect(mockPrisma.adminProfile.update).not.toHaveBeenCalled();
    });
});
