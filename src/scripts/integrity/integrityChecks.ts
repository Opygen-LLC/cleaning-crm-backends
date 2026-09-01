import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { API_CONTRACT } from "../../contracts/apiContract";
import { getCanonicalWebsiteOrigin } from "../../modules/Website/websiteCanonicalHost";

export type IntegritySeverity = "P0" | "P1" | "P2";
export type IntegrityCategory = "auth" | "tenant" | "onboarding" | "website";

export type SafeFixAction =
  | "DELETE_EXPIRED_SESSION"
  | "DELETE_SESSION"
  | "NORMALIZE_ONBOARDING_STEPS"
  | "CLEAR_BOOKING_SERVICE"
  | "DELETE_BOOKING_STAFF_ASSIGNMENT"
  | "CLEAR_LEAD_SERVICE"
  | "CLEAR_LEAD_SOURCE_WEBSITE"
  | "CLEAR_JOB_SERVICE"
  | "CLEAR_JOB_QUOTE"
  | "CLEAR_JOB_ESTIMATE"
  | "CLEAR_JOB_BOOKING"
  | "DELETE_JOB_STAFF_ASSIGNMENT"
  | "CLEAR_INVOICE_SERVICE"
  | "CLEAR_INVOICE_BOOKING"
  | "CLEAR_PAYMENT_INVOICE"
  | "CLEAR_QUOTE_SERVICE"
  | "CLEAR_ESTIMATE_SERVICE"
  | "CLEAR_REVIEW_STAFF"
  | "DETACH_PRIMARY_BOOKING_FORM"
  | "DETACH_PRIMARY_ESTIMATE_FORM"
  | "DELETE_BOOKING_FORM_SERVICE"
  | "CLEAR_BOOKING_SUBMISSION_SERVICE"
  | "CLEAR_BOOKING_SUBMISSION_SOURCE_WEBSITE"
  | "CLEAR_BOOKING_SUBMISSION_CONVERTED_BOOKING"
  | "DELETE_ESTIMATE_FORM_SERVICE"
  | "CLEAR_ESTIMATE_SUBMISSION_SERVICE"
  | "CLEAR_ESTIMATE_SUBMISSION_SOURCE_WEBSITE"
  | "CLEAR_CHECKLIST_TEMPLATE_SERVICE"
  | "DELETE_RECURRING_STAFF_ASSIGNMENT"
  | "CLEAR_RECURRING_SERVICE"
  | "DISABLE_BOOKING"
  | "DISABLE_ESTIMATE"
  | "UNSET_INVALID_PRIMARY_DOMAIN"
  | "BACKFILL_COMPLETED_ONBOARDING_STEPS"
  | "SYNC_DRAFT_REVISION"
  | "SYNC_SUBSCRIPTION_PLAN_PARENT";

export type IntegrityRow = Record<string, unknown> & {
  id?: string;
  adminId?: string;
  relatedAdminId?: string | null;
  relationId?: string | null;
};

export interface IntegrityFindingGroup {
  code: string;
  severity: IntegritySeverity;
  category: IntegrityCategory;
  entity: string;
  description: string;
  rows: IntegrityRow[];
  fixAction?: SafeFixAction;
}

type Check = Omit<IntegrityFindingGroup, "rows"> & { sql: Prisma.Sql };

const EXPIRED_SESSION_RETENTION_DAYS = Math.max(
  1,
  Number.parseInt(process.env.EXPIRED_SESSION_RETENTION_DAYS ?? "30", 10) || 30,
);

const requiredOnboardingSteps = [...API_CONTRACT.onboardingStep];
const requiredStepsSql = Prisma.sql`ARRAY[${Prisma.join(requiredOnboardingSteps)}]::text[]`;

