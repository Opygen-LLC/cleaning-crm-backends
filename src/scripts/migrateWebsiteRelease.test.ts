import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma/prisma", () => ({
  prisma: {
    adminProfile: { findMany: vi.fn() },
    $disconnect: vi.fn(),
  },
}));

vi.mock("../modules/Website/websiteReleaseMigration.service", () => ({
  WebsiteReleaseMigrationService: {
    auditAdminWebsiteForRelease: vi.fn(),
    reconcileAdminWebsiteForRelease: vi.fn(),
  },
}));

import { prisma } from "../lib/prisma/prisma";
import { WebsiteReleaseMigrationService } from "../modules/Website/websiteReleaseMigration.service";
import { parsePhase10WebsiteMigrationArgs, runPhase10WebsiteMigration } from "./migrateWebsiteRelease";

const db = prisma as unknown as { adminProfile: { findMany: ReturnType<typeof vi.fn> } };
const migration = WebsiteReleaseMigrationService as unknown as {
  auditAdminWebsiteForRelease: ReturnType<typeof vi.fn>;
  reconcileAdminWebsiteForRelease: ReturnType<typeof vi.fn>;
};

beforeEach(() => vi.clearAllMocks());

describe("Phase 10 rolling website migration", () => {
  it("supports a bounded read-only dry run", () => {
    expect(parsePhase10WebsiteMigrationArgs(["--dry-run", "--batch-size=250"]))
      .toEqual({ dryRun: true, batchSize: 250 });
    expect(parsePhase10WebsiteMigrationArgs(["--batch-size=9000"]).batchSize).toBe(100);
  });

  it("audits every existing admin without writing in dry-run mode", async () => {
    db.adminProfile.findMany
      .mockResolvedValueOnce([
        { id: "admin-1", userId: "user-1", businessName: "Sparkle" },
        { id: "admin-2", userId: "user-2", businessName: "Prime" },
      ])
      .mockResolvedValueOnce([]);
    migration.auditAdminWebsiteForRelease
      .mockResolvedValueOnce({ adminId: "admin-1", websiteId: null, healthy: false, issues: ["MISSING_WEBSITE"] })
      .mockResolvedValueOnce({ adminId: "admin-2", websiteId: "site-2", healthy: true, issues: [] });

    const result = await runPhase10WebsiteMigration({ dryRun: true, batchSize: 100 });

    expect(migration.reconcileAdminWebsiteForRelease).not.toHaveBeenCalled();
    expect(result).toMatchObject({ scanned: 2, healthy: 1, created: 0, repaired: 0, failed: 0 });
    expect(result.issueCounts.MISSING_WEBSITE).toBe(1);
  });

  it("continues after a tenant failure and reports created/repaired/healthy separately", async () => {
    db.adminProfile.findMany
      .mockResolvedValueOnce([
        { id: "admin-1", userId: "user-1", businessName: "Sparkle" },
        { id: "admin-2", userId: "user-2", businessName: "Prime" },
        { id: "admin-3", userId: "user-3", businessName: "Fresh" },
        { id: "admin-4", userId: "user-4", businessName: "Clean" },
      ])
      .mockResolvedValueOnce([]);
    migration.reconcileAdminWebsiteForRelease
      .mockResolvedValueOnce({ adminId: "admin-1", websiteId: "site-1", subdomain: "sparkle", healthy: true, issues: [], detectedIssues: ["MISSING_WEBSITE"], created: true, repaired: true, actions: ["WEBSITE_PROVISIONED"] })
      .mockResolvedValueOnce({ adminId: "admin-2", websiteId: "site-2", subdomain: "prime", healthy: true, issues: [], detectedIssues: ["MISSING_PAGE:BOOK"], created: false, repaired: true, actions: ["SYSTEM_PAGE_CREATED"] })
      .mockResolvedValueOnce({ adminId: "admin-3", websiteId: "site-3", subdomain: "fresh", healthy: true, issues: [], detectedIssues: [], created: false, repaired: false, actions: [] })
      .mockRejectedValueOnce(new Error("tenant-specific failure"));

    const result = await runPhase10WebsiteMigration({ dryRun: false, batchSize: 100 });

    expect(result).toMatchObject({ scanned: 4, healthy: 1, created: 1, repaired: 1, failed: 1 });
    expect(result.failedAdminIds).toEqual(["admin-4"]);
  });
});
