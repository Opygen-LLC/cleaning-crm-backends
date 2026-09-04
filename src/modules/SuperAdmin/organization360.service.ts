import status from "http-status";
import AppError from "../../errorHelper/AppError";
import {
  InvoiceStatus,
  LeadStage,
  PaymentStatus,
  RecurringStatus,
  ServiceStatus,
  StaffStatus,
} from "../../generated/prisma/enums";
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import {
  invalidateRuntimeAuth,
} from "../../lib/cache/authRuntimeCache";
import { disconnectTenantSockets, disconnectUserSockets } from "../../config/socketio";
import { revokeAllSessionsForUser } from "../Auth/sessionSecurity.service";
import { FEATURE_CATALOG, FEATURE_KEYS, type FeatureKey } from "../Entitlement/featureCatalog";
import { TenantAccessResolver } from "../Entitlement/tenantAccessResolver.service";
import { TenantEntitlementService } from "./tenantEntitlement.service";
import { writeSuperAdminAudit } from "./superAdminAudit.service";
import redis from "../../config/redis";

const DAY_MS = 86_400_000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const PREVIEW_SIZE = 5;
const AUDIT_CATEGORY_VALUES = [
  "LIFECYCLE",
  "PLAN_CHANGES",
  "TRIAL_CHANGES",
  "ENTITLEMENT_OVERRIDES",
  "OWNER_CHANGES",
  "MANUAL_VERIFICATION",
  "BILLING_INTERVENTIONS",
  "SECURITY",
  "PERMANENT_DELETION",
] as const;

export type OrganizationAuditCategory = (typeof AUDIT_CATEGORY_VALUES)[number];

type ListQuery = Record<string, unknown>;

type OrganizationIdentity = {
  id: string;
  userId: string;
  businessName: string;
};

const pageFrom = (query: ListQuery) => Math.max(1, Number(query.page) || 1);
const limitFrom = (query: ListQuery) => Math.min(MAX_PAGE_SIZE, Math.max(1, Number(query.limit) || DEFAULT_PAGE_SIZE));
const paginationMeta = (page: number, limit: number, total: number) => ({
  page,
  limit,
  total,
  totalPages: Math.ceil(total / limit),
});

const maxDate = (...values: Array<Date | null | undefined>) => {
  const dates = values.filter((value): value is Date => value instanceof Date && Number.isFinite(value.getTime()));
  if (!dates.length) return null;
  return new Date(Math.max(...dates.map((value) => value.getTime())));
};

const accountAgeDays = (createdAt: Date) => Math.max(0, Math.floor((Date.now() - createdAt.getTime()) / DAY_MS));

const limitBreakdown = (input: {
  used: number;
  base: number | null;
  afterPaidExtras: number | null;
  effective: number | null;
  paidExtra: number;
  adminOverride?: { mode: string; value?: number };
}) => ({
  used: input.used,
  base: input.base,
  paidExtra: input.paidExtra,
  afterPaidExtras: input.afterPaidExtras,
  adminOverride: input.adminOverride ?? { mode: "INHERIT" },
  effective: input.effective,
  remaining: input.effective === null ? null : Math.max(0, input.effective - input.used),
  overBy: input.effective === null ? 0 : Math.max(0, input.used - input.effective),
});

const organizationOrThrow = async (organizationId: string): Promise<OrganizationIdentity> => {
  const normalized = String(organizationId ?? "").trim();
  if (!normalized) {
    throw new AppError(status.BAD_REQUEST, "Organization ID is required.", {
      code: "ORGANIZATION_ID_REQUIRED",
      retryable: false,
    });
  }
  const tenant = await prisma.adminProfile.findUnique({
    where: { id: normalized },
    select: { id: true, userId: true, businessName: true },
  });
  if (!tenant) {
    throw new AppError(status.NOT_FOUND, "Organization not found.", {
      code: "ORGANIZATION_NOT_FOUND",
      retryable: false,
    });
  }
  return tenant;
};

const tenantUserIds = async (organizationId: string) => {
  const tenant = await prisma.adminProfile.findUnique({
    where: { id: organizationId },
    select: {
      userId: true,
      staff: { select: { userId: true } },
    },
  });
  if (!tenant) return [] as string[];
  return [tenant.userId, ...tenant.staff.map((row) => row.userId)];
};

