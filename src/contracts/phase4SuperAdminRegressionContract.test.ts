import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  entitlementSchema,
  hardDeleteSchema,
  platformConfigPatchSchema,
  reasonSchema,
  tenantActivityQuerySchema,
  tenantAuditQuerySchema,
  tenantBillingQuerySchema,
  tenantOwnerSchema,
  tenantProfileSchema,
  tenantSessionsQuerySchema,
  tenantTeamQuerySchema,
  trialManagementSchema,
  userRoleSchema,
  userStatusSchema,
  verifyUserSchema,
} from "../modules/SuperAdmin/tenantAdmin.validation";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const UUID = "11111111-1111-4111-8111-111111111111";
const REASON = "Regression test administrative reason";

describe("Phase 4 Super Admin regression contract", () => {
  it("keeps the canonical tenant, user, subscription-request and audit route surface protected by SUPER_ADMIN", () => {
    const routes = read("src/modules/SuperAdmin/superAdmin.routes.ts");
    const required = [
      'router.get("/tenants", isSuperAdmin',
      'router.get("/tenants/:adminId", isSuperAdmin',
      'router.get("/tenants/:adminId/team", isSuperAdmin',
      'router.get("/tenants/:adminId/audit", isSuperAdmin',
      'router.get("/tenants/:adminId/billing", isSuperAdmin',
      'router.get("/tenants/:adminId/activity", isSuperAdmin',
      'router.get("/tenants/:adminId/sessions", isSuperAdmin',
      'router.post("/tenants/:adminId/sessions/revoke-all", isSuperAdmin',
      'router.post("/tenants/:adminId/suspend", isSuperAdmin',
      'router.post("/tenants/:adminId/reactivate", isSuperAdmin',
      'router.post("/tenants/:adminId/archive", isSuperAdmin',
      'router.post("/tenants/:adminId/restore", isSuperAdmin',
      'router.get("/tenants/:adminId/deletion-preview", isSuperAdmin',
      'router.post("/tenants/:adminId/hard-delete", isSuperAdmin',
      'router.get("/users", isSuperAdmin',
      'router.patch("/users/:id/verify", isSuperAdmin',
      'router.get("/subscription-requests", isSuperAdmin',
      'router.get("/audit-logs", isSuperAdmin',
    ];
    for (const route of required) expect(routes).toContain(route);
    expect(routes).toContain("const isSuperAdmin = checkAuth(UserRole.SUPER_ADMIN)");
  });

  it("requires a meaningful reason for sensitive tenant/user/platform mutations", () => {
    for (const schema of [reasonSchema, verifyUserSchema]) {
      expect(() => schema.parse({ reason: "short" })).toThrow();
      expect(() => schema.parse({ reason: REASON })).not.toThrow();
    }
    expect(() => tenantProfileSchema.parse({ reason: REASON, businessName: "Clean Co" })).not.toThrow();
    expect(() => tenantOwnerSchema.parse({ reason: REASON, name: "Owner Name" })).not.toThrow();
    expect(() => userRoleSchema.parse({ reason: REASON, role: "STAFF" })).not.toThrow();
    expect(() => userStatusSchema.parse({ reason: REASON, status: "SUSPENDED" })).not.toThrow();
    expect(() => platformConfigPatchSchema.parse({ reason: REASON, maintenanceMode: true })).not.toThrow();
    expect(() => trialManagementSchema.parse({ reason: REASON, action: "EXTEND", days: 7 })).not.toThrow();
    expect(() => entitlementSchema.parse({ reason: REASON, resources: { staff: { mode: "ADD", value: 2 } } })).not.toThrow();
  });

  it("hard delete requires both canonical tenant id and the exact destructive phrase", () => {
    expect(() => hardDeleteSchema.parse({ adminId: UUID, confirmationText: "DELETE", reason: REASON })).toThrow();
    expect(() => hardDeleteSchema.parse({ adminId: UUID, confirmationText: "DELETE PERMANENTLY", reason: "short" })).toThrow();
    expect(hardDeleteSchema.parse({ adminId: UUID, confirmationText: "DELETE PERMANENTLY", reason: REASON })).toMatchObject({ adminId: UUID });
  });

  it("keeps audit writes next to every canonical Super Admin mutation", () => {
    const service = read("src/modules/SuperAdmin/tenantAdmin.service.ts");
    const actions = [
      "TENANT_PROFILE_UPDATED",
      "TENANT_OWNER_UPDATED",
      "TENANT_REACTIVATED",
      "TENANT_SUSPENDED",
      "TENANT_ARCHIVED",
      "TENANT_RESTORED",
      "TENANT_HARD_DELETE_STARTED",
      "TENANT_HARD_DELETED",
      "USER_STATUS_UPDATED",
      "USER_ROLE_UPDATED",
      "USER_MANUALLY_VERIFIED",
      "SUBSCRIPTION_REQUEST_APPROVED",
      "SUBSCRIPTION_REQUEST_REJECTED",
      "TENANT_PLAN_OVERRIDDEN",
      "TENANT_DOWNGRADE_SCHEDULED",
      "TENANT_SCHEDULED_PLAN_CHANGE_CANCELLED",
      "TENANT_CANCELLATION_SCHEDULED",
      "TENANT_CANCELLATION_REMOVED",
      "TENANT_ENTITLEMENTS_OVERRIDDEN",
      "TENANT_ENTITLEMENTS_REVOKED",
    ];
    for (const action of actions) expect(service).toContain(`action: "${action}"`);
    expect(service).toContain("action: `TENANT_TRIAL_${input.action}`");
  });

  it("keeps Organization 360 summary lightweight and exposes paginated lazy detail endpoints", () => {
    const service = read("src/modules/SuperAdmin/organization360.service.ts");
    for (const section of [
      "overview",
      "effectiveAccess",
      "ownerAndTeam",
      "subscriptionAndEntitlements",
      "billing",
      "cleaningOperations",
      "websiteAndDomain",
      "securityAndSessions",
      "audit",
      "usage",
      "health",
    ]) expect(service).toContain(`${section}:`);

    expect(service).toContain("const PREVIEW_SIZE = 5");
    expect(service).toContain("TenantAccessResolver.resolve(identity.id)");
    expect(service).toContain("getOrganizationTeam");
    expect(service).toContain("getOrganizationAudit");
    expect(service).toContain("getOrganizationBilling");
    expect(service).toContain("getOrganizationActivity");
    expect(service).toContain("getOrganizationSessions");
    expect(service).toContain('action: "TENANT_SESSIONS_REVOKED"');
    expect(service).toContain("revokeAllSessionsForUser");
    expect(service).toContain("disconnectTenantSockets(identity.id)");
  });

  it("validates Organization 360 lazy-list filters and keeps session revocation reason protected", () => {
    expect(() => tenantTeamQuerySchema.parse({ page: "1", limit: "20", status: "ACTIVE" })).not.toThrow();
    expect(() => tenantAuditQuerySchema.parse({ category: "BILLING_INTERVENTIONS" })).not.toThrow();
    expect(() => tenantBillingQuerySchema.parse({ status: "PAID" })).not.toThrow();
    expect(() => tenantActivityQuerySchema.parse({ search: "plan", action: "UPDATED" })).not.toThrow();
    expect(() => tenantSessionsQuerySchema.parse({ activeOnly: "true" })).not.toThrow();
    expect(() => tenantSessionsQuerySchema.parse({ activeOnly: "yes" })).toThrow();
    expect(() => reasonSchema.parse({ reason: "short" })).toThrow();
  });

  it("keeps the read-only data audit incapable of automatic reconciliation", () => {
    const audit = read("src/scripts/phase4/superAdminDataAudit.ts");
    expect(audit).toContain('SET TRANSACTION READ ONLY');
    expect(audit).not.toMatch(/\.delete\(|\.deleteMany\(|\.update\(|\.updateMany\(|\.create\(|\.createMany\(|--fix/);
    for (const key of [
      "duplicateServices",
      "servicesWithoutTenant",
      "crossTenantLeadServices",
      "orphanLeadServiceIds",
      "orphanSubscriptions",
      "multipleLiveSubscriptions",
      "stalePendingPlanChanges",
      "orphanBillingHistory",
      "adminsWithoutProfile",
      "profilesWithoutOwner",
      "suspendedWithLiveSessions",
    ]) expect(audit).toContain(`"${key}"`);
  });
});
