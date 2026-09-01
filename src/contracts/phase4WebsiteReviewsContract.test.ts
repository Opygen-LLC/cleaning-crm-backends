import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { toServiceSlugBase } from "../modules/ServiceCatalog/serviceCatalog.slug";

const read = (path: string) => readFileSync(path, "utf8");

describe("Phase 4 website review contract", () => {
  it("keeps legacy job reviews and adds website company/service review scopes", () => {
    const schema = read("prisma/schema/review.prisma");
    const enums = read("prisma/schema/enum.prisma");
    expect(enums).toContain("enum ReviewScope");
    expect(enums).toContain("COMPANY\n  SERVICE\n  JOB\n  STAFF");
    expect(enums).toContain("enum ReviewSource");
    expect(schema).toContain("reviewTokenId       String?");
    expect(schema).toContain("jobId               String?");
    expect(schema).toContain("serviceCatalogId     String?");
    expect(schema).toContain("websiteId            String?");
  });

  it("stores private website reviewer contact separately", () => {
    const schema = read("prisma/schema/review.prisma");
    const service = read("src/modules/Review/websiteReview.service.ts");
    expect(schema).toContain("model WebsiteReviewContact");
    expect(schema).toContain("email             String");
    expect(service).toContain("tx.websiteReviewContact.create");
    expect(service).not.toContain("payload.adminId");
  });

  it("binds public review mutations to the existing tenant website boundary", () => {
    const routes = read("src/modules/Website/publicWebsite.routes.ts");
    expect(routes).toContain('"/:identifier/review-context"');
    expect(routes).toContain('"/:identifier/reviews"');
    expect(routes).toContain("publicReviewMutationRateLimit");
    expect(routes).toContain("publicReviewResourceRateLimit");
    expect(routes).toContain("publicReviewBodyLimit");
    expect(routes).toContain("publicWebsiteMutationOriginGuard");
    expect(routes).toContain('publicWebsiteSpamGuard("website_review")');
  });

  it("keeps only moderated published reviews in the public projection", () => {
    const projection = read("src/modules/Website/publicWebsite.service.ts");
    expect(projection).toContain('where: { status: "published", staffId: null }');
    expect(projection).not.toContain("websiteContact: { select: { email");
  });

  it("generates normalized service slugs and keeps them tenant unique", () => {
    expect(toServiceSlugBase(" Deep Clean ")).toBe("deep-clean");
    expect(toServiceSlugBase("Move-In / Move-Out")).toBe("move-in-move-out");
    const schema = read("prisma/schema/service.prisma");
    expect(schema).toContain("@@unique([adminId, slug])");
  });

  it("backfills old data before making the new contract required", () => {
    const migration = read("prisma/migrations/20260901193000_phase4_company_service_reviews/migration.sql");
    expect(migration).toContain('UPDATE "review"\nSET "source" = \'JOB_TOKEN\'');
    expect(migration).toContain('ALTER TABLE "service_catalog" ALTER COLUMN "slug" SET NOT NULL');
    expect(migration).toContain('ON DELETE SET NULL ON UPDATE CASCADE');
  });
});