const auditActionsForCategory = (category?: string): Prisma.SuperAdminAuditLogWhereInput | null => {
  if (!category) return null;
  const normalized = category.toUpperCase() as OrganizationAuditCategory;
  if (!AUDIT_CATEGORY_VALUES.includes(normalized)) return null;

  const exact = (...actions: string[]): Prisma.SuperAdminAuditLogWhereInput => ({ action: { in: actions } });
  const prefix = (value: string): Prisma.SuperAdminAuditLogWhereInput => ({ action: { startsWith: value } });

  switch (normalized) {
    case "LIFECYCLE":
      return exact("TENANT_SUSPENDED", "TENANT_REACTIVATED", "TENANT_ARCHIVED", "TENANT_RESTORED");
    case "PLAN_CHANGES":
      return {
        OR: [
          prefix("TENANT_PLAN_"),
          prefix("TENANT_DOWNGRADE_"),
          prefix("TENANT_SCHEDULED_PLAN_"),
          prefix("TENANT_CANCELLATION_"),
          exact("SUBSCRIPTION_REQUEST_APPROVED", "SUBSCRIPTION_REQUEST_REJECTED", "SUBSCRIPTION_CANCELLED", "SUBSCRIPTION_SUSPENDED", "SUBSCRIPTION_REACTIVATED"),
        ],
      };
    case "TRIAL_CHANGES":
      return { OR: [prefix("TENANT_TRIAL_"), exact("TRIAL_EXTENDED", "TRIAL_NUDGE_SENT")] };
    case "ENTITLEMENT_OVERRIDES":
      return { OR: [prefix("TENANT_ENTITLEMENTS_"), prefix("TENANT_ENTITLEMENT_")] };
    case "OWNER_CHANGES":
      return exact("TENANT_OWNER_UPDATED");
    case "MANUAL_VERIFICATION":
      return exact("USER_MANUALLY_VERIFIED");
    case "BILLING_INTERVENTIONS":
      return exact("MANUAL_PAYMENT_GRANTED", "BILLING_REFUNDED", "PAYMENT_PROOF_APPROVED", "PAYMENT_PROOF_REJECTED");
    case "SECURITY":
      return exact("TENANT_SESSIONS_REVOKED", "TENANT_OWNER_SESSIONS_REVOKED", "TENANT_SUPPORT_MODE_STARTED", "TENANT_SUPPORT_MODE_ENDED", "USER_STATUS_UPDATED", "USER_ROLE_UPDATED");
    case "PERMANENT_DELETION":
      return { OR: [prefix("TENANT_HARD_DELETE_"), exact("TENANT_HARD_DELETED")] };
    default:
      return null;
  }
};

export const categorizeOrganizationAuditAction = (action: string): OrganizationAuditCategory | "OTHER" => {
  const value = String(action ?? "").toUpperCase();
  if (["TENANT_SUSPENDED", "TENANT_REACTIVATED", "TENANT_ARCHIVED", "TENANT_RESTORED"].includes(value)) return "LIFECYCLE";
  if (value.startsWith("TENANT_TRIAL_") || value === "TRIAL_EXTENDED" || value === "TRIAL_NUDGE_SENT") return "TRIAL_CHANGES";
  if (value.startsWith("TENANT_ENTITLEMENT")) return "ENTITLEMENT_OVERRIDES";
  if (value === "TENANT_OWNER_UPDATED") return "OWNER_CHANGES";
  if (value === "USER_MANUALLY_VERIFIED") return "MANUAL_VERIFICATION";
  if (["MANUAL_PAYMENT_GRANTED", "BILLING_REFUNDED", "PAYMENT_PROOF_APPROVED", "PAYMENT_PROOF_REJECTED"].includes(value)) return "BILLING_INTERVENTIONS";
  if (["TENANT_SESSIONS_REVOKED", "TENANT_OWNER_SESSIONS_REVOKED", "TENANT_SUPPORT_MODE_STARTED", "TENANT_SUPPORT_MODE_ENDED", "USER_STATUS_UPDATED", "USER_ROLE_UPDATED"].includes(value)) return "SECURITY";
  if (value.includes("HARD_DELETE") || value === "TENANT_HARD_DELETED") return "PERMANENT_DELETION";
  if (
    value.startsWith("TENANT_PLAN_") ||
    value.startsWith("TENANT_DOWNGRADE_") ||
    value.startsWith("TENANT_SCHEDULED_PLAN_") ||
    value.startsWith("TENANT_CANCELLATION_") ||
    value.startsWith("SUBSCRIPTION_REQUEST_") ||
    value.startsWith("SUBSCRIPTION_")
  ) return "PLAN_CHANGES";
  return "OTHER";
};

const mapAuditRows = async <T extends { targetUserId: string | null; action: string }>(rows: T[]) => {
  const targetIds = [...new Set(rows.map((row) => row.targetUserId).filter((value): value is string => Boolean(value)))];
  const targets = targetIds.length
    ? await prisma.user.findMany({ where: { id: { in: targetIds } }, select: { id: true, name: true, email: true } })
    : [];
  const targetMap = new Map(targets.map((row) => [row.id, row]));
  return rows.map((row) => ({
    ...row,
    category: categorizeOrganizationAuditAction(row.action),
    targetUser: row.targetUserId ? targetMap.get(row.targetUserId) ?? null : null,
  }));
};

const sessionState = (expiresAt: Date, now = new Date()) => expiresAt > now ? "ACTIVE" : "EXPIRED";

const mapSessions = <T extends {
  id: string;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
  ipAddress: string | null;
  userAgent: string | null;
  user: { id: string; name: string; email: string; role: string; status: string };
}>(rows: T[]) => rows.map((session) => ({
  id: session.id,
  user: session.user,
  ipAddress: session.ipAddress,
  userAgent: session.userAgent,
  createdAt: session.createdAt,
  lastUsedAt: session.lastUsedAt ?? session.updatedAt,
  expiresAt: session.expiresAt,
  state: sessionState(session.expiresAt),
}));

