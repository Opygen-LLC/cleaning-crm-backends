import { z } from "zod";
import { AccountStatus, PendingPlanChangeStatus, TenantLifecycleStatus, UserRole } from "../../generated/prisma/enums";

const reason = z.string().trim().min(10).max(1000);
const nullableString = z.string().trim().max(500).nullable().optional();

export const tenantListQuerySchema = z.object({
  search: z.string().trim().max(120).optional(), searchTerm: z.string().trim().max(120).optional(),
  lifecycleStatus: z.nativeEnum(TenantLifecycleStatus).optional(),
  subscriptionKind: z.enum(["TRIAL", "PAID"]).optional(),
  plan: z.enum(["STARTER", "GROWTH", "PRO", "CUSTOM"]).optional(),
  subscriptionStatus: z.enum(["ACTIVE", "PENDING_PAYMENT", "SUSPENDED", "EXPIRED", "CANCELLED"]).optional(),
  websiteStatus: z.enum(["PUBLISHED", "UNPUBLISHED"]).optional(),
  page: z.string().regex(/^\d+$/).optional(), limit: z.string().regex(/^\d+$/).optional(),
});
export const reasonSchema = z.object({ reason });
export const tenantProfileSchema = z.object({
  reason,
  businessName: z.string().trim().min(2).max(120).optional(), businessLogo: nullableString,
  address: nullableString, brandColor: z.string().trim().max(32).nullable().optional(), city: nullableString,
  mobileNumber: nullableString, zipcode: nullableString, country: z.string().trim().max(80).nullable().optional(),
  businessEmail: z.string().email().nullable().optional(), businessType: nullableString, licenseNumber: nullableString,
  businessDescription: z.string().max(5000).nullable().optional(), businessHours: z.unknown().optional(),
  website: z.string().url().nullable().optional(), currency: z.string().trim().max(16).optional(),
}).refine((v) => Object.keys(v).some((key) => key !== "reason"), { message: "Provide at least one profile field." });
export const tenantOwnerSchema = z.object({ reason, name: z.string().trim().min(2).max(120).optional(), email: z.string().email().optional(), image: z.string().url().nullable().optional() }).refine((v) => v.name || v.email || v.image !== undefined, { message: "Provide at least one owner field." });
export const hardDeleteSchema = z.object({ adminId: z.string().uuid(), confirmationText: z.literal("DELETE PERMANENTLY"), reason });

export const globalUsersQuerySchema = z.object({
  search: z.string().trim().max(120).optional(), role: z.nativeEnum(UserRole).optional(), status: z.nativeEnum(AccountStatus).optional(),
  verified: z.enum(["true", "false"]).optional(), tenant: z.string().uuid().optional(), createdFrom: z.string().datetime().optional(), createdTo: z.string().datetime().optional(),
  page: z.string().regex(/^\d+$/).optional(), limit: z.string().regex(/^\d+$/).optional(),
});
export const userRoleSchema = z.object({ role: z.nativeEnum(UserRole), reason });
export const userStatusSchema = z.object({ status: z.enum([AccountStatus.ACTIVE, AccountStatus.SUSPENDED]), reason });
export const verifyUserSchema = z.object({ reason });

export const subscriptionRequestQuerySchema = z.object({ status: z.nativeEnum(PendingPlanChangeStatus).optional(), tenant: z.string().uuid().optional(), page: z.string().regex(/^\d+$/).optional(), limit: z.string().regex(/^\d+$/).optional() });
export const superAdminAuditQuerySchema = z.object({ search: z.string().trim().max(120).optional(), action: z.string().trim().max(120).optional(), tenant: z.string().uuid().optional(), actor: z.string().uuid().optional(), target: z.string().uuid().optional(), createdFrom: z.string().datetime().optional(), createdTo: z.string().datetime().optional(), page: z.string().regex(/^\d+$/).optional(), limit: z.string().regex(/^\d+$/).optional() });
export const subscriptionRequestReviewSchema = z.object({ reason });
export const planChangeSchema = z.object({ targetPlanId: z.string().uuid(), reason });
export const cancellationSchema = z.object({ cancelAtPeriodEnd: z.boolean(), reason });
export const trialManagementSchema = z.object({ action: z.enum(["RESTART", "EXTEND", "SET_END", "END"]), days: z.number().int().min(1).max(365).optional(), endAt: z.string().datetime().optional(), reason }).superRefine((v, ctx) => { if (v.action === "SET_END" && !v.endAt) ctx.addIssue({ code: "custom", path: ["endAt"], message: "endAt is required for SET_END." }); });

const resourceValue = z.discriminatedUnion("mode", [z.object({ mode: z.literal("INHERIT") }), z.object({ mode: z.enum(["ADD", "SET"]), value: z.number().int().min(0).max(1_000_000) })]);
const featureMode = z.enum(["INHERIT", "FORCE_ENABLED", "FORCE_DISABLED"]);
export const entitlementSchema = z.object({
  reason, expiresAt: z.string().datetime().nullable().optional(),
  resources: z.object({ staff: resourceValue.optional(), clients: resourceValue.optional(), monthlyBookings: resourceValue.optional(), storageMb: resourceValue.optional() }).optional(),
  features: z.object({ website: featureMode.optional(), customDomain: featureMode.optional(), analytics: featureMode.optional(), bookingForms: featureMode.optional(), recurringBookings: featureMode.optional(), crmLeads: featureMode.optional(), reports: featureMode.optional(), automations: featureMode.optional() }).optional(),
});

export const platformConfigPatchSchema = z.object({
  reason,
  platformName: z.string().trim().min(2).max(100).optional(), supportEmail: z.string().email().optional(), maintenanceMode: z.boolean().optional(), registrationOpen: z.boolean().optional(), defaultTrialDays: z.number().int().min(0).max(365).optional(), defaultCurrency: z.string().trim().min(3).max(3).optional(), defaultTimezone: z.string().trim().min(1).max(100).optional(), authentication: z.object({ requireEmailOtpVerification: z.boolean().optional() }).optional(), emailTemplates: z.array(z.unknown()).max(100).optional(),
}).refine((v) => Object.keys(v).some((key) => key !== "reason"), { message: "Provide at least one platform setting." });
