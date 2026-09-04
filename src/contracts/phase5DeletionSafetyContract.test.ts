import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { hardDeleteSchema } from "../modules/SuperAdmin/tenantAdmin.validation";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const UUID = "11111111-1111-4111-8111-111111111111";
const REASON = "Customer requested verified permanent account deletion";

describe("Phase 5 permanent deletion safety", () => {
  it("requires the exact organization id, destructive phrase and audited reason contract", () => {
    expect(() => hardDeleteSchema.parse({ adminId: UUID, confirmationText: "DELETE", reason: REASON })).toThrow();
    expect(() => hardDeleteSchema.parse({ adminId: UUID, confirmationText: "DELETE PERMANENTLY", reason: "short" })).toThrow();
    expect(hardDeleteSchema.parse({ adminId: UUID, confirmationText: "DELETE PERMANENTLY", reason: REASON })).toMatchObject({ adminId: UUID });
  });

  it("persists a retryable PENDING_DELETION state before external or database purge", () => {
    const schema = read("prisma/schema/admin.prisma");
    const enums = read("prisma/schema/enum.prisma");
    const service = read("src/modules/SuperAdmin/tenantAdmin.service.ts");
    expect(enums).toContain("PENDING_DELETION");
    for (const field of ["deletionStartedAt", "deletionReason", "deletionAttemptCount", "deletionLastAttemptAt", "deletionLastError"]) expect(schema).toContain(field);
    expect(service).toContain('lifecycleStatus: PENDING_DELETION');
    expect(service).toContain('TENANT_HARD_DELETE_STARTED');
    expect(service).toContain('TENANT_HARD_DELETE_RETRIED');
    expect(service).toContain('TENANT_HARD_DELETE_FAILED');
    expect(service).toContain('TENANT_HARD_DELETED');
    expect(service).toContain('Promise.allSettled');
    expect(service).toContain('TENANT_DELETE_ALREADY_IN_PROGRESS');
    expect(service).toContain('retryable: true');
  });

  it("makes the Super Admin audit store append-only with request context and before/after snapshots", () => {
    const schema = read("prisma/schema/superAdminTenant.prisma");
    const migration = read("prisma/migrations/20260904161500_phase5_deletion_audit_hardening/migration.sql");
    const writer = read("src/modules/SuperAdmin/superAdminAudit.service.ts");
    for (const field of ["before", "after", "requestId", "ipAddress", "userAgent"]) expect(schema).toContain(field);
    expect(migration).toContain("prevent_super_admin_audit_mutation");
    expect(migration).toContain("BEFORE UPDATE OR DELETE");
    expect(writer).toContain("getRequestTrace");
    expect(writer).toContain("requestId:");
    expect(writer).toContain("ipAddress:");
    expect(writer).toContain("userAgent:");
  });
});