const domainIssues = (domains: Array<{
  id: string;
  domain: string;
  status: string;
  ownershipVerified: boolean;
  providerVerified: boolean;
  routingVerified: boolean;
  tlsStatus: string;
  failureReason: string | null;
  provider: string;
}>) => domains.flatMap((domain) => {
  const issues: Array<{ code: string; severity: "INFO" | "WARNING" | "ERROR"; domain: string; message: string }> = [];
  if (!domain.ownershipVerified) issues.push({ code: "DNS_NOT_VERIFIED", severity: domain.status === "FAILED" ? "ERROR" : "WARNING", domain: domain.domain, message: "Domain ownership/DNS verification is incomplete." });
  if (!domain.providerVerified) issues.push({ code: "PROVIDER_NOT_VERIFIED", severity: domain.status === "FAILED" ? "ERROR" : "WARNING", domain: domain.domain, message: "Domain provider verification is incomplete." });
  if (!domain.routingVerified) issues.push({ code: "ROUTING_NOT_VERIFIED", severity: domain.status === "FAILED" ? "ERROR" : "WARNING", domain: domain.domain, message: "Domain routing is not verified." });
  if (!["READY", "EXTERNAL"].includes(domain.tlsStatus)) issues.push({ code: domain.tlsStatus === "ERROR" ? "TLS_FAILED" : "TLS_PENDING", severity: domain.tlsStatus === "ERROR" ? "ERROR" : "WARNING", domain: domain.domain, message: `TLS status is ${domain.tlsStatus}.` });
  if (domain.failureReason) issues.push({ code: "PROVIDER_FAILURE", severity: "ERROR", domain: domain.domain, message: domain.failureReason });
  return issues;
});

const featureBreakdown = (access: Awaited<ReturnType<typeof TenantAccessResolver.resolve>>) =>
  FEATURE_KEYS.map((key: FeatureKey) => ({
    key,
    label: FEATURE_CATALOG[key].label,
    planIncluded: access.baseEntitlements[key] === true,
    override: access.tenantOverrides.features[key] ?? "INHERIT",
    effective: access.effectiveEntitlements[key] === true,
  }));

