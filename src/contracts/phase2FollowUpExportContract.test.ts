import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("Phase 2 follow-up and export contracts", () => {
  it("keeps follow-ups in LeadActivity and exposes the dedicated route before /:id", () => {
    const routes = read("src/modules/Lead/lead.routes.ts");
    const service = read("src/modules/Lead/leadActivity.service.ts");
    expect(routes.indexOf('\"/follow-ups\"')).toBeLessThan(routes.indexOf('router.get("/:id"'));
    expect(service).toContain('type: "FOLLOW_UP"');
    expect(service).toContain("businessHours?.timezone");
    expect(service).toContain('query.scope === "overdue"');
    expect(service).toContain('query.scope === "upcoming"');
  });

  it("creates an optional initial follow-up atomically with the lead", () => {
    const validation = read("src/modules/Lead/lead.validation.ts");
    const service = read("src/modules/Lead/lead.service.ts");
    expect(validation).toContain("initialFollowUp");
    expect(service).toContain("prisma.$transaction");
    expect(service).toContain("tx.leadActivity.create");
    expect(service).toContain("ensureLeadActivityAssignee");
  });

  it("builds tenant-scoped chunked XLSX exports without selecting capability secrets", () => {
    const service = read("src/modules/DataExport/dataExport.service.ts");
    const controller = read("src/modules/DataExport/dataExport.controller.ts");
    const projections = read("src/modules/DataExport/dataExport.projections.ts");
    const routes = read("src/modules/DataExport/dataExport.routes.ts");
    expect(routes).toContain("checkAuth(UserRole.ADMIN)");
    expect(service).toContain("CHUNK_SIZE = 500");
    expect(service).toContain("getAdminId(user)");
    expect(controller).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(projections).not.toContain("publicToken: true");
    expect(projections).not.toContain("portalAccessToken: true");
    expect(projections).not.toContain("password: true");
    expect(projections).not.toContain("refreshToken");
    expect(projections).not.toContain("gatewayCustomerId: true");
    expect(projections).not.toContain("gatewayPaymentId: true");
  });
});
