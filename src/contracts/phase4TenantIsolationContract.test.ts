import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Phase 4 tenant ownership regression contract", () => {
  it("service onboarding resolves stable IDs only from the authenticated tenant catalog", () => {
    const source = read("src/modules/ServiceCatalog/serviceCatalog.service.ts");
    expect(source).toContain("where: { adminId }");
    expect(source).toContain("SERVICE_CATALOG_ID_INVALID");
    expect(source).toContain("SERVICE_NAME_CONFLICT");
  });

  it("lead create/update validates service ownership using both id and adminId", () => {
    const source = read("src/modules/Lead/lead.service.ts");
    expect(source).toMatch(/serviceCatalog[\s\S]*findFirst[\s\S]*id:\s*input\.serviceCatalogId[\s\S]*adminId/);
    expect(source).toContain("LEAD_SERVICE_INVALID");
    expect(source).toMatch(/lead[\s\S]*findFirst[\s\S]*adminId/);
  });

  it("subscription and website tenant mutations derive tenant context instead of accepting a caller supplied adminId", () => {
    const subscription = read("src/modules/Subscription/subscription.service.ts");
    const website = read("src/modules/Website/website.service.ts");
    expect(subscription).toContain("getAdminId(user)");
    expect(website).toContain("getAdminId(");
    expect(subscription).not.toMatch(/input\.adminId\s*\|\|\s*adminId/);
    expect(website).not.toMatch(/input\.adminId\s*\|\|\s*adminId/);
  });
});