export const getOrganization360 = async (organizationId: string) => {
  const cacheKey = `super-admin:org-360:${organizationId}`;
  const cached = await redis.get(cacheKey).catch(() => null);
  if (cached) {
    try {
      return JSON.parse(cached);
    } catch {
      // rebuild on error
    }
  }

  const identity = await organizationOrThrow(organizationId);
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [tenant, access, configuredEntitlementOverride] = await Promise.all([
    prisma.adminProfile.findUniqueOrThrow({
      where: { id: identity.id },
      select: {
        id: true,
        userId: true,
        businessName: true,
        businessEmail: true,
        businessLogo: true,
        mobileNumber: true,
        businessType: true,
        country: true,
        currency: true,
        address: true,
        city: true,
        zipcode: true,
        website: true,
        createdAt: true,
        updatedAt: true,
        lifecycleStatus: true,
        suspendedAt: true,
        suspendedReason: true,
        archivedAt: true,
        archivedReason: true,
        restoredAt: true,
        restoredReason: true,
        deletionStartedAt: true,
        deletionReason: true,
        deletionAttemptCount: true,
        deletionLastAttemptAt: true,
        deletionLastError: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            emailVerified: true,
            image: true,
            role: true,
            status: true,
            createdAt: true,
            updatedAt: true,
          },
        },
        businessWebsite: {
          select: {
            id: true,
            status: true,
            subdomain: true,
            templateId: true,
            templateVersion: true,
            publishedAt: true,
            createdAt: true,
            updatedAt: true,
            domains: {
              select: {
                id: true,
                domain: true,
                status: true,
                isPrimary: true,
                ownershipVerified: true,
                providerVerified: true,
                routingVerified: true,
                tlsStatus: true,
                provider: true,
                failureReason: true,
                lastCheckedAt: true,
                verifiedAt: true,
                lastProviderSyncAt: true,
                createdAt: true,
                updatedAt: true,
              },
              orderBy: [{ isPrimary: "desc" }, { createdAt: "desc" }],
            },
          },
        },
        subscription: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: {
            id: true,
            status: true,
            isTrial: true,
            trialEndsAt: true,
            currentPeriodStart: true,
            currentPeriodEnd: true,
            cancelAtPeriodEnd: true,
            canceledAt: true,
            extraStaff: true,
            extraClient: true,
            extraBookingsPerMonth: true,
            totalCost: true,
            createdAt: true,
            updatedAt: true,
            subscriptionPlan: { select: { id: true, name: true, description: true, currency: true, features: true } },
            plan: { select: { id: true, interval: true, price: true, maxStaff: true, maxClient: true, maxBookingsPerMonth: true } },
            pendingPlanChanges: {
              where: { status: { in: ["AWAITING_PAYMENT", "UNDER_REVIEW", "APPROVED"] } },
              orderBy: { createdAt: "desc" },
              take: 1,
              select: { id: true, status: true, applyAt: true, quotedAmount: true, currency: true, isAdministrative: true, reason: true, createdAt: true, targetPlan: { select: { id: true, interval: true, price: true, subscriptionPlan: { select: { id: true, name: true } } } } },
            },
          },
        },
        _count: {
          select: {
            staff: true,
            clients: true,
            serviceCatalogs: true,
            leads: true,
            jobs: true,
            bookings: true,
            recurringSchedules: true,
            quotes: true,
            estimates: true,
            invoices: true,
            payment: true,
            expenses: true,
            reviews: true,
            websiteSubmissions: true,
            notifications: true,
          },
        },
      },
    }),
    TenantAccessResolver.resolve(identity.id),
    TenantEntitlementService.getTenantEntitlementOverride(identity.id),
  ]);

  const staffUserIdsPromise = prisma.staffProfile.findMany({ where: { adminId: identity.id }, select: { userId: true } });
  const [
    jobsThisMonth,
    bookingsThisMonth,
    activeRecurringSchedules,
    outstandingInvoices,
    outstandingInvoiceAmount,
    openLeads,
    publishedServices,
    activeStaff,
    ownerLastSession,
    recentTeam,
    latestActivity,
    recentAuditRaw,
    recentBilling,
    staffUserRows,
    billingCount,
    paidBillingAggregate,
    pendingBillingCount,
    storageBytesAggregate,
  ] = await Promise.all([
    prisma.job.count({ where: { adminId: identity.id, createdAt: { gte: monthStart } } }),
    prisma.booking.count({ where: { adminId: identity.id, createdAt: { gte: monthStart } } }),
    prisma.recurringSchedule.count({ where: { adminId: identity.id, status: RecurringStatus.ACTIVE } }),
    prisma.invoice.count({ where: { adminId: identity.id, status: { in: [InvoiceStatus.SENT, InvoiceStatus.OVERDUE] } } }),
    prisma.invoice.aggregate({ where: { adminId: identity.id, status: { in: [InvoiceStatus.SENT, InvoiceStatus.OVERDUE] } }, _sum: { total: true } }),
    prisma.lead.count({ where: { adminId: identity.id, stage: { in: [LeadStage.NEW, LeadStage.CONTACTED, LeadStage.QUOTE_SENT] } } }),
    prisma.serviceCatalog.count({ where: { adminId: identity.id, status: ServiceStatus.ACTIVE } }),
    prisma.staffProfile.count({ where: { adminId: identity.id, status: "ACTIVE", manuallyInactive: false, user: { status: "ACTIVE" } } }),
    prisma.session.findFirst({ where: { userId: identity.userId }, orderBy: [{ lastUsedAt: "desc" }, { updatedAt: "desc" }], select: { id: true, expiresAt: true, createdAt: true, updatedAt: true, lastUsedAt: true, ipAddress: true, userAgent: true, user: { select: { id: true, name: true, email: true, role: true, status: true } } } }),
    prisma.staffProfile.findMany({ where: { adminId: identity.id }, orderBy: { createdAt: "desc" }, take: PREVIEW_SIZE, select: { id: true, userId: true, staffRole: true, status: true, manuallyInactive: true, createdAt: true, updatedAt: true, user: { select: { id: true, name: true, email: true, emailVerified: true, status: true, createdAt: true, updatedAt: true } } } }),
    prisma.activityLog.findFirst({ where: { adminId: identity.id }, orderBy: { createdAt: "desc" }, select: { createdAt: true } }),
    prisma.superAdminAuditLog.findMany({ where: { tenantAdminId: identity.id }, orderBy: { createdAt: "desc" }, take: PREVIEW_SIZE, include: { actor: { select: { id: true, name: true, email: true } } } }),
    prisma.billingHistory.findMany({ where: { subscription: { adminId: identity.id } }, orderBy: { createdAt: "desc" }, take: PREVIEW_SIZE, select: { id: true, amount: true, currency: true, method: true, status: true, note: true, transactionId: true, paymentProofUrl: true, paidAt: true, createdAt: true, subscriptionId: true, planChangeId: true } }),
    staffUserIdsPromise,
    prisma.billingHistory.count({ where: { subscription: { adminId: identity.id } } }),
    prisma.billingHistory.aggregate({ where: { subscription: { adminId: identity.id }, status: PaymentStatus.PAID }, _sum: { amount: true } }),
    prisma.billingHistory.count({ where: { subscription: { adminId: identity.id }, status: PaymentStatus.PENDING, paymentProofUrl: { not: null } } }),
    tenant.businessWebsite
      ? prisma.websiteAsset.aggregate({ where: { websiteId: tenant.businessWebsite.id }, _sum: { bytes: true } })
      : Promise.resolve({ _sum: { bytes: null as number | null } }),
  ]);

  const sessionUserIds = [identity.userId, ...staffUserRows.map((row) => row.userId)];
  const recentSessions = sessionUserIds.length
    ? await prisma.session.findMany({
        where: { userId: { in: sessionUserIds } },
        orderBy: [{ lastUsedAt: "desc" }, { updatedAt: "desc" }],
        take: PREVIEW_SIZE,
        select: { id: true, expiresAt: true, createdAt: true, updatedAt: true, lastUsedAt: true, ipAddress: true, userAgent: true, user: { select: { id: true, name: true, email: true, role: true, status: true } } },
      })
    : [];

  const recentAudit = await mapAuditRows(recentAuditRaw);
  const subscription = tenant.subscription[0] ?? null;
  const pendingPlanChange = subscription?.pendingPlanChanges[0] ?? null;
  const domains = tenant.businessWebsite?.domains ?? [];
  const primaryDomain = domains.find((domain) => domain.isPrimary) ?? null;
  const domainHealthIssues = domainIssues(domains);
  const latestActivityAt = latestActivity?.createdAt ?? null;
  const latestAuditAt = recentAuditRaw[0]?.createdAt ?? null;
  const lastActivityAt = maxDate(ownerLastSession?.lastUsedAt ?? ownerLastSession?.updatedAt, latestActivityAt, latestAuditAt, tenant.updatedAt);
  const resourceOverrides = access.tenantOverrides.resources;

  const storageUsedMb = Math.ceil(((storageBytesAggregate._sum.bytes ?? 0) / (1024 * 1024)) * 100) / 100;

  const resourceLimits = {
    staff: limitBreakdown({ used: tenant._count.staff, base: access.resourceLimits.base.staff, paidExtra: access.paidExtras.staff, afterPaidExtras: access.resourceLimits.afterPaidExtras.staff, adminOverride: resourceOverrides.staff, effective: access.resourceLimits.effective.staff }),
    clients: limitBreakdown({ used: tenant._count.clients, base: access.resourceLimits.base.clients, paidExtra: access.paidExtras.clients, afterPaidExtras: access.resourceLimits.afterPaidExtras.clients, adminOverride: resourceOverrides.clients, effective: access.resourceLimits.effective.clients }),
    monthlyBookings: limitBreakdown({ used: bookingsThisMonth, base: access.resourceLimits.base.monthlyBookings, paidExtra: access.paidExtras.monthlyBookings, afterPaidExtras: access.resourceLimits.afterPaidExtras.monthlyBookings, adminOverride: resourceOverrides.monthlyBookings, effective: access.resourceLimits.effective.monthlyBookings }),
    storageMb: limitBreakdown({ used: storageUsedMb, base: access.resourceLimits.base.storageMb, paidExtra: access.paidExtras.storageMb, afterPaidExtras: access.resourceLimits.afterPaidExtras.storageMb, adminOverride: resourceOverrides.storageMb, effective: access.resourceLimits.effective.storageMb }),
  };

  const healthIssues: Array<{ code: string; severity: "INFO" | "WARNING" | "ERROR"; message: string; details?: unknown }> = [];
  if (access.access.deniedReason !== "ACTIVE") healthIssues.push({ code: access.access.deniedReason, severity: "ERROR", message: "Organization workspace access is blocked by the canonical tenant access policy." });
  if (tenant.lifecycleStatus === "PENDING_DELETION") healthIssues.push({ code: "PENDING_DELETION", severity: "ERROR", message: tenant.deletionLastError ? `Permanent deletion is pending retry: ${tenant.deletionLastError}` : "Permanent deletion is currently in progress or awaiting retry." });
  if (!tenant.user.emailVerified) healthIssues.push({ code: "OWNER_EMAIL_UNVERIFIED", severity: "WARNING", message: "Organization owner email is not verified." });
  if (!subscription) healthIssues.push({ code: "SUBSCRIPTION_MISSING", severity: "ERROR", message: "Organization has no subscription record." });
  if (!tenant.businessWebsite) healthIssues.push({ code: "WEBSITE_MISSING", severity: "WARNING", message: "Organization does not have a provisioned website." });
  else if (tenant.businessWebsite.status !== "PUBLISHED") healthIssues.push({ code: "WEBSITE_UNPUBLISHED", severity: "WARNING", message: `Website status is ${tenant.businessWebsite.status}.` });
  domainHealthIssues.forEach((issue) => healthIssues.push({ code: issue.code, severity: issue.severity, message: `${issue.domain}: ${issue.message}` }));
  for (const [resource, value] of Object.entries(resourceLimits)) {
    if (value.overBy > 0) healthIssues.push({ code: "RESOURCE_LIMIT_EXCEEDED", severity: "WARNING", message: `${resource} usage exceeds the effective limit by ${value.overBy}.`, details: { resource, ...value } });
  }

  const healthStatus = healthIssues.some((issue) => issue.severity === "ERROR")
    ? "CRITICAL"
    : healthIssues.some((issue) => issue.severity === "WARNING")
      ? "ATTENTION"
      : "HEALTHY";

  const result = {
    overview: {
      organizationId: tenant.id,
      ownerUserId: tenant.userId,
      businessName: tenant.businessName,
      businessEmail: tenant.businessEmail,
      phone: tenant.mobileNumber,
      businessType: tenant.businessType,
      country: tenant.country,
      currency: tenant.currency,
      address: tenant.address,
      city: tenant.city,
      zipcode: tenant.zipcode,
      externalWebsite: tenant.website,
      createdAt: tenant.createdAt,
      updatedAt: tenant.updatedAt,
      accountAgeDays: accountAgeDays(tenant.createdAt),
      lifecycleStatus: tenant.lifecycleStatus,
      deletion: {
        pending: tenant.lifecycleStatus === "PENDING_DELETION",
        startedAt: tenant.deletionStartedAt,
        reason: tenant.deletionReason,
        attemptCount: tenant.deletionAttemptCount,
        lastAttemptAt: tenant.deletionLastAttemptAt,
        lastError: tenant.deletionLastError,
        retryable: tenant.lifecycleStatus === "PENDING_DELETION",
      },
      ownerAccountStatus: tenant.user.status,
      ownerVerified: tenant.user.emailVerified,
      currentPlan: subscription?.subscriptionPlan.name ?? null,
      currentPlanId: subscription?.subscriptionPlan.id ?? null,
      subscriptionStatus: subscription?.status ?? null,
      isTrial: subscription?.isTrial ?? false,
      websiteStatus: tenant.businessWebsite?.status ?? null,
      lastActivityAt,
    },
    effectiveAccess: {
      workspace: { allowed: access.access.dashboardAllowed, reason: access.access.deniedReason },
      publicWebsite: { allowed: access.access.publicWebsiteAllowed, reason: access.website.deniedReason },
      publicBooking: { allowed: access.access.publicWritesAllowed && access.effectiveEntitlements.online_booking, reason: !access.access.publicWritesAllowed ? access.access.deniedReason : access.effectiveEntitlements.online_booking ? "ACTIVE" : "FEATURE_NOT_INCLUDED" },
      workersAutomation: { allowed: access.access.backgroundJobsAllowed, reason: access.access.deniedReason },
      recovery: { allowed: access.access.recoveryAllowed, reason: access.access.deniedReason },
      canonical: access,
    },
    ownerAndTeam: {
      owner: {
        ...tenant.user,
        lastLoginAt: ownerLastSession?.lastUsedAt ?? ownerLastSession?.updatedAt ?? null,
      },
      summary: {
        staffUsed: tenant._count.staff,
        staffActive: activeStaff,
        staffLimit: access.resourceLimits.effective.staff,
        remaining: access.resourceLimits.effective.staff === null ? null : Math.max(0, access.resourceLimits.effective.staff - tenant._count.staff),
        pendingInvitations: 0,
        reservedSeats: 0,
        invitationSupport: false,
      },
      preview: recentTeam,
    },
    subscriptionAndEntitlements: {
      subscription: subscription ? {
        id: subscription.id,
        status: subscription.status,
        isTrial: subscription.isTrial,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        canceledAt: subscription.canceledAt,
        totalCost: subscription.totalCost,
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
      } : null,
      plan: subscription ? {
        id: subscription.subscriptionPlan.id,
        name: subscription.subscriptionPlan.name,
        description: subscription.subscriptionPlan.description,
        currency: subscription.subscriptionPlan.currency,
        pricingId: subscription.plan.id,
        interval: subscription.plan.interval,
        price: subscription.plan.price,
      } : null,
      pendingPlanChange,
      limits: resourceLimits,
      paidExtras: access.paidExtras,
      tenantOverride: configuredEntitlementOverride,
      features: featureBreakdown(access),
    },
    billing: {
      summary: {
        records: billingCount,
        totalPaid: paidBillingAggregate._sum.amount ?? null,
        pendingProofs: pendingBillingCount,
        currency: subscription?.subscriptionPlan.currency ?? tenant.currency,
      },
      preview: recentBilling,
    },
    cleaningOperations: {
      totals: {
        staff: tenant._count.staff,
        clients: tenant._count.clients,
        services: tenant._count.serviceCatalogs,
        leads: tenant._count.leads,
        jobs: tenant._count.jobs,
        bookings: tenant._count.bookings,
        recurringSchedules: tenant._count.recurringSchedules,
        quotes: tenant._count.quotes,
        estimates: tenant._count.estimates,
        invoices: tenant._count.invoices,
        payments: tenant._count.payment,
        expenses: tenant._count.expenses,
        reviews: tenant._count.reviews,
        websiteSubmissions: tenant._count.websiteSubmissions,
        notifications: tenant._count.notifications,
      },
      snapshot: {
        jobsThisMonth,
        bookingsThisMonth,
        activeRecurringSchedules,
        outstandingInvoices,
        outstandingInvoiceAmount: outstandingInvoiceAmount._sum.total ?? null,
        openLeads,
        publishedServices,
      },
    },
    websiteAndDomain: {
      website: tenant.businessWebsite ? {
        id: tenant.businessWebsite.id,
        status: tenant.businessWebsite.status,
        subdomain: tenant.businessWebsite.subdomain,
        templateId: tenant.businessWebsite.templateId,
        templateVersion: tenant.businessWebsite.templateVersion,
        publishedAt: tenant.businessWebsite.publishedAt,
        createdAt: tenant.businessWebsite.createdAt,
        updatedAt: tenant.businessWebsite.updatedAt,
      } : null,
      primaryDomain,
      domains,
      failures: domainHealthIssues,
    },
    securityAndSessions: {
      ownerLastLoginAt: ownerLastSession?.lastUsedAt ?? ownerLastSession?.updatedAt ?? null,
      persistedSessionHistorySupportsRevokedState: false,
      ownerLastLoginSource: "SESSION_HISTORY",
      ownerLastLoginMayResetAfterRevocation: true,
      preview: mapSessions(recentSessions),
    },
    audit: {
      categories: AUDIT_CATEGORY_VALUES,
      preview: recentAudit,
    },
    usage: {
      resources: resourceLimits,
      bookingsThisMonth,
    },
    health: {
      status: healthStatus,
      issueCount: healthIssues.length,
      issues: healthIssues,
      checkedAt: new Date(),
    },
  };

  void redis.setex(cacheKey, 30, JSON.stringify(result)).catch(() => {});
  return result;
};