const checks: Check[] = [
  // ── Authentication integrity ──────────────────────────────────────────────
  {
    code: "USER_WITHOUT_ANY_ACCOUNT",
    severity: "P0",
    category: "auth",
    entity: "User",
    description: "Application user has no Better Auth Account row.",
    sql: Prisma.sql`SELECT u.id, u.role::text AS role, u.status::text AS status FROM "user" u LEFT JOIN "account" a ON a."userId" = u.id WHERE a.id IS NULL`,
  },
  {
    code: "USER_WITHOUT_CREDENTIAL_ACCOUNT",
    severity: "P2",
    category: "auth",
    entity: "User",
    description: "User has an account but no credential provider. This is valid for social-only users and is reported for review, not repaired.",
    sql: Prisma.sql`
      SELECT u.id, u.role::text AS role,
             array_agg(DISTINCT a."providerId") AS providers
      FROM "user" u
      JOIN "account" a ON a."userId" = u.id
      GROUP BY u.id, u.role
      HAVING BOOL_OR(a."providerId" = 'credential') = false
    `,
  },
  {
    code: "CREDENTIAL_ACCOUNT_WITHOUT_USER",
    severity: "P0",
    category: "auth",
    entity: "Account",
    description: "Credential account references a missing user.",
    sql: Prisma.sql`SELECT a.id, a."userId" FROM "account" a LEFT JOIN "user" u ON u.id = a."userId" WHERE a."providerId" = 'credential' AND u.id IS NULL`,
  },
  {
    code: "DUPLICATE_CREDENTIAL_ACCOUNT",
    severity: "P0",
    category: "auth",
    entity: "Account",
    description: "A user owns more than one credential account.",
    sql: Prisma.sql`SELECT a."userId" AS id, COUNT(*)::int AS count FROM "account" a WHERE a."providerId" = 'credential' GROUP BY a."userId" HAVING COUNT(*) > 1`,
  },
  {
    code: "CREDENTIAL_ACCOUNT_IDENTITY_MISMATCH",
    severity: "P1",
    category: "auth",
    entity: "Account",
    description: "Credential accountId is not the owning user id, which violates the registration contract used by this application.",
    sql: Prisma.sql`SELECT a.id, a."userId", a."accountId" FROM "account" a WHERE a."providerId" = 'credential' AND a."accountId" <> a."userId"`,
  },
  {
    code: "ORPHAN_SESSION",
    severity: "P0",
    category: "auth",
    entity: "Session",
    description: "Session references a missing user.",
    sql: Prisma.sql`SELECT s.id, s."userId" FROM "session" s LEFT JOIN "user" u ON u.id = s."userId" WHERE u.id IS NULL`,
  },
  {
    code: "EXPIRED_SESSION_OVER_RETENTION",
    severity: "P2",
    category: "auth",
    entity: "Session",
    description: `Session expired more than ${EXPIRED_SESSION_RETENTION_DAYS} days ago and can be deleted safely.`,
    fixAction: "DELETE_EXPIRED_SESSION",
    sql: Prisma.sql`SELECT s.id, s."userId", s."expiresAt" FROM "session" s WHERE s."expiresAt" < NOW() - (${EXPIRED_SESSION_RETENTION_DAYS} * INTERVAL '1 day')`,
  },
  {
    code: "SESSION_REFRESH_FAMILY_WITHOUT_HASH",
    severity: "P0",
    category: "auth",
    entity: "Session",
    description: "Refresh family metadata exists without the current refresh-token hash.",
    sql: Prisma.sql`SELECT id, "userId", "refreshFamilyId" FROM "session" WHERE "refreshFamilyId" IS NOT NULL AND "refreshTokenHash" IS NULL`,
  },
  {
    code: "SESSION_REFRESH_HASH_WITHOUT_FAMILY",
    severity: "P0",
    category: "auth",
    entity: "Session",
    description: "Refresh-token hash exists without a refresh family id.",
    sql: Prisma.sql`SELECT id, "userId" FROM "session" WHERE "refreshTokenHash" IS NOT NULL AND "refreshFamilyId" IS NULL`,
  },
  {
    code: "DISABLED_ACCOUNT_HAS_LIVE_SESSION",
    severity: "P0",
    category: "auth",
    entity: "Session",
    description: "SUSPENDED or DELETED account still has an unexpired authenticated session.",
    fixAction: "DELETE_SESSION",
    sql: Prisma.sql`SELECT s.id, s."userId", u.status::text AS status FROM "session" s JOIN "user" u ON u.id=s."userId" WHERE u.status::text IN ('SUSPENDED','DELETED') AND s."expiresAt" > NOW()`,
  },
  {
    code: "VERIFIED_USER_STILL_PENDING",
    severity: "P0",
    category: "auth",
    entity: "User",
    description: "Verified user remains PENDING instead of being activated or intentionally suspended/deleted.",
    sql: Prisma.sql`SELECT id, role::text AS role FROM "user" WHERE "emailVerified" = true AND status::text = 'PENDING'`,
  },
  {
    code: "ACTIVE_USER_NOT_VERIFIED",
    severity: "P0",
    category: "auth",
    entity: "User",
    description: "ACTIVE account is not email verified.",
    sql: Prisma.sql`SELECT id, role::text AS role FROM "user" WHERE "emailVerified" = false AND status::text = 'ACTIVE'`,
  },
  {
    code: "ADMIN_USER_WITHOUT_PROFILE",
    severity: "P0",
    category: "auth",
    entity: "User",
    description: "ADMIN user is missing AdminProfile.",
    sql: Prisma.sql`SELECT u.id FROM "user" u LEFT JOIN "AdminProfile" a ON a."userId" = u.id WHERE u.role::text = 'ADMIN' AND a.id IS NULL`,
  },
  {
    code: "STAFF_USER_WITHOUT_PROFILE",
    severity: "P0",
    category: "auth",
    entity: "User",
    description: "STAFF user is missing StaffProfile.",
    sql: Prisma.sql`SELECT u.id FROM "user" u LEFT JOIN "StaffProfile" s ON s."userId" = u.id WHERE u.role::text = 'STAFF' AND s.id IS NULL`,
  },
  {
    code: "ADMIN_PROFILE_USER_ROLE_MISMATCH",
    severity: "P0",
    category: "auth",
    entity: "AdminProfile",
    description: "AdminProfile is attached to a user whose role is not ADMIN.",
    sql: Prisma.sql`SELECT a.id, a."userId", u.role::text AS role FROM "AdminProfile" a JOIN "user" u ON u.id = a."userId" WHERE u.role::text <> 'ADMIN'`,
  },
  {
    code: "STAFF_PROFILE_USER_ROLE_MISMATCH",
    severity: "P0",
    category: "auth",
    entity: "StaffProfile",
    description: "StaffProfile is attached to a user whose role is not STAFF.",
    sql: Prisma.sql`SELECT s.id, s."adminId", s."userId", u.role::text AS role FROM "StaffProfile" s JOIN "user" u ON u.id = s."userId" WHERE u.role::text <> 'STAFF'`,
  },
  {
    code: "ACTIVE_ADMIN_INCOMPLETE_GRAPH",
    severity: "P0",
    category: "auth",
    entity: "User",
    description: "ACTIVE verified ADMIN is missing profile, website, or subscription history.",
    sql: Prisma.sql`
      SELECT u.id, ap.id AS "adminId",
             (bw.id IS NOT NULL) AS "hasWebsite",
             EXISTS (SELECT 1 FROM "Subscription" s WHERE s."adminId" = ap.id) AS "hasSubscription"
      FROM "user" u
      LEFT JOIN "AdminProfile" ap ON ap."userId" = u.id
      LEFT JOIN "business_website" bw ON bw."adminId" = ap.id
      WHERE u.role::text = 'ADMIN' AND u.status::text = 'ACTIVE' AND u."emailVerified" = true
        AND (ap.id IS NULL OR bw.id IS NULL OR NOT EXISTS (SELECT 1 FROM "Subscription" s WHERE s."adminId" = ap.id))
    `,
  },

  // ── Core tenant ownership ─────────────────────────────────────────────────
  {
    code: "BOOKING_CLIENT_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Booking",
    description: "Booking and client belong to different admins.",
    sql: Prisma.sql`SELECT b.id, b."adminId", c."adminId" AS "relatedAdminId", b."clientId" AS "relationId" FROM "booking" b JOIN "client" c ON c.id = b."clientId" WHERE b."adminId" <> c."adminId"`,
  },
  {
    code: "BOOKING_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Booking",
    description: "Booking references another tenant's service catalog.",
    fixAction: "CLEAR_BOOKING_SERVICE",
    sql: Prisma.sql`SELECT b.id, b."adminId", s."adminId" AS "relatedAdminId", b."serviceCatalogId" AS "relationId" FROM "booking" b JOIN "service_catalog" s ON s.id = b."serviceCatalogId" WHERE b."adminId" <> s."adminId"`,
  },
  {
    code: "BOOKING_QUOTE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Booking",
    description: "Booking references another tenant's quote.",
    sql: Prisma.sql`SELECT b.id, b."adminId", q."adminId" AS "relatedAdminId", b."quoteId" AS "relationId" FROM "booking" b JOIN "quote" q ON q.id = b."quoteId" WHERE b."adminId" <> q."adminId"`,
  },
  {
    code: "BOOKING_RECURRING_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Booking",
    description: "Booking references another tenant's recurring schedule.",
    sql: Prisma.sql`SELECT b.id, b."adminId", r."adminId" AS "relatedAdminId", b."recurringScheduleId" AS "relationId" FROM "booking" b JOIN "recurring_schedule" r ON r.id = b."recurringScheduleId" WHERE b."adminId" <> r."adminId"`,
  },
  {
    code: "BOOKING_STAFF_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "BookingStaffAssignment",
    description: "Booking is assigned to staff from another tenant.",
    fixAction: "DELETE_BOOKING_STAFF_ASSIGNMENT",
    sql: Prisma.sql`SELECT bsa."bookingId" AS id, b."adminId", sp."adminId" AS "relatedAdminId", bsa."staffId" AS "relationId" FROM "booking_staff_assignment" bsa JOIN "booking" b ON b.id = bsa."bookingId" JOIN "StaffProfile" sp ON sp.id = bsa."staffId" WHERE b."adminId" <> sp."adminId"`,
  },
  {
    code: "BOOKING_CHANGE_REQUEST_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "BookingChangeRequest",
    description: "Booking change request admin does not match its booking or client.",
    sql: Prisma.sql`
      SELECT r.id, r."adminId", b."adminId" AS "bookingAdminId", c."adminId" AS "clientAdminId"
      FROM "booking_change_request" r
      JOIN "booking" b ON b.id = r."bookingId"
      JOIN "client" c ON c.id = r."clientId"
      WHERE r."adminId" <> b."adminId" OR r."adminId" <> c."adminId"
    `,
  },
  {
    code: "LEAD_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Lead",
    description: "Lead references another tenant's service catalog.",
    fixAction: "CLEAR_LEAD_SERVICE",
    sql: Prisma.sql`SELECT l.id, l."adminId", s."adminId" AS "relatedAdminId", l."serviceCatalogId" AS "relationId" FROM "lead" l JOIN "service_catalog" s ON s.id = l."serviceCatalogId" WHERE l."adminId" <> s."adminId"`,
  },
  {
    code: "LEAD_SOURCE_WEBSITE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Lead",
    description: "Lead attribution points at another tenant's website.",
    fixAction: "CLEAR_LEAD_SOURCE_WEBSITE",
    sql: Prisma.sql`SELECT l.id, l."adminId", w."adminId" AS "relatedAdminId", l."sourceWebsiteId" AS "relationId" FROM "lead" l JOIN "business_website" w ON w.id = l."sourceWebsiteId" WHERE l."adminId" <> w."adminId"`,
  },
  {
    code: "JOB_CLIENT_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Job",
    description: "Job and client belong to different admins.",
    sql: Prisma.sql`SELECT j.id, j."adminId", c."adminId" AS "relatedAdminId", j."clientId" AS "relationId" FROM "job" j JOIN "client" c ON c.id = j."clientId" WHERE j."adminId" <> c."adminId"`,
  },
  {
    code: "JOB_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Job",
    description: "Job references another tenant's service catalog.",
    fixAction: "CLEAR_JOB_SERVICE",
    sql: Prisma.sql`SELECT j.id, j."adminId", s."adminId" AS "relatedAdminId", j."serviceCatalogId" AS "relationId" FROM "job" j JOIN "service_catalog" s ON s.id = j."serviceCatalogId" WHERE j."adminId" <> s."adminId"`,
  },
  {
    code: "JOB_QUOTE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Job",
    description: "Job references another tenant's quote.",
    fixAction: "CLEAR_JOB_QUOTE",
    sql: Prisma.sql`SELECT j.id, j."adminId", q."adminId" AS "relatedAdminId", j."quoteId" AS "relationId" FROM "job" j JOIN "quote" q ON q.id = j."quoteId" WHERE j."adminId" <> q."adminId"`,
  },
  {
    code: "JOB_ESTIMATE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Job",
    description: "Job references another tenant's estimate.",
    fixAction: "CLEAR_JOB_ESTIMATE",
    sql: Prisma.sql`SELECT j.id, j."adminId", e."adminId" AS "relatedAdminId", j."estimateId" AS "relationId" FROM "job" j JOIN "estimate" e ON e.id = j."estimateId" WHERE j."adminId" <> e."adminId"`,
  },
  {
    code: "JOB_BOOKING_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Job",
    description: "Job references another tenant's booking.",
    fixAction: "CLEAR_JOB_BOOKING",
    sql: Prisma.sql`SELECT j.id, j."adminId", b."adminId" AS "relatedAdminId", j."bookingId" AS "relationId" FROM "job" j JOIN "booking" b ON b.id = j."bookingId" WHERE j."adminId" <> b."adminId"`,
  },
  {
    code: "JOB_STAFF_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "JobStaffAssignment",
    description: "Job is assigned to staff from another tenant.",
    fixAction: "DELETE_JOB_STAFF_ASSIGNMENT",
    sql: Prisma.sql`SELECT jsa."jobId" AS id, j."adminId", sp."adminId" AS "relatedAdminId", jsa."staffId" AS "relationId" FROM "job_staff_assignment" jsa JOIN "job" j ON j.id = jsa."jobId" JOIN "StaffProfile" sp ON sp.id = jsa."staffId" WHERE j."adminId" <> sp."adminId"`,
  },
  {
    code: "INVOICE_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Invoice",
    description: "Invoice references another tenant's service catalog.",
    fixAction: "CLEAR_INVOICE_SERVICE",
    sql: Prisma.sql`SELECT i.id, i."adminId", s."adminId" AS "relatedAdminId", i."serviceCatalogId" AS "relationId" FROM "invoice" i JOIN "service_catalog" s ON s.id = i."serviceCatalogId" WHERE i."adminId" <> s."adminId"`,
  },
  {
    code: "INVOICE_BOOKING_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Invoice",
    description: "Invoice references another tenant's booking.",
    fixAction: "CLEAR_INVOICE_BOOKING",
    sql: Prisma.sql`SELECT i.id, i."adminId", b."adminId" AS "relatedAdminId", i."bookingId" AS "relationId" FROM "invoice" i JOIN "booking" b ON b.id = i."bookingId" WHERE i."adminId" <> b."adminId"`,
  },
  {
    code: "PAYMENT_INVOICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Payment",
    description: "Payment references another tenant's invoice.",
    fixAction: "CLEAR_PAYMENT_INVOICE",
    sql: Prisma.sql`SELECT p.id, p."adminId", i."adminId" AS "relatedAdminId", p."invoiceId" AS "relationId" FROM "payment" p JOIN "invoice" i ON i.id = p."invoiceId" WHERE p."adminId" <> i."adminId"`,
  },
  {
    code: "QUOTE_CLIENT_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Quote",
    description: "Quote and client belong to different admins.",
    sql: Prisma.sql`SELECT q.id, q."adminId", c."adminId" AS "relatedAdminId", q."clientId" AS "relationId" FROM "quote" q JOIN "client" c ON c.id = q."clientId" WHERE q."adminId" <> c."adminId"`,
  },
  {
    code: "QUOTE_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Quote",
    description: "Quote references another tenant's service catalog.",
    fixAction: "CLEAR_QUOTE_SERVICE",
    sql: Prisma.sql`SELECT q.id, q."adminId", s."adminId" AS "relatedAdminId", q."serviceCatalogId" AS "relationId" FROM "quote" q JOIN "service_catalog" s ON s.id = q."serviceCatalogId" WHERE q."adminId" <> s."adminId"`,
  },
  {
    code: "ESTIMATE_CLIENT_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Estimate",
    description: "Estimate and client belong to different admins.",
    sql: Prisma.sql`SELECT e.id, e."adminId", c."adminId" AS "relatedAdminId", e."clientId" AS "relationId" FROM "estimate" e JOIN "client" c ON c.id = e."clientId" WHERE e."adminId" <> c."adminId"`,
  },
  {
    code: "ESTIMATE_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Estimate",
    description: "Estimate references another tenant's service catalog.",
    fixAction: "CLEAR_ESTIMATE_SERVICE",
    sql: Prisma.sql`SELECT e.id, e."adminId", s."adminId" AS "relatedAdminId", e."serviceCatalogId" AS "relationId" FROM "estimate" e JOIN "service_catalog" s ON s.id = e."serviceCatalogId" WHERE e."adminId" <> s."adminId"`,
  },
  {
    code: "REVIEW_TOKEN_JOB_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "ReviewToken",
    description: "Review token admin does not match its job admin.",
    sql: Prisma.sql`SELECT rt.id, rt."adminId", j."adminId" AS "relatedAdminId", rt."jobId" AS "relationId" FROM "review_token" rt JOIN "job" j ON j.id = rt."jobId" WHERE rt."adminId" <> j."adminId"`,
  },
  {
    code: "REVIEW_JOB_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Review",
    description: "Review admin does not match its job admin.",
    sql: Prisma.sql`SELECT r.id, r."adminId", j."adminId" AS "relatedAdminId", r."jobId" AS "relationId" FROM "review" r JOIN "job" j ON j.id = r."jobId" WHERE r."adminId" <> j."adminId"`,
  },
  {
    code: "REVIEW_TOKEN_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Review",
    description: "Review admin does not match its review token admin/job.",
    sql: Prisma.sql`SELECT r.id, r."adminId", rt."adminId" AS "relatedAdminId", r."reviewTokenId" AS "relationId" FROM "review" r JOIN "review_token" rt ON rt.id = r."reviewTokenId" WHERE r."adminId" <> rt."adminId" OR r."jobId" <> rt."jobId"`,
  },
  {
    code: "REVIEW_STAFF_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "Review",
    description: "Review references staff from another tenant.",
    fixAction: "CLEAR_REVIEW_STAFF",
    sql: Prisma.sql`SELECT r.id, r."adminId", sp."adminId" AS "relatedAdminId", r."staffId" AS "relationId" FROM "review" r JOIN "StaffProfile" sp ON sp.id = r."staffId" WHERE r."staffId" IS NOT NULL AND r."adminId" <> sp."adminId"`,
  },

  // ── Website/forms/service acquisition tenant ownership ───────────────────
  {
    code: "PRIMARY_BOOKING_FORM_CROSS_TENANT",
    severity: "P0", category: "website", entity: "BusinessWebsite",
    description: "Website primary booking form belongs to another tenant.",
    fixAction: "DETACH_PRIMARY_BOOKING_FORM",
    sql: Prisma.sql`SELECT w.id, w."adminId", f."adminId" AS "relatedAdminId", w."primaryBookingFormId" AS "relationId" FROM "business_website" w JOIN "booking_form" f ON f.id = w."primaryBookingFormId" WHERE w."adminId" <> f."adminId"`,
  },
  {
    code: "PRIMARY_ESTIMATE_FORM_CROSS_TENANT",
    severity: "P0", category: "website", entity: "BusinessWebsite",
    description: "Website primary estimate form belongs to another tenant.",
    fixAction: "DETACH_PRIMARY_ESTIMATE_FORM",
    sql: Prisma.sql`SELECT w.id, w."adminId", f."adminId" AS "relatedAdminId", w."primaryEstimateFormId" AS "relationId" FROM "business_website" w JOIN "estimate_form" f ON f.id = w."primaryEstimateFormId" WHERE w."adminId" <> f."adminId"`,
  },
  {
    code: "BOOKING_FORM_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "BookingFormService",
    description: "Booking form contains another tenant's service.",
    fixAction: "DELETE_BOOKING_FORM_SERVICE",
    sql: Prisma.sql`SELECT bfs.id, f."adminId", s."adminId" AS "relatedAdminId", bfs."serviceCatalogId" AS "relationId" FROM "booking_form_service" bfs JOIN "booking_form" f ON f.id = bfs."formId" JOIN "service_catalog" s ON s.id = bfs."serviceCatalogId" WHERE f."adminId" <> s."adminId"`,
  },
  {
    code: "BOOKING_SUBMISSION_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "BookingFormSubmission",
    description: "Booking submission service does not belong to the form owner.",
    fixAction: "CLEAR_BOOKING_SUBMISSION_SERVICE",
    sql: Prisma.sql`SELECT sub.id, f."adminId", s."adminId" AS "relatedAdminId", sub."serviceCatalogId" AS "relationId" FROM "booking_form_submission" sub JOIN "booking_form" f ON f.id = sub."formId" JOIN "service_catalog" s ON s.id = sub."serviceCatalogId" WHERE f."adminId" <> s."adminId"`,
  },
  {
    code: "BOOKING_SUBMISSION_SOURCE_WEBSITE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "BookingFormSubmission",
    description: "Booking submission source website does not belong to the form owner.",
    fixAction: "CLEAR_BOOKING_SUBMISSION_SOURCE_WEBSITE",
    sql: Prisma.sql`SELECT sub.id, f."adminId", w."adminId" AS "relatedAdminId", sub."sourceWebsiteId" AS "relationId" FROM "booking_form_submission" sub JOIN "booking_form" f ON f.id = sub."formId" JOIN "business_website" w ON w.id = sub."sourceWebsiteId" WHERE f."adminId" <> w."adminId"`,
  },
  {
    code: "BOOKING_SUBMISSION_CONVERTED_BOOKING_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "BookingFormSubmission",
    description: "Booking submission was converted into another tenant's booking.",
    fixAction: "CLEAR_BOOKING_SUBMISSION_CONVERTED_BOOKING",
    sql: Prisma.sql`SELECT sub.id, f."adminId", b."adminId" AS "relatedAdminId", sub."convertedBookingId" AS "relationId" FROM "booking_form_submission" sub JOIN "booking_form" f ON f.id = sub."formId" JOIN "booking" b ON b.id = sub."convertedBookingId" WHERE f."adminId" <> b."adminId"`,
  },
  {
    code: "ESTIMATE_FORM_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "EstimateFormService",
    description: "Estimate form contains another tenant's service.",
    fixAction: "DELETE_ESTIMATE_FORM_SERVICE",
    sql: Prisma.sql`SELECT efs.id, f."adminId", s."adminId" AS "relatedAdminId", efs."serviceCatalogId" AS "relationId" FROM "estimate_form_service" efs JOIN "estimate_form" f ON f.id = efs."formId" JOIN "service_catalog" s ON s.id = efs."serviceCatalogId" WHERE f."adminId" <> s."adminId"`,
  },
  {
    code: "ESTIMATE_SUBMISSION_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "EstimateFormSubmission",
    description: "Estimate submission service does not belong to the form owner.",
    fixAction: "CLEAR_ESTIMATE_SUBMISSION_SERVICE",
    sql: Prisma.sql`SELECT sub.id, f."adminId", s."adminId" AS "relatedAdminId", sub."serviceCatalogId" AS "relationId" FROM "estimate_form_submission" sub JOIN "estimate_form" f ON f.id = sub."formId" JOIN "service_catalog" s ON s.id = sub."serviceCatalogId" WHERE f."adminId" <> s."adminId"`,
  },
  {
    code: "ESTIMATE_SUBMISSION_SOURCE_WEBSITE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "EstimateFormSubmission",
    description: "Estimate submission source website does not belong to the form owner.",
    fixAction: "CLEAR_ESTIMATE_SUBMISSION_SOURCE_WEBSITE",
    sql: Prisma.sql`SELECT sub.id, f."adminId", w."adminId" AS "relatedAdminId", sub."sourceWebsiteId" AS "relationId" FROM "estimate_form_submission" sub JOIN "estimate_form" f ON f.id = sub."formId" JOIN "business_website" w ON w.id = sub."sourceWebsiteId" WHERE f."adminId" <> w."adminId"`,
  },
  {
    code: "WEBSITE_SUBMISSION_WEBSITE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "WebsiteSubmission",
    description: "Website submission owner does not match its source website owner.",
    sql: Prisma.sql`SELECT ws.id, ws."adminId", w."adminId" AS "relatedAdminId", ws."websiteId" AS "relationId" FROM "website_submission" ws JOIN "business_website" w ON w.id = ws."websiteId" WHERE ws."adminId" <> w."adminId"`,
  },
  {
    code: "WEBSITE_SUBMISSION_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "WebsiteSubmission",
    description: "Website submission references another tenant's service.",
    sql: Prisma.sql`SELECT ws.id, ws."adminId", s."adminId" AS "relatedAdminId", ws."serviceCatalogId" AS "relationId" FROM "website_submission" ws JOIN "service_catalog" s ON s.id = ws."serviceCatalogId" WHERE ws."adminId" <> s."adminId"`,
  },
  {
    code: "WEBSITE_SUBMISSION_LEAD_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "WebsiteSubmission",
    description: "Website submission references another tenant's lead.",
    sql: Prisma.sql`SELECT ws.id, ws."adminId", l."adminId" AS "relatedAdminId", ws."leadId" AS "relationId" FROM "website_submission" ws JOIN "lead" l ON l.id = ws."leadId" WHERE ws."adminId" <> l."adminId"`,
  },
  {
    code: "WEBSITE_SUBMISSION_BOOKING_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "WebsiteSubmission",
    description: "Website submission booking request belongs to another tenant.",
    sql: Prisma.sql`SELECT ws.id, ws."adminId", f."adminId" AS "relatedAdminId", ws."bookingFormSubmissionId" AS "relationId" FROM "website_submission" ws JOIN "booking_form_submission" b ON b.id = ws."bookingFormSubmissionId" JOIN "booking_form" f ON f.id = b."formId" WHERE ws."adminId" <> f."adminId"`,
  },
  {
    code: "WEBSITE_SUBMISSION_ESTIMATE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "WebsiteSubmission",
    description: "Website submission estimate request belongs to another tenant.",
    sql: Prisma.sql`SELECT ws.id, ws."adminId", f."adminId" AS "relatedAdminId", ws."estimateFormSubmissionId" AS "relationId" FROM "website_submission" ws JOIN "estimate_form_submission" e ON e.id = ws."estimateFormSubmissionId" JOIN "estimate_form" f ON f.id = e."formId" WHERE ws."adminId" <> f."adminId"`,
  },
  {
    code: "CHECKLIST_TEMPLATE_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "ChecklistTemplate",
    description: "Checklist template references another tenant's service.",
    fixAction: "CLEAR_CHECKLIST_TEMPLATE_SERVICE",
    sql: Prisma.sql`SELECT ct.id, ct."adminId", s."adminId" AS "relatedAdminId", ct."serviceCatalogId" AS "relationId" FROM "checklist_template" ct JOIN "service_catalog" s ON s.id = ct."serviceCatalogId" WHERE ct."adminId" <> s."adminId"`,
  },
  {
    code: "JOB_CHECKLIST_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "JobChecklist",
    description: "Job checklist owner does not match its job or template owner.",
    sql: Prisma.sql`SELECT jc.id, jc."adminId", j."adminId" AS "jobAdminId", ct."adminId" AS "templateAdminId" FROM "job_checklist" jc JOIN "job" j ON j.id = jc."jobId" JOIN "checklist_template" ct ON ct.id = jc."templateId" WHERE jc."adminId" <> j."adminId" OR jc."adminId" <> ct."adminId"`,
  },
  {
    code: "JOB_CHECKLIST_ITEM_STAFF_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "JobChecklistItem",
    description: "Checklist completion references staff from another tenant.",
    sql: Prisma.sql`SELECT i.id, jc."adminId", sp."adminId" AS "relatedAdminId", i."completedBy" AS "relationId" FROM "job_checklist_item" i JOIN "job_checklist" jc ON jc.id = i."checklistId" JOIN "StaffProfile" sp ON sp.id = i."completedBy" WHERE i."completedBy" IS NOT NULL AND jc."adminId" <> sp."adminId"`,
  },
  {
    code: "RECURRING_CLIENT_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "RecurringSchedule",
    description: "Recurring schedule and client belong to different admins.",
    sql: Prisma.sql`SELECT r.id, r."adminId", c."adminId" AS "relatedAdminId", r."clientId" AS "relationId" FROM "recurring_schedule" r JOIN "client" c ON c.id = r."clientId" WHERE r."adminId" <> c."adminId"`,
  },
  {
    code: "RECURRING_SERVICE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "RecurringSchedule",
    description: "Recurring schedule references another tenant's service.",
    fixAction: "CLEAR_RECURRING_SERVICE",
    sql: Prisma.sql`SELECT r.id, r."adminId", s."adminId" AS "relatedAdminId", r."serviceCatalogId" AS "relationId" FROM "recurring_schedule" r JOIN "service_catalog" s ON s.id = r."serviceCatalogId" WHERE r."adminId" <> s."adminId"`,
  },
  {
    code: "RECURRING_STAFF_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "RecurringStaffAssignment",
    description: "Recurring schedule assigns staff from another tenant.",
    fixAction: "DELETE_RECURRING_STAFF_ASSIGNMENT",
    sql: Prisma.sql`SELECT rsa."scheduleId" AS id, r."adminId", sp."adminId" AS "relatedAdminId", rsa."staffId" AS "relationId" FROM "recurring_staff_assignment" rsa JOIN "recurring_schedule" r ON r.id = rsa."scheduleId" JOIN "StaffProfile" sp ON sp.id = rsa."staffId" WHERE r."adminId" <> sp."adminId"`,
  },
  {
    code: "RECURRING_GENERATED_BOOKING_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "RecurringSchedule",
    description: "Generated booking belongs to a different tenant from its schedule.",
    sql: Prisma.sql`SELECT r.id, r."adminId", b."adminId" AS "relatedAdminId", b.id AS "relationId" FROM "recurring_schedule" r JOIN "booking" b ON b."recurringScheduleId" = r.id WHERE r."adminId" <> b."adminId"`,
  },

  // Owner FKs — normally enforced by PostgreSQL, retained here so drift or
  // disabled constraints cannot silently leave tenant-owned rows detached.
  {
    code: "TENANT_ENTITY_WITHOUT_ADMIN",
    severity: "P0", category: "tenant", entity: "TenantOwnedEntity",
    description: "A tenant-owned row points at a missing AdminProfile.",
    sql: Prisma.sql`
      SELECT * FROM (
        SELECT 'Client' AS entity, c.id, c."adminId" FROM "client" c LEFT JOIN "AdminProfile" a ON a.id=c."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Lead', l.id, l."adminId" FROM "lead" l LEFT JOIN "AdminProfile" a ON a.id=l."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Booking', b.id, b."adminId" FROM "booking" b LEFT JOIN "AdminProfile" a ON a.id=b."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Job', j.id, j."adminId" FROM "job" j LEFT JOIN "AdminProfile" a ON a.id=j."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Invoice', i.id, i."adminId" FROM "invoice" i LEFT JOIN "AdminProfile" a ON a.id=i."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Payment', p.id, p."adminId" FROM "payment" p LEFT JOIN "AdminProfile" a ON a.id=p."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Quote', q.id, q."adminId" FROM "quote" q LEFT JOIN "AdminProfile" a ON a.id=q."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Estimate', e.id, e."adminId" FROM "estimate" e LEFT JOIN "AdminProfile" a ON a.id=e."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Expense', e.id, e."adminId" FROM "expense" e LEFT JOIN "AdminProfile" a ON a.id=e."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Review', r.id, r."adminId" FROM "review" r LEFT JOIN "AdminProfile" a ON a.id=r."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'StaffProfile', s.id, s."adminId" FROM "StaffProfile" s LEFT JOIN "AdminProfile" a ON a.id=s."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'BusinessWebsite', w.id, w."adminId" FROM "business_website" w LEFT JOIN "AdminProfile" a ON a.id=w."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'BookingForm', f.id, f."adminId" FROM "booking_form" f LEFT JOIN "AdminProfile" a ON a.id=f."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'EstimateForm', f.id, f."adminId" FROM "estimate_form" f LEFT JOIN "AdminProfile" a ON a.id=f."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'ServiceCatalog', s.id, s."adminId" FROM "service_catalog" s LEFT JOIN "AdminProfile" a ON a.id=s."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'ChecklistTemplate', c.id, c."adminId" FROM "checklist_template" c LEFT JOIN "AdminProfile" a ON a.id=c."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Notification', n.id, n."adminId" FROM "notification" n LEFT JOIN "AdminProfile" a ON a.id=n."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'RecurringSchedule', r.id, r."adminId" FROM "recurring_schedule" r LEFT JOIN "AdminProfile" a ON a.id=r."adminId" WHERE a.id IS NULL
        UNION ALL SELECT 'Subscription', s.id, s."adminId" FROM "Subscription" s LEFT JOIN "AdminProfile" a ON a.id=s."adminId" WHERE a.id IS NULL
      ) detached
    `,
  },

  // ── Onboarding invariants ─────────────────────────────────────────────────
  {
    code: "COMPLETED_ONBOARDING_MISSING_REQUIRED_STEPS",
    severity: "P1", category: "onboarding", entity: "AdminProfile",
    description: "onboardingCompletedAt is set but the canonical required-step array is incomplete. Backfilling the step markers is deterministic.",
    fixAction: "BACKFILL_COMPLETED_ONBOARDING_STEPS",
    sql: Prisma.sql`SELECT id, id AS "adminId", "onboardingCompletedSteps" FROM "AdminProfile" WHERE "onboardingCompletedAt" IS NOT NULL AND NOT ("onboardingCompletedSteps" @> ${requiredStepsSql})`,
  },
  {
    code: "ALL_ONBOARDING_STEPS_WITHOUT_COMPLETION_TIMESTAMP",
    severity: "P1", category: "onboarding", entity: "AdminProfile",
    description: "All required onboarding steps are marked complete but onboardingCompletedAt is null. Timestamp is not guessed automatically.",
    sql: Prisma.sql`SELECT id, id AS "adminId", "onboardingCompletedSteps" FROM "AdminProfile" WHERE "onboardingCompletedAt" IS NULL AND "onboardingCompletedSteps" @> ${requiredStepsSql}`,
  },
  {
    code: "COMPLETED_ONBOARDING_MISSING_BUSINESS_PROFILE",
    severity: "P0", category: "onboarding", entity: "AdminProfile",
    description: "Completed onboarding has an empty business name.",
    sql: Prisma.sql`SELECT id, id AS "adminId" FROM "AdminProfile" WHERE "onboardingCompletedAt" IS NOT NULL AND BTRIM("businessName") = ''`,
  },
  {
    code: "COMPLETED_ONBOARDING_MISSING_WEBSITE",
    severity: "P0", category: "onboarding", entity: "AdminProfile",
    description: "Completed onboarding has no provisioned website.",
    sql: Prisma.sql`SELECT a.id, a.id AS "adminId" FROM "AdminProfile" a LEFT JOIN "business_website" w ON w."adminId"=a.id WHERE a."onboardingCompletedAt" IS NOT NULL AND w.id IS NULL`,
  },
  {
    code: "COMPLETED_ONBOARDING_NO_ACTIVE_SERVICE",
    severity: "P1", category: "onboarding", entity: "AdminProfile",
    description: "Completed onboarding currently has no ACTIVE service. This can be intentional after setup, so it is review-only.",
    sql: Prisma.sql`SELECT a.id, a.id AS "adminId" FROM "AdminProfile" a WHERE a."onboardingCompletedAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "service_catalog" s WHERE s."adminId"=a.id AND s.status::text='ACTIVE')`,
  },

  // ── Website/revision/domain invariants ────────────────────────────────────
  {
    code: "ORPHANED_PRIMARY_BOOKING_FORM",
    severity: "P0", category: "website", entity: "BusinessWebsite",
    description: "Website primaryBookingFormId points at a missing form.",
    fixAction: "DETACH_PRIMARY_BOOKING_FORM",
    sql: Prisma.sql`SELECT w.id, w."adminId", w."primaryBookingFormId" AS "relationId" FROM "business_website" w LEFT JOIN "booking_form" f ON f.id=w."primaryBookingFormId" WHERE w."primaryBookingFormId" IS NOT NULL AND f.id IS NULL`,
  },
  {
    code: "ORPHANED_PRIMARY_ESTIMATE_FORM",
    severity: "P0", category: "website", entity: "BusinessWebsite",
    description: "Website primaryEstimateFormId points at a missing form.",
    fixAction: "DETACH_PRIMARY_ESTIMATE_FORM",
    sql: Prisma.sql`SELECT w.id, w."adminId", w."primaryEstimateFormId" AS "relationId" FROM "business_website" w LEFT JOIN "estimate_form" f ON f.id=w."primaryEstimateFormId" WHERE w."primaryEstimateFormId" IS NOT NULL AND f.id IS NULL`,
  },
  {
    code: "BOOKING_ENABLED_WITHOUT_PUBLISHED_FORM",
    severity: "P0", category: "website", entity: "BusinessWebsite",
    description: "Public booking is enabled without a published primary booking form.",
    fixAction: "DISABLE_BOOKING",
    sql: Prisma.sql`SELECT w.id, w."adminId", w."primaryBookingFormId" AS "relationId" FROM "business_website" w LEFT JOIN "booking_form" f ON f.id=w."primaryBookingFormId" WHERE w."bookingEnabled"=true AND (f.id IS NULL OR f.published=false OR f."adminId"<>w."adminId")`,
  },
  {
    code: "ESTIMATE_ENABLED_WITHOUT_PUBLISHED_FORM",
    severity: "P0", category: "website", entity: "BusinessWebsite",
    description: "Public estimate is enabled without a published primary estimate form.",
    fixAction: "DISABLE_ESTIMATE",
    sql: Prisma.sql`SELECT w.id, w."adminId", w."primaryEstimateFormId" AS "relationId" FROM "business_website" w LEFT JOIN "estimate_form" f ON f.id=w."primaryEstimateFormId" WHERE w."estimateEnabled"=true AND (f.id IS NULL OR f.published=false OR f."adminId"<>w."adminId")`,
  },
  {
    code: "PUBLISHED_WEBSITE_WITHOUT_SNAPSHOT",
    severity: "P0", category: "website", entity: "BusinessWebsite",
    description: "PUBLISHED website has no immutable published snapshot.",
    sql: Prisma.sql`SELECT id, "adminId", "publishedRevisionNumber" FROM "business_website" WHERE status::text='PUBLISHED' AND "publishedSnapshot" IS NULL`,
  },
  {
    code: "PUBLISHED_WEBSITE_WITHOUT_REVISION_NUMBER",
    severity: "P0", category: "website", entity: "BusinessWebsite",
    description: "PUBLISHED website has no publishedRevisionNumber.",
    sql: Prisma.sql`SELECT id, "adminId" FROM "business_website" WHERE status::text='PUBLISHED' AND "publishedRevisionNumber" IS NULL`,
  },
  {
    code: "PUBLISHED_REVISION_ROW_MISSING",
    severity: "P0", category: "website", entity: "BusinessWebsite",
    description: "publishedRevisionNumber does not resolve to a WebsiteRevision row.",
    sql: Prisma.sql`SELECT w.id, w."adminId", w."publishedRevisionNumber" FROM "business_website" w LEFT JOIN "website_revision" r ON r."websiteId"=w.id AND r."revisionNumber"=w."publishedRevisionNumber" WHERE w."publishedRevisionNumber" IS NOT NULL AND r.id IS NULL`,
  },
  {
    code: "PUBLISHED_SNAPSHOT_REVISION_MISMATCH",
    severity: "P0", category: "website", entity: "BusinessWebsite",
    description: "Website publishedSnapshot differs from the referenced revision snapshot.",
    sql: Prisma.sql`SELECT w.id, w."adminId", w."publishedRevisionNumber" FROM "business_website" w JOIN "website_revision" r ON r."websiteId"=w.id AND r."revisionNumber"=w."publishedRevisionNumber" WHERE w."publishedSnapshot" IS NOT NULL AND w."publishedSnapshot" <> r.snapshot`,
  },
  {
    code: "WEBSITE_DRAFT_REVISION_MISMATCH",
    severity: "P1", category: "website", entity: "BusinessWebsite",
    description: "draftRevisionNumber differs from the latest stored revision number.",
    fixAction: "SYNC_DRAFT_REVISION",
    sql: Prisma.sql`
      SELECT w.id, w."adminId", w."draftRevisionNumber", COALESCE(MAX(r."revisionNumber"),0)::int AS "latestRevision"
      FROM "business_website" w LEFT JOIN "website_revision" r ON r."websiteId"=w.id
      GROUP BY w.id
      HAVING w."draftRevisionNumber" <> COALESCE(MAX(r."revisionNumber"),0)
    `,
  },
  {
    code: "MULTIPLE_PRIMARY_CUSTOM_DOMAINS",
    severity: "P0", category: "website", entity: "WebsiteDomain",
    description: "A website has more than one primary custom domain. Selection is ambiguous and is never guessed by reconciliation.",
    sql: Prisma.sql`SELECT "websiteId" AS id, COUNT(*)::int AS count FROM "website_domain" WHERE "isPrimary"=true GROUP BY "websiteId" HAVING COUNT(*) > 1`,
  },
  {
    code: "INVALID_PRIMARY_CUSTOM_DOMAIN",
    severity: "P0", category: "website", entity: "WebsiteDomain",
    description: "Primary domain is not in a fully VERIFIED/routing-ready state.",
    fixAction: "UNSET_INVALID_PRIMARY_DOMAIN",
    sql: Prisma.sql`
      SELECT d.id, w."adminId", d."websiteId" AS "relationId", d.status::text AS status, d."tlsStatus"
      FROM "website_domain" d JOIN "business_website" w ON w.id=d."websiteId"
      WHERE d."isPrimary"=true AND (
        d.status::text <> 'VERIFIED' OR d."ownershipVerified"=false OR d."providerVerified"=false OR d."routingVerified"=false OR d."tlsStatus" NOT IN ('READY','EXTERNAL')
      )
    `,
  },
  {
    code: "VERIFIED_DOMAIN_NOT_ROUTING_READY",
    severity: "P0", category: "website", entity: "WebsiteDomain",
    description: "Domain is marked VERIFIED but provider/ownership/routing/TLS readiness is inconsistent.",
    sql: Prisma.sql`
      SELECT d.id, w."adminId", d."websiteId" AS "relationId", d."tlsStatus"
      FROM "website_domain" d JOIN "business_website" w ON w.id=d."websiteId"
      WHERE d.status::text='VERIFIED' AND (
        d."ownershipVerified"=false OR d."providerVerified"=false OR d."routingVerified"=false OR d."tlsStatus" NOT IN ('READY','EXTERNAL')
      )
    `,
  },

  // ── Phase 4 regression reconciliation ────────────────────────────────────
  {
    code: "STAFF_PROFILE_WITHOUT_USER",
    severity: "P0", category: "auth", entity: "StaffProfile",
    description: "StaffProfile references a missing user.",
    sql: Prisma.sql`SELECT sp.id, sp."adminId", sp."userId" AS "relationId" FROM "StaffProfile" sp LEFT JOIN "user" u ON u.id=sp."userId" WHERE u.id IS NULL`,
  },
  {
    code: "STAFF_SPECIALTY_NOT_IN_CATALOG",
    severity: "P1", category: "tenant", entity: "StaffProfile",
    description: "Staff specialty contains a name that does not exist in the owning tenant service catalog.",
    sql: Prisma.sql`
      SELECT sp.id, sp."adminId", specialty AS "invalidSpecialty"
      FROM "StaffProfile" sp
      CROSS JOIN LATERAL unnest(sp.specialty) AS specialty
      LEFT JOIN "service_catalog" sc
        ON sc."adminId"=sp."adminId" AND lower(btrim(sc."serviceName"))=lower(btrim(specialty))
      WHERE sc.id IS NULL
    `,
  },
  {
    code: "ORPHAN_LEAD_ACTIVITY",
    severity: "P0", category: "tenant", entity: "LeadActivity",
    description: "LeadActivity references a missing lead or a lead owned by a different tenant.",
    sql: Prisma.sql`
      SELECT la.id, la."adminId", la."leadId" AS "relationId", l."adminId" AS "relatedAdminId"
      FROM "lead_activity" la
      LEFT JOIN "lead" l ON l.id=la."leadId"
      WHERE l.id IS NULL OR l."adminId" <> la."adminId"
    `,
  },
  {
    code: "LEAD_ACTIVITY_ASSIGNEE_CROSS_TENANT",
    severity: "P0", category: "tenant", entity: "LeadActivity",
    description: "LeadActivity is assigned to an ADMIN/STAFF user outside the activity tenant or to a user without the required profile.",
    sql: Prisma.sql`
      SELECT la.id, la."adminId", la."assignedToUserId" AS "relationId",
             COALESCE(sp."adminId", ap.id) AS "relatedAdminId", u.role::text AS role
      FROM "lead_activity" la
      LEFT JOIN "user" u ON u.id=la."assignedToUserId"
      LEFT JOIN "StaffProfile" sp ON sp."userId"=u.id
      LEFT JOIN "AdminProfile" ap ON ap."userId"=u.id
      WHERE la."assignedToUserId" IS NOT NULL AND (
        u.id IS NULL OR
        (u.role::text='STAFF' AND (sp.id IS NULL OR sp."adminId" <> la."adminId")) OR
        (u.role::text='ADMIN' AND (ap.id IS NULL OR ap.id <> la."adminId")) OR
        u.role::text NOT IN ('STAFF','ADMIN')
      )
    `,
  },
  {
    code: "ORPHAN_BOOKING_CLIENT",
    severity: "P0", category: "tenant", entity: "Booking",
    description: "Booking references a missing client.",
    sql: Prisma.sql`SELECT b.id, b."adminId", b."clientId" AS "relationId" FROM "booking" b LEFT JOIN "client" c ON c.id=b."clientId" WHERE c.id IS NULL`,
  },
  {
    code: "ORPHAN_BOOKING_SERVICE",
    severity: "P1", category: "tenant", entity: "Booking",
    description: "Booking has a serviceCatalogId that no longer resolves.",
    sql: Prisma.sql`SELECT b.id, b."adminId", b."serviceCatalogId" AS "relationId" FROM "booking" b LEFT JOIN "service_catalog" sc ON sc.id=b."serviceCatalogId" WHERE b."serviceCatalogId" IS NOT NULL AND sc.id IS NULL`,
  },
  {
    code: "DUPLICATE_LEAD_NORMALIZED_EMAIL",
    severity: "P1", category: "tenant", entity: "Lead",
    description: "Tenant contains leads whose emails differ only by case/whitespace; these should be reviewed before deterministic merge logic is applied.",
    sql: Prisma.sql`
      SELECT MIN(id::text) AS id, "adminId", lower(btrim(email)) AS "normalizedEmail", COUNT(*)::int AS count
      FROM "lead"
      GROUP BY "adminId", lower(btrim(email))
      HAVING COUNT(*) > 1
    `,
  },
  {
    code: "NON_CANONICAL_REFERENCE_FORMAT",
    severity: "P1", category: "tenant", entity: "Reference",
    description: "A human-readable reference does not match the canonical allocator format and can be skipped by nextReference().",
    sql: Prisma.sql`
      SELECT id, "adminId", ref, kind FROM (
        SELECT id, "adminId", "bookingRef" AS ref, 'booking' AS kind FROM "booking" WHERE "bookingRef" !~ '^#OP-BK-[0-9]+$'
        UNION ALL SELECT id, "adminId", "jobRef", 'job' FROM "job" WHERE "jobRef" !~ '^#OP-JB-[0-9]+$'
        UNION ALL SELECT id, "adminId", "invoiceRef", 'invoice' FROM "invoice" WHERE "invoiceRef" !~ '^#OP-INV-[0-9]+$'
        UNION ALL SELECT id, "adminId", "quoteRef", 'quote' FROM "quote" WHERE "quoteRef" !~ '^#OP-QT-[0-9]+$'
        UNION ALL SELECT id, "adminId", "estimateRef", 'estimate' FROM "estimate" WHERE "estimateRef" !~ '^#OP-EST-[0-9]+$'
        UNION ALL SELECT id, "adminId", "paymentRef", 'payment' FROM "payment" WHERE "paymentRef" !~ '^#OP-PAY-[0-9]+$'
        UNION ALL SELECT id, "adminId", "scheduleRef", 'recurring' FROM "recurring_schedule" WHERE "scheduleRef" !~ '^#RS-[0-9]+$'
      ) refs
    `,
  },
];

