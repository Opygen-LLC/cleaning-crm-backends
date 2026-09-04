import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  entitlementSchema,
  hardDeleteSchema,
  platformConfigPatchSchema,
  supportModeStartSchema,
  reasonSchema,
  tenantActivityQuerySchema,
  tenantAuditQuerySchema,
  tenantBillingQuerySchema,
  tenantListQuerySchema,
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
      'router.post("/tenants/:adminId/sessions/revoke-owner", isSuperAdmin',
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
      'router.post("/support-mode/start", isSuperAdmin',
      'router.get("/support-mode/current", isSuperAdmin',
      'router.post("/support-mode/end", isSuperAdmin',
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
    expect(() => supportModeStartSchema.parse({ organizationId: UUID, durationMinutes: 15, reason: REASON })).not.toThrow();
    expect(() => supportModeStartSchema.parse({ organizationId: UUID, durationMinutes: 20, reason: REASON })).toThrow();
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
    expect(service).toContain("before: { isTrial: current.isTrial");
    expect(service).toContain("after: { isTrial: sub.isTrial");
  });

  it("keeps administrative plan changes no-charge and support mode read-only", () => {
    const tenantService = read("src/modules/SuperAdmin/tenantAdmin.service.ts");
    const support = read("src/modules/SuperAdmin/supportMode.service.ts");
    const auth = read("src/middlewares/checkAuth.ts");
    const organization360 = read("src/modules/SuperAdmin/organization360.service.ts");
    const superAdminService = read("src/modules/SuperAdmin/superAdmin.service.ts");

    expect(tenantService).toContain('action: "TENANT_PLAN_OVERRIDDEN"');
    expect(tenantService).toContain("noCharge: true");
    expect(tenantService).toContain("isAdministrative: false");
    expect(tenantService).toContain("quotedAmount: 0");
    const immediateBlock = tenantService.slice(tenantService.indexOf("export const changeTenantPlan"), tenantService.indexOf("const tierRank"));
    expect(immediateBlock).not.toContain("totalCost: target.price");
    const scheduledApplyBlock = tenantService.slice(tenantService.indexOf("export const applyDueAdministrativePlanChanges"));
    expect(scheduledApplyBlock).not.toContain("totalCost: change.targetPlan.price");
    expect(superAdminService).toContain("Number(sub.totalCost ?? 0)");
    expect(superAdminService).toContain("Number(subscription.totalCost ?? 0)");
    expect(superAdminService).not.toContain("sum + Number(sub.plan.price ?? 0)");
    expect(superAdminService).not.toContain("sum + Number(subscription.plan?.price ?? 0)");

    expect(support).toContain('readOnly: true');
    expect(support).toContain('TENANT_SUPPORT_MODE_STARTED');
    expect(support).toContain('TENANT_SUPPORT_MODE_ENDED');
    expect(support).toContain('Support mode duration must be 15 or 30 minutes.');
    expect(support).toContain('SUPPORT_MODE_READ_ONLY');
    expect(auth).toContain('supportModeEndRequest');
    expect(auth).toContain('SupportModeService.assertReadOnly(req)');
    expect(organization360).toContain('action: "TENANT_OWNER_SESSIONS_REVOKED"');
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
    expect(service).toContain('action: "TENANT_OWNER_SESSIONS_REVOKED"');
    expect(service).toContain('action: "TENANT_SESSIONS_REVOKED"');
    expect(service).toContain("revokeAllSessionsForUser");
    expect(service).toContain("disconnectTenantSockets(identity.id)");
  });

  it("validates canonical organization-list filters used by the Super Admin UI", () => {
    const parsed = tenantListQuerySchema.parse({
      search: "CleanPro",
      lifecycleStatus: "ACTIVE",
      subscriptionKind: "PAID",
      plan: "GROWTH",
      subscriptionStatus: "ACTIVE",
      websiteStatus: "DOMAIN_PROBLEM",
      country: "United States",
      createdFrom: "2026-01-01T00:00:00.000Z",
      createdTo: "2026-12-31T23:59:59.999Z",
      page: "2",
      limit: "50",
    });
    expect(parsed).toMatchObject({ plan: "GROWTH", websiteStatus: "DOMAIN_PROBLEM", subscriptionKind: "PAID" });
    expect(() => tenantListQuerySchema.parse({ plan: "UNKNOWN" })).toThrow();
    expect(() => tenantListQuerySchema.parse({ websiteStatus: "BROKEN" })).toThrow();
    expect(() => tenantListQuerySchema.parse({ createdFrom: "2026-12-31T00:00:00.000Z", createdTo: "2026-01-01T00:00:00.000Z" })).toThrow();
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