export const invalidateOrganization360Cache = (organizationId: string): void => {
  if (!organizationId) return;
  void redis.del(`super-admin:org-360:${organizationId}`).catch(() => {});
};

export const getOrganizationTeam = async (organizationId: string, query: ListQuery) => {
  const identity = await organizationOrThrow(organizationId);
  const page = pageFrom(query);
  const limit = limitFrom(query);
  const search = String(query.search ?? "").trim();
  const where: Prisma.StaffProfileWhereInput = {
    adminId: identity.id,
    ...(query.status ? { status: String(query.status) as StaffStatus } : {}),
    ...(search ? {
      OR: [
        { staffRole: { contains: search, mode: "insensitive" } },
        { user: { name: { contains: search, mode: "insensitive" } } },
        { user: { email: { contains: search, mode: "insensitive" } } },
      ],
    } : {}),
  };
  const accessPromise = TenantAccessResolver.resolve(identity.id);
  const [total, rows, access, active] = await Promise.all([
    prisma.staffProfile.count({ where }),
    prisma.staffProfile.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" }, select: { id: true, userId: true, staffRole: true, status: true, manuallyInactive: true, mobileNumber: true, createdAt: true, updatedAt: true, user: { select: { id: true, name: true, email: true, emailVerified: true, status: true, createdAt: true, updatedAt: true } } } }),
    accessPromise,
    prisma.staffProfile.count({ where: { adminId: identity.id, status: "ACTIVE", manuallyInactive: false, user: { status: "ACTIVE" } } }),
  ]);
  const used = await prisma.staffProfile.count({ where: { adminId: identity.id } });
  const effectiveLimit = access.resourceLimits.effective.staff;
  return {
    owner: await prisma.user.findUnique({ where: { id: identity.userId }, select: { id: true, name: true, email: true, emailVerified: true, status: true, createdAt: true, updatedAt: true } }),
    summary: { staffUsed: used, staffActive: active, staffLimit: effectiveLimit, remaining: effectiveLimit === null ? null : Math.max(0, effectiveLimit - used), pendingInvitations: 0, reservedSeats: 0, invitationSupport: false },
    data: rows,
    meta: paginationMeta(page, limit, total),
  };
};