export async function runIntegrityChecks(): Promise<IntegrityFindingGroup[]> {
  const groups: IntegrityFindingGroup[] = [];
  for (const check of checks) {
    const rows = await prisma.$queryRaw<IntegrityRow[]>(check.sql);
    groups.push({
      code: check.code,
      severity: check.severity,
      category: check.category,
      entity: check.entity,
      description: check.description,
      fixAction: check.fixAction,
      rows,
    });
  }

  // URL construction depends on runtime WEBSITE_BASE_DOMAIN rules and is safer
  // to validate through the same helper as the public resolver rather than SQL.
  const websites = await prisma.businessWebsite.findMany({
    select: {
      id: true,
      adminId: true,
      subdomain: true,
      domains: {
        where: {
          isPrimary: true,
          status: "VERIFIED",
          ownershipVerified: true,
          providerVerified: true,
          routingVerified: true,
          tlsStatus: { in: ["READY", "EXTERNAL"] },
        },
        select: { domain: true },
        take: 1,
      },
    },
  });
  const invalidOrigins: IntegrityRow[] = [];
  for (const website of websites) {
    const origin = getCanonicalWebsiteOrigin(website.subdomain, website.domains[0]?.domain ?? null);
    let valid = false;
    if (origin) {
      try {
        valid = new URL(origin).protocol === "https:";
      } catch {
        valid = false;
      }
    }
    if (!valid) invalidOrigins.push({ id: website.id, adminId: website.adminId, subdomain: website.subdomain, origin });
  }
  groups.push({
    code: "INVALID_TENANT_PUBLIC_ORIGIN",
    severity: "P1",
    category: "website",
    entity: "BusinessWebsite",
    description: "Canonical public origin cannot be produced as HTTPS from the stored subdomain/domain state.",
    rows: invalidOrigins,
  });

  const onboardingProfiles = await prisma.adminProfile.findMany({
    select: { id: true, onboardingCompletedSteps: true },
  });
  const allowed = new Set(requiredOnboardingSteps);
  const invalidOnboardingRows: IntegrityRow[] = [];
  for (const profile of onboardingProfiles) {
    const normalized = requiredOnboardingSteps.filter((step) => profile.onboardingCompletedSteps.includes(step));
    const hasUnknown = profile.onboardingCompletedSteps.some((step) => !allowed.has(step as (typeof requiredOnboardingSteps)[number]));
    const hasDuplicates = new Set(profile.onboardingCompletedSteps).size !== profile.onboardingCompletedSteps.length;
    const wrongOrder = normalized.join("|") !== profile.onboardingCompletedSteps.join("|");
    if (hasUnknown || hasDuplicates || wrongOrder) {
      invalidOnboardingRows.push({
        id: profile.id,
        adminId: profile.id,
        onboardingCompletedSteps: profile.onboardingCompletedSteps,
        normalizedSteps: normalized,
      });
    }
  }
  groups.push({
    code: "INVALID_ONBOARDING_COMPLETED_STEPS",
    severity: "P1",
    category: "onboarding",
    entity: "AdminProfile",
    description: "Onboarding step markers contain unknown values, duplicates, or non-canonical ordering.",
    fixAction: "NORMALIZE_ONBOARDING_STEPS",
    rows: invalidOnboardingRows,
  });

  const subscriptionPlanRows = await prisma.$queryRaw<IntegrityRow[]>(Prisma.sql`
    SELECT s.id, s."adminId", s."planId", s."subscriptionPlanId"
    FROM "Subscription" s
    LEFT JOIN "Plan" p ON p.id=s."planId"
    LEFT JOIN "SubscriptionPlan" sp ON sp.id=s."subscriptionPlanId"
    WHERE p.id IS NULL OR sp.id IS NULL
  `);
  groups.push({
    code: "SUBSCRIPTION_PLAN_REFERENCE_INVALID",
    severity: "P0",
    category: "tenant",
    entity: "Subscription",
    description: "Subscription references a missing Plan or SubscriptionPlan row.",
    rows: subscriptionPlanRows,
  });

  const subscriptionPlanHierarchyRows = await prisma.$queryRaw<IntegrityRow[]>(Prisma.sql`
    SELECT s.id, s."adminId", s."planId" AS "relationId", s."subscriptionPlanId", p."subscriptionPlanId" AS "expectedSubscriptionPlanId"
    FROM "Subscription" s
    JOIN "Plan" p ON p.id=s."planId"
    JOIN "SubscriptionPlan" sp ON sp.id=s."subscriptionPlanId"
    WHERE s."subscriptionPlanId" <> p."subscriptionPlanId"
  `);
  groups.push({
    code: "SUBSCRIPTION_PLAN_HIERARCHY_MISMATCH",
    severity: "P0",
    category: "tenant",
    entity: "Subscription",
    description: "Subscription.planId belongs to a different SubscriptionPlan than subscriptionPlanId.",
    fixAction: "SYNC_SUBSCRIPTION_PLAN_PARENT",
    rows: subscriptionPlanHierarchyRows,
  });

  return groups;
}

export function normalizeForJson(value: unknown): unknown {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalizeForJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, nested]) => [key, normalizeForJson(nested)]));
  }
  return value;
}

export const INTEGRITY_CONFIG = {
  expiredSessionRetentionDays: EXPIRED_SESSION_RETENTION_DAYS,
  requiredOnboardingSteps,
} as const;
