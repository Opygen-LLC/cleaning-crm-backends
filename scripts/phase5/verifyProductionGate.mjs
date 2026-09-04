import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path) => readFileSync(resolve(process.cwd(), path), "utf8");
const assert = (condition, message) => { if (!condition) throw new Error(`[phase5] ${message}`); };

const enums = read("prisma/schema/enum.prisma");
const admin = read("prisma/schema/admin.prisma");
const audit = read("prisma/schema/superAdminTenant.prisma");
const migration = read("prisma/migrations/20260904161500_phase5_deletion_audit_hardening/migration.sql");
const tenant = read("src/modules/SuperAdmin/tenantAdmin.service.ts");
const access = read("src/modules/Entitlement/tenantAccessResolver.service.ts");
const routes = read("src/modules/SuperAdmin/superAdmin.routes.ts");

assert(enums.includes("PENDING_DELETION"), "PENDING_DELETION lifecycle enum is missing");
for (const field of ["deletionStartedAt", "deletionReason", "deletionAttemptCount", "deletionLastAttemptAt", "deletionLastError"]) assert(admin.includes(field), `AdminProfile.${field} is missing`);
for (const field of ["before", "after", "requestId", "ipAddress", "userAgent"]) assert(audit.includes(field), `SuperAdminAuditLog.${field} is missing`);
assert(migration.includes("super_admin_audit_log_immutable"), "append-only audit trigger is missing");
for (const token of ["TENANT_HARD_DELETE_STARTED", "TENANT_HARD_DELETE_RETRIED", "TENANT_HARD_DELETE_FAILED", "TENANT_HARD_DELETED", "TENANT_DELETE_ALREADY_IN_PROGRESS", "Promise.allSettled"]) assert(tenant.includes(token), `deletion workflow missing ${token}`);
assert(access.includes('"TENANT_PENDING_DELETION"'), "canonical access resolver does not block pending deletion");

const statements = routes.match(/router\.(?:get|post|patch|put|delete)\([\s\S]*?\);/g) ?? [];
assert(statements.length > 20, "Super Admin route parser found too few routes");
for (const statement of statements) assert(statement.includes("isSuperAdmin"), `unprotected Super Admin route: ${statement.slice(0, 100).replace(/\s+/g, " ")}`);

console.log(`[phase5] production gate OK (${statements.length} Super Admin routes protected)`);