export const getOrganizationAudit = async (organizationId: string, query: ListQuery) => {
  const identity = await organizationOrThrow(organizationId);
  const page = pageFrom(query);
  const limit = limitFrom(query);
  const categoryWhere = auditActionsForCategory(query.category ? String(query.category) : undefined);
  const search = String(query.search ?? "").trim();
  const filters: Prisma.SuperAdminAuditLogWhereInput[] = [];
  if (categoryWhere) filters.push(categoryWhere);
  if (search) filters.push({ OR: [{ action: { contains: search, mode: "insensitive" } }, { reason: { contains: search, mode: "insensitive" } }, { actor: { is: { name: { contains: search, mode: "insensitive" } } } }, { actor: { is: { email: { contains: search, mode: "insensitive" } } } }] });
  const where: Prisma.SuperAdminAuditLogWhereInput = {
    tenantAdminId: identity.id,
    ...(filters.length ? { AND: filters } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.superAdminAuditLog.count({ where }),
    prisma.superAdminAuditLog.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" }, include: { actor: { select: { id: true, name: true, email: true } } } }),
  ]);
  return { data: await mapAuditRows(rows), meta: paginationMeta(page, limit, total), categories: AUDIT_CATEGORY_VALUES };
};

export const getOrganizationBilling = async (organizationId: string, query: ListQuery) => {
  const identity = await organizationOrThrow(organizationId);
  const page = pageFrom(query);
  const limit = limitFrom(query);
  const where: Prisma.BillingHistoryWhereInput = {
    subscription: { adminId: identity.id },
    ...(query.status ? { status: String(query.status) as PaymentStatus } : {}),
  };
  const [total, rows, paid, pendingProofs] = await Promise.all([
    prisma.billingHistory.count({ where }),
    prisma.billingHistory.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" }, include: { subscription: { select: { id: true, status: true, isTrial: true, subscriptionPlan: { select: { id: true, name: true, currency: true } }, plan: { select: { id: true, interval: true } } } }, pendingPlanChange: { select: { id: true, status: true, isAdministrative: true, targetPlan: { select: { id: true, subscriptionPlan: { select: { id: true, name: true } } } } } } } }),
    prisma.billingHistory.aggregate({ where: { subscription: { adminId: identity.id }, status: PaymentStatus.PAID }, _sum: { amount: true } }),
    prisma.billingHistory.count({ where: { subscription: { adminId: identity.id }, status: PaymentStatus.PENDING, paymentProofUrl: { not: null } } }),
  ]);
  return { summary: { records: total, totalPaid: paid._sum.amount ?? null, pendingProofs }, data: rows, meta: paginationMeta(page, limit, total) };
};

