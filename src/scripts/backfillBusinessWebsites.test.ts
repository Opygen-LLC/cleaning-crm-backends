import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma/prisma", () => ({
  prisma: {
    adminProfile: { findMany: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("../modules/Website/websiteProvisioning.service", () => ({
  WebsiteProvisioningService: {
    provisionDefaultWebsiteForAdmin: vi.fn(),
  },
}));

import { prisma } from "../lib/prisma/prisma";
import { WebsiteProvisioningService } from "../modules/Website/websiteProvisioning.service";
import {
  LEGACY_WEBSITE_INITIAL_REVISION_REASON,
  parseWebsiteBackfillArgs,
  runWebsiteBackfill,
} from "./backfillBusinessWebsites";

const db = prisma as unknown as {
  adminProfile: { findMany: ReturnType<typeof vi.fn> };
};
const provisioning = WebsiteProvisioningService as unknown as {
  provisionDefaultWebsiteForAdmin: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("parseWebsiteBackfillArgs", () => {
  it("supports dry-run and bounded operational controls", () => {
    expect(
      parseWebsiteBackfillArgs(["--dry-run", "--batch-size=250", "--max-attempts=4"]),
    ).toEqual({
      dryRun: true,
      batchSize: 250,
      maxAttempts: 4,
    });
  });

  it("rejects unsafe oversized values by falling back to defaults", () => {
    expect(parseWebsiteBackfillArgs(["--batch-size=9999", "--max-attempts=50"])).toEqual({
      dryRun: false,
      batchSize: 100,
      maxAttempts: 3,
    });
  });
});

describe("Phase 21 existing-customer website backfill", () => {
  it("provisions only missing websites with an auditable legacy revision reason", async () => {
    db.adminProfile.findMany
      .mockResolvedValueOnce([
        { id: "admin-1", userId: "user-1", businessName: "Bio Cleaning" },
      ])
      .mockResolvedValueOnce([]);
    provisioning.provisionDefaultWebsiteForAdmin.mockResolvedValue({
      created: true,
      website: { subdomain: "bio-cleaning", status: "PROVISIONED", publishedAt: null },
    });

    const result = await runWebsiteBackfill({ dryRun: false, batchSize: 100, maxAttempts: 1 });

    expect(db.adminProfile.findMany).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { businessWebsite: { is: null } },
        take: 100,
      }),
    );
    expect(provisioning.provisionDefaultWebsiteForAdmin).toHaveBeenCalledWith({
      adminId: "admin-1",
      businessName: "Bio Cleaning",
      createdByUserId: "user-1",
      initialRevisionReason: LEGACY_WEBSITE_INITIAL_REVISION_REASON,
    });
    expect(result).toEqual({
      scanned: 1,
      created: 1,
      alreadyProvisioned: 0,
      failed: 0,
      failedAdminIds: [],
    });
  });

  it("does not write anything in dry-run mode", async () => {
    db.adminProfile.findMany
      .mockResolvedValueOnce([
        { id: "admin-1", userId: "user-1", businessName: "Bio Cleaning" },
      ])
      .mockResolvedValueOnce([]);

    const result = await runWebsiteBackfill({ dryRun: true, batchSize: 100, maxAttempts: 1 });

    expect(provisioning.provisionDefaultWebsiteForAdmin).not.toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(result.scanned).toBe(1);
  });
});
