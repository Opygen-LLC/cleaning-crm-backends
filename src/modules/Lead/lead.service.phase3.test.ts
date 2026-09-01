import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/prisma/prisma", () => ({
  prisma: {
    adminProfile: { findFirst: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock("../../lib/prisma/advisoryLock", () => ({
  acquireExtendedTextTransactionAdvisoryLock: vi.fn(async () => undefined),
}));
vi.mock("./leadRef.service", () => ({
  allocateLeadRef: vi.fn(async () => "LEAD-0001"),
}));
vi.mock("../../lib/validation/phone", () => ({
  requireE164Phone: vi.fn((value: string) => value),
}));
vi.mock("./leadActivity.service", () => ({
  ensureLeadActivityAssignee: vi.fn(async () => undefined),
}));
vi.mock("../Website/websiteSubmission.service", () => ({
  syncLeadWebsiteSubmissionsConverted: vi.fn(async () => undefined),
}));
vi.mock("../../lib/utils/resolveAdminId", () => ({
  getAdminId: vi.fn(async () => "admin-1"),
}));

import { prisma } from "../../lib/prisma/prisma";
import { LeadStage } from "../../generated/prisma/enums";
import { leadService } from "./lead.service";

const db = prisma as unknown as {
  adminProfile: { findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

describe("lead initial stage persistence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.adminProfile.findFirst.mockResolvedValue({ id: "admin-1", businessName: "Clean Co" });
  });

  it.each([
    ["NEW", LeadStage.NEW],
    ["CONTACTED", LeadStage.CONTACTED],
    ["QUOTE_SENT", LeadStage.QUOTE_SENT],
    ["WON", LeadStage.WON],
    ["LOST", LeadStage.LOST],
  ] as const)("persists %s on create", async (stage, expectedStage) => {
    const lead = {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => ({
        id: "lead-1",
        leadRef: data.leadRef,
        name: data.name,
        email: data.email,
        phone: data.phone ?? null,
        serviceInterest: data.serviceInterest,
        serviceCatalogId: null,
        estimatedMin: data.estimatedMin,
        estimatedMax: data.estimatedMax,
        notes: data.notes ?? null,
        sourceRef: null,
        sourceWebsiteId: null,
        stage: data.stage,
        adminId: data.adminId,
        createdAt: new Date("2026-09-02T00:00:00.000Z"),
        updatedAt: new Date("2026-09-02T00:00:00.000Z"),
      })),
    };
    const tx = {
      lead,
      serviceCatalog: { findFirst: vi.fn() },
      leadActivity: { create: vi.fn() },
    };
    db.$transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) => callback(tx));

    const result = await leadService.createLead({
      name: "Sarah Mitchell",
      email: "sarah@example.com",
      serviceInterest: "General Enquiry",
      stage,
    }, { id: "owner-1", role: "ADMIN" } as never);

    expect(lead.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ stage: expectedStage }),
    }));
    expect(result.stage).toBe(
      stage === "QUOTE_SENT" ? "Quote Sent" : stage.charAt(0) + stage.slice(1).toLowerCase(),
    );
  });

  it("does not auto-create a client when a lead starts as WON", async () => {
    const lead = {
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }) => ({
        id: "lead-won",
        leadRef: data.leadRef,
        name: data.name,
        email: data.email,
        serviceInterest: data.serviceInterest,
        estimatedMin: 0,
        estimatedMax: 0,
        sourceWebsiteId: null,
        stage: data.stage,
        adminId: data.adminId,
      })),
    };
    const tx = { lead, serviceCatalog: { findFirst: vi.fn() }, leadActivity: { create: vi.fn() } };
    db.$transaction.mockImplementation(async (callback: (value: typeof tx) => unknown) => callback(tx));

    const result = await leadService.createLead({
      name: "Won Lead",
      email: "won@example.com",
      serviceInterest: "General Enquiry",
      stage: "WON",
    }, { id: "owner-1", role: "ADMIN" } as never);

    expect(result.stage).toBe("Won");
    expect(lead.create).toHaveBeenCalledTimes(1);
  });
});