export const getOrganizationActivity = async (organizationId: string, query: ListQuery) => {
  const identity = await organizationOrThrow(organizationId);
  const page = pageFrom(query);
  const limit = limitFrom(query);
  const search = String(query.search ?? "").trim();
  const where: Prisma.ActivityLogWhereInput = {
    adminId: identity.id,
    ...(query.action ? { action: String(query.action) } : {}),
    ...(query.entityType ? { entityType: String(query.entityType) } : {}),
    ...(search ? { OR: [{ action: { contains: search, mode: "insensitive" } }, { entityType: { contains: search, mode: "insensitive" } }, { description: { contains: search, mode: "insensitive" } }] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.activityLog.count({ where }),
    prisma.activityLog.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" } }),
  ]);
  return { data: rows, meta: paginationMeta(page, limit, total) };
};

export const getOrganizationSessions = async (organizationId: string, query: ListQuery) => {
  const identity = await organizationOrThrow(organizationId);
  const page = pageFrom(query);
  const limit = limitFrom(query);
  const userIds = await tenantUserIds(identity.id);
  if (!userIds.length) return { data: [], meta: paginationMeta(page, limit, 0), persistedSessionHistorySupportsRevokedState: false };
  const activeOnly = String(query.activeOnly ?? "false") === "true";
  const now = new Date();
  const where: Prisma.SessionWhereInput = { userId: { in: userIds }, ...(activeOnly ? { expiresAt: { gt: now } } : {}) };
  const [total, rows] = await Promise.all([
    prisma.session.count({ where }),
    prisma.session.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: [{ lastUsedAt: "desc" }, { updatedAt: "desc" }], select: { id: true, expiresAt: true, createdAt: true, updatedAt: true, lastUsedAt: true, ipAddress: true, userAgent: true, user: { select: { id: true, name: true, email: true, role: true, status: true } } } }),
  ]);
  return { data: mapSessions(rows), meta: paginationMeta(page, limit, total), persistedSessionHistorySupportsRevokedState: false };
};

export const revokeOwnerOrganizationSessions = async (organizationId: string, context: { actorUserId: string; reason: string; ipAddress?: string | null; userAgent?: string | null }) => {
  const identity = await organizationOrThrow(organizationId);
  const normalizedReason = String(context.reason ?? "").trim();
  if (normalizedReason.length < 10) {
    throw new AppError(status.BAD_REQUEST, "reason must be at least 10 characters.", { code: "REASON_REQUIRED", retryable: false });
  }
  const revokedCount = await revokeAllSessionsForUser(identity.userId);
  invalidateRuntimeAuth(identity.userId);
  await disconnectUserSockets(identity.userId);
  await writeSuperAdminAudit({
    actorUserId: context.actorUserId,
    tenantAdminId: identity.id,
    targetUserId: identity.userId,
    action: "TENANT_OWNER_SESSIONS_REVOKED",
    reason: normalizedReason,
    metadata: { revokedCount },
    before: { activeSessionRevocationRequested: false },
    after: { activeSessionRevocationRequested: true, revokedCount },
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
  });
  return { organizationId: identity.id, ownerUserId: identity.userId, revokedCount, affectedUsers: 1, revokedAt: new Date() };
};

export const revokeAllOrganizationSessions = async (organizationId: string, context: { actorUserId: string; reason: string; ipAddress?: string | null; userAgent?: string | null }) => {
  const identity = await organizationOrThrow(organizationId);
  const normalizedReason = String(context.reason ?? "").trim();
  if (normalizedReason.length < 10) {
    throw new AppError(status.BAD_REQUEST, "reason must be at least 10 characters.", { code: "REASON_REQUIRED", retryable: false });
  }
  const userIds = await tenantUserIds(identity.id);
  const counts = await Promise.all(userIds.map((userId) => revokeAllSessionsForUser(userId)));
  userIds.forEach(invalidateRuntimeAuth);
  await disconnectTenantSockets(identity.id);
  const revokedCount = counts.reduce((sum, count) => sum + count, 0);
  await writeSuperAdminAudit({
    actorUserId: context.actorUserId,
    tenantAdminId: identity.id,
    targetUserId: identity.userId,
    action: "TENANT_SESSIONS_REVOKED",
    reason: normalizedReason,
    metadata: { revokedCount, affectedUsers: userIds.length },
    before: { activeSessionRevocationRequested: false },
    after: { activeSessionRevocationRequested: true, revokedCount, affectedUsers: userIds.length },
    ipAddress: context.ipAddress ?? null,
    userAgent: context.userAgent ?? null,
  });
  return { organizationId: identity.id, revokedCount, affectedUsers: userIds.length, revokedAt: new Date() };
};

export const Organization360Service = {
  getOrganization360,
  invalidateOrganization360Cache,
  getOrganizationTeam,
  getOrganizationAudit,
  getOrganizationBilling,
  getOrganizationActivity,
  getOrganizationSessions,
  revokeOwnerOrganizationSessions,
  revokeAllOrganizationSessions,
};
