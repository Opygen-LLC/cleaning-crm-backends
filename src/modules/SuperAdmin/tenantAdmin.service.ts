import status from "http-status";
import { addDays, addMonths, addYears } from "date-fns";
import AppError from "../../errorHelper/AppError";
import {
  AccountStatus,
  Country,
  PendingPlanChangeStatus,
  SubscriptionName,
  SubscriptionPlanInterval,
  SubscriptionStatus,
  TenantLifecycleStatus,
  UserRole,
  NotificationType,
} from "../../generated/prisma/enums";
import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../lib/prisma/prisma";
import { revokeAllSessionsForUser } from "../Auth/sessionSecurity.service";
import {
  invalidateRuntimeAuth,
  invalidateRuntimeSubscriptionForAdmin,
  invalidateRuntimeTenantOwnerStatus,
} from "../../lib/cache/authRuntimeCache";
import { invalidateSubscriptionAccessCache } from "../../middlewares/checkSubscription";
import { invalidatePrivateResponseCacheForUser } from "../../middlewares/privateResponseCache";
import { createNotification } from "../../lib/utils/createNotification";
import { WebsiteProjectionCacheService } from "../Website/websiteProjectionCache.service";
import { WebsiteHostResolverService } from "../Website/websiteHostResolver.service";
import { deleteFileFromCloudinary } from "../../config/cloudinary";
import { disconnectTenantSockets } from "../../config/socketio";
import { writeSuperAdminAudit } from "./superAdminAudit.service";
import { TenantEntitlementService } from "./tenantEntitlement.service";
import { TenantAccessResolver } from "../Entitlement/tenantAccessResolver.service";
import { getPlatformConfig } from "../../lib/utils/platformConfig";
import { superAdminService } from "./superAdmin.service";
import { Organization360Service } from "./organization360.service";

const TENANT_REASON_MIN = 10;
const HARD_DELETE_TEXT = "DELETE PERMANENTLY";

type Db = Prisma.TransactionClient | typeof prisma;

type TenantMutationContext = {
  actorUserId: string;
  reason: string;
  ipAddress?: string | null;
  userAgent?: string | null;
};

const PENDING_DELETION = "PENDING_DELETION" as TenantLifecycleStatus;

const auditHttpContext = (context: Pick<TenantMutationContext, "ipAddress" | "userAgent">) => ({
  ipAddress: context.ipAddress ?? null,
  userAgent: context.userAgent ?? null,
});

const assertTenantMutable = (tenant: { lifecycleStatus: TenantLifecycleStatus }) => {
  if (tenant.lifecycleStatus === PENDING_DELETION) {
    throw new AppError(status.CONFLICT, "This organization is pending permanent deletion. Retry or complete deletion before making other changes.", {
      code: "TENANT_PENDING_DELETION",
      retryable: false,
    });
  }
};

const normalizedReason = (reason: string) => {
  const value = String(reason ?? "").trim();
  if (value.length < TENANT_REASON_MIN) {
    throw new AppError(status.BAD_REQUEST, `reason must be at least ${TENANT_REASON_MIN} characters.`);
  }
  return value;
};

export const resolveTenant = async (organizationId: string, db: Db = prisma) => {
  const tenant = await db.adminProfile.findUnique({
    where: { id: organizationId },
    select: {
      id: true,
      userId: true,
      businessName: true,
      lifecycleStatus: true,
      suspendedAt: true,
      suspendedReason: true,
      reactivatedAt: true,
      preArchiveLifecycleStatus: true,
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
          status: true,
          role: true,
          image: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!tenant) throw new AppError(status.NOT_FOUND, "Organization not found.", { code: "ORGANIZATION_NOT_FOUND", retryable: false });
  return tenant;
};

/** Explicit compatibility resolver for legacy owner-user-id endpoints only. */
export const resolveOrganizationIdByOwnerUserId = async (ownerUserId: string, db: Db = prisma) => {
  const tenant = await db.adminProfile.findUnique({ where: { userId: ownerUserId }, select: { id: true } });
  if (!tenant) throw new AppError(status.NOT_FOUND, "Organization not found.", { code: "ORGANIZATION_NOT_FOUND", retryable: false });
  return tenant.id;
};

const invalidateTenantCaches = async (tenant: { id: string; userId: string }) => {
  invalidateRuntimeAuth(tenant.userId);
  invalidateRuntimeTenantOwnerStatus(tenant.id);
  Organization360Service.invalidateOrganization360Cache(tenant.id);
  await Promise.all([
    invalidateRuntimeSubscriptionForAdmin(tenant.id),
    invalidateSubscriptionAccessCache(tenant.userId).catch(() => undefined),
    invalidatePrivateResponseCacheForUser(tenant.userId).catch(() => undefined),
    WebsiteProjectionCacheService.invalidateAdminWebsite(tenant.id).catch(() => undefined),
    TenantAccessResolver.invalidate(tenant.id).catch(() => undefined),
    createNotification({
      adminId: tenant.id,
      type: NotificationType.SUBSCRIPTION,
      title: "Subscription entitlements updated",
      message: "Your subscription entitlements and features have been updated by administration.",
      relatedId: tenant.id,
    }).catch(() => undefined),
  ]);

  const website = await prisma.businessWebsite.findUnique({
    where: { adminId: tenant.id },
    select: {
      subdomain: true,
      subdomainAliases: { select: { subdomain: true } },
      domains: { select: { domain: true } },
    },
  }).catch(() => null);
  if (website) {
    await Promise.all([
      WebsiteHostResolverService.invalidateSubdomains([
        website.subdomain,
        ...website.subdomainAliases.map((item) => item.subdomain),
      ]).catch(() => undefined),
      WebsiteHostResolverService.invalidateHosts(website.domains.map((item) => item.domain)).catch(() => undefined),
    ]);
  }
};

const tenantUserIds = async (adminId: string) => {
  const tenant = await prisma.adminProfile.findUnique({
    where: { id: adminId },
    select: { userId: true, staff: { select: { userId: true } } },
  });
  if (!tenant) return [] as string[];
  return [tenant.userId, ...tenant.staff.map((staff) => staff.userId)];
};

const revokeTenantSessions = async (adminId: string) => {
  const ids = await tenantUserIds(adminId);
  await Promise.all(ids.map((userId) => revokeAllSessionsForUser(userId)));
  ids.forEach(invalidateRuntimeAuth);
  await disconnectTenantSockets(adminId);
};

export const getTenants = async (query: Record<string, unknown>) => {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const search = String(query.search ?? query.searchTerm ?? "").trim();
  const lifecycle = query.lifecycleStatus ? String(query.lifecycleStatus) as TenantLifecycleStatus : undefined;
  const subscriptionKind = query.subscriptionKind ? String(query.subscriptionKind) : undefined;
  const planName = query.plan ? String(query.plan) : undefined;
  const subscriptionStatus = query.subscriptionStatus ? String(query.subscriptionStatus) as SubscriptionStatus : undefined;
  const websiteStatus = query.websiteStatus ? String(query.websiteStatus) : undefined;
  const countryInput = query.country ? String(query.country).trim() : "";
  const country = countryInput
    ? Object.values(Country).find((value) =>
        value === countryInput.toUpperCase() ||
        value.replace(/_/g, " ").toLowerCase() === countryInput.replace(/[_-]+/g, " ").toLowerCase(),
      )
    : undefined;
  if (countryInput && !country) throw new AppError(status.BAD_REQUEST, `Unknown country filter: ${countryInput}.`);
  const createdFrom = query.createdFrom ? new Date(String(query.createdFrom)) : undefined;
  const createdTo = query.createdTo ? new Date(String(query.createdTo)) : undefined;

  const subscriptionFilter: Prisma.SubscriptionWhereInput = {
    ...(subscriptionKind === "TRIAL" ? { isTrial: true } : {}),
    ...(subscriptionKind === "PAID" ? { isTrial: false } : {}),
    ...(subscriptionStatus ? { status: subscriptionStatus } : {}),
    ...(planName ? { subscriptionPlan: { name: planName as SubscriptionName } } : {}),
  };
  const hasSubscriptionFilter = Object.keys(subscriptionFilter).length > 0;
  const predicates: Prisma.AdminProfileWhereInput[] = [];

  if (websiteStatus === "PUBLISHED") predicates.push({ businessWebsite: { is: { status: "PUBLISHED" } } });
  if (websiteStatus === "UNPUBLISHED") predicates.push({ businessWebsite: { is: { status: { not: "PUBLISHED" } } } });
  if (websiteStatus === "NONE") predicates.push({ businessWebsite: null });
  if (websiteStatus === "DOMAIN_PROBLEM") {
    predicates.push({
      businessWebsite: {
        is: {
          domains: {
            some: {
              isPrimary: true,
              OR: [
                { status: "FAILED" },
                { ownershipVerified: false },
                { routingVerified: false },
                { tlsStatus: { notIn: ["READY", "EXTERNAL"] } },
              ],
            },
          },
        },
      },
    });
  }

  if (search) {
    predicates.push({
      OR: [
        { businessName: { contains: search, mode: "insensitive" } },
        { businessEmail: { contains: search, mode: "insensitive" } },
        { user: { name: { contains: search, mode: "insensitive" } } },
        { user: { email: { contains: search, mode: "insensitive" } } },
      ],
    });
  }

  const where: Prisma.AdminProfileWhereInput = {
    ...(lifecycle ? { lifecycleStatus: lifecycle } : {}),
    ...(country ? { country } : {}),
    ...(createdFrom || createdTo ? {
      createdAt: {
        ...(createdFrom ? { gte: createdFrom } : {}),
        ...(createdTo ? { lte: createdTo } : {}),
      },
    } : {}),
    ...(hasSubscriptionFilter ? { subscription: { some: subscriptionFilter } } : {}),
    ...(predicates.length ? { AND: predicates } : {}),
  };

  const [total, rows] = await Promise.all([
    prisma.adminProfile.count({ where }),
    prisma.adminProfile.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        userId: true,
        businessName: true,
        businessEmail: true,
        country: true,
        lifecycleStatus: true,
        suspendedAt: true,
        archivedAt: true,
        createdAt: true,
        user: { select: { name: true, email: true, status: true, emailVerified: true } },
        businessWebsite: {
          select: {
            status: true,
            subdomain: true,
            publishedAt: true,
            domains: {
              where: { isPrimary: true },
              take: 1,
              select: {
                domain: true,
                status: true,
                ownershipVerified: true,
                routingVerified: true,
                tlsStatus: true,
                failureReason: true,
              },
            },
          },
        },
        subscription: {
          take: 1,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            status: true,
            isTrial: true,
            trialEndsAt: true,
            currentPeriodEnd: true,
            subscriptionPlan: { select: { id: true, name: true, currency: true } },
            plan: { select: { id: true, interval: true, price: true } },
          },
        },
        _count: { select: { staff: true, clients: true, serviceCatalogs: true, leads: true, bookings: true } },
      },
    }),
  ]);

  const now = new Date();
  return {
    data: rows.map((row) => {
      const subscription = row.subscription[0] ?? null;
      const primaryDomain = row.businessWebsite?.domains[0] ?? null;
      const domainProblem = Boolean(primaryDomain && (
        primaryDomain.status === "FAILED" ||
        !primaryDomain.ownershipVerified ||
        !primaryDomain.routingVerified ||
        !["READY", "EXTERNAL"].includes(primaryDomain.tlsStatus)
      ));
      const healthIssues: string[] = [];
      if (!row.user.emailVerified) healthIssues.push("UNVERIFIED_OWNER");
      if (!subscription) healthIssues.push("NO_SUBSCRIPTION");
      if (subscription?.isTrial && subscription.trialEndsAt && subscription.trialEndsAt <= now) healthIssues.push("EXPIRED_TRIAL");
      if (subscription?.status === SubscriptionStatus.PENDING_PAYMENT) healthIssues.push("PAYMENT_PENDING");
      if (row.lifecycleStatus === TenantLifecycleStatus.SUSPENDED) healthIssues.push("SUSPENDED");
      if (row.lifecycleStatus === PENDING_DELETION) healthIssues.push("PENDING_DELETION");
      if (!row.businessWebsite) healthIssues.push("NO_WEBSITE");
      if (domainProblem) healthIssues.push("DOMAIN_PROBLEM");

      return {
        ...row,
        businessWebsite: row.businessWebsite ? {
          status: row.businessWebsite.status,
          subdomain: row.businessWebsite.subdomain,
          publishedAt: row.businessWebsite.publishedAt,
          primaryDomain,
          domainProblem,
        } : null,
        subscription,
        healthIssues,
      };
    }),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};

export const getTenantsHealth = async () => {
  const [total, active, suspended, archived, pendingDeletion, pendingPlanChanges, unverifiedOwners, missingWebsite, missingSubscription] = await Promise.all([
    prisma.adminProfile.count(),
    prisma.adminProfile.count({ where: { lifecycleStatus: TenantLifecycleStatus.ACTIVE } }),
    prisma.adminProfile.count({ where: { lifecycleStatus: TenantLifecycleStatus.SUSPENDED } }),
    prisma.adminProfile.count({ where: { lifecycleStatus: TenantLifecycleStatus.ARCHIVED } }),
    prisma.adminProfile.count({ where: { lifecycleStatus: PENDING_DELETION } }),
    prisma.pendingPlanChange.count({ where: { status: { in: [PendingPlanChangeStatus.AWAITING_PAYMENT, PendingPlanChangeStatus.UNDER_REVIEW] } } }),
    prisma.adminProfile.count({ where: { user: { emailVerified: false } } }),
    prisma.adminProfile.count({ where: { businessWebsite: null } }),
    prisma.adminProfile.count({ where: { subscription: { none: {} } } }),
  ]);
  return { total, active, suspended, archived, pendingDeletion, pendingPlanChanges, unverifiedOwners, missingWebsite, missingSubscription };
};

export const getTenant360 = async (organizationId: string) =>
  Organization360Service.getOrganization360(organizationId);

export const getTenantTeam = Organization360Service.getOrganizationTeam;
export const getTenantAudit = Organization360Service.getOrganizationAudit;
export const getTenantBilling = Organization360Service.getOrganizationBilling;
export const getTenantActivity = Organization360Service.getOrganizationActivity;
export const getTenantSessions = Organization360Service.getOrganizationSessions;
export const revokeOwnerTenantSessions = Organization360Service.revokeOwnerOrganizationSessions;
export const revokeAllTenantSessions = Organization360Service.revokeAllOrganizationSessions;

export const updateTenantProfile = async (identifier: string, payload: Record<string, unknown>, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier);
  const reason = normalizedReason(context.reason);
  assertTenantMutable(tenant);
  const allowed = ["businessName", "businessLogo", "address", "brandColor", "city", "mobileNumber", "zipcode", "country", "businessEmail", "businessType", "licenseNumber", "businessDescription", "businessHours", "website", "currency"] as const;
  const data: Record<string, unknown> = {};
  for (const key of allowed) if (Object.prototype.hasOwnProperty.call(payload, key)) data[key] = payload[key];
  if (Object.keys(data).length === 0) throw new AppError(status.BAD_REQUEST, "No editable tenant profile fields were provided.");
  const currentProfile = await prisma.adminProfile.findUniqueOrThrow({ where: { id: tenant.id } });
  const before = Object.fromEntries(Object.keys(data).map((key) => [key, (currentProfile as unknown as Record<string, unknown>)[key]]));
  const updated = await prisma.$transaction(async (tx) => {
    const row = await tx.adminProfile.update({ where: { id: tenant.id }, data: data as Prisma.AdminProfileUpdateInput });
    const after = Object.fromEntries(Object.keys(data).map((key) => [key, (row as unknown as Record<string, unknown>)[key]]));
    await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: "TENANT_PROFILE_UPDATED", reason, metadata: { fields: Object.keys(data) }, before, after, ...auditHttpContext(context) }, tx);
    return row;
  });
  await invalidateTenantCaches(tenant);
  return updated;
};

export const updateTenantOwner = async (identifier: string, payload: { name?: string; email?: string; image?: string | null }, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier);
  const reason = normalizedReason(context.reason);
  assertTenantMutable(tenant);
  if (!payload.name && !payload.email && payload.image === undefined) throw new AppError(status.BAD_REQUEST, "No editable owner fields were provided.");
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({ where: { id: tenant.userId }, data: { ...(payload.name ? { name: payload.name.trim() } : {}), ...(payload.email ? { email: payload.email.trim().toLowerCase(), emailVerified: false } : {}), ...(payload.image !== undefined ? { image: payload.image } : {}) } });
      await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: "TENANT_OWNER_UPDATED", reason, metadata: { fields: Object.keys(payload) }, before: { name: tenant.user.name, email: tenant.user.email, image: tenant.user.image, emailVerified: tenant.user.emailVerified }, after: { name: user.name, email: user.email, image: user.image, emailVerified: user.emailVerified }, ...auditHttpContext(context) }, tx);
      return user;
    });
    invalidateRuntimeAuth(tenant.userId);
    return updated;
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new AppError(status.CONFLICT, "That email address is already in use.");
    throw error;
  }
};

const mutateLifecycle = async (identifier: string, target: TenantLifecycleStatus, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier);
  const reason = normalizedReason(context.reason);
  assertTenantMutable(tenant);
  if (target === TenantLifecycleStatus.SUSPENDED && tenant.lifecycleStatus === TenantLifecycleStatus.ARCHIVED) {
    throw new AppError(status.CONFLICT, "Archived tenants must be restored before they can be suspended.");
  }
  if (target === TenantLifecycleStatus.ACTIVE && tenant.lifecycleStatus === TenantLifecycleStatus.ARCHIVED) {
    throw new AppError(status.CONFLICT, "Archived tenants must be restored before reactivation.");
  }
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const admin = await tx.adminProfile.update({
      where: { id: tenant.id },
      data: target === TenantLifecycleStatus.SUSPENDED
        ? { lifecycleStatus: target, suspendedAt: now, suspendedReason: reason }
        : { lifecycleStatus: target, reactivatedAt: now },
    });
    await tx.user.update({ where: { id: tenant.userId }, data: { status: target === TenantLifecycleStatus.ACTIVE ? AccountStatus.ACTIVE : AccountStatus.SUSPENDED } });
    await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: target === TenantLifecycleStatus.ACTIVE ? "TENANT_REACTIVATED" : "TENANT_SUSPENDED", reason, before: { lifecycleStatus: tenant.lifecycleStatus, ownerStatus: tenant.user.status }, after: { lifecycleStatus: target, ownerStatus: target === TenantLifecycleStatus.ACTIVE ? AccountStatus.ACTIVE : AccountStatus.SUSPENDED }, ...auditHttpContext(context) }, tx);
    return admin;
  });
  if (target !== TenantLifecycleStatus.ACTIVE) await revokeTenantSessions(tenant.id);
  await invalidateTenantCaches(tenant);
  return updated;
};

export const suspendTenant = (identifier: string, context: TenantMutationContext) => mutateLifecycle(identifier, TenantLifecycleStatus.SUSPENDED, context);
export const reactivateTenant = (identifier: string, context: TenantMutationContext) => mutateLifecycle(identifier, TenantLifecycleStatus.ACTIVE, context);

export const archiveTenant = async (identifier: string, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier);
  const reason = normalizedReason(context.reason);
  assertTenantMutable(tenant);
  if (tenant.lifecycleStatus === TenantLifecycleStatus.ARCHIVED) return tenant;
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const admin = await tx.adminProfile.update({ where: { id: tenant.id }, data: { lifecycleStatus: TenantLifecycleStatus.ARCHIVED, preArchiveLifecycleStatus: tenant.lifecycleStatus, archivedAt: now, archivedReason: reason } });
    await tx.user.update({ where: { id: tenant.userId }, data: { status: AccountStatus.SUSPENDED } });
    await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: "TENANT_ARCHIVED", reason, before: { lifecycleStatus: tenant.lifecycleStatus }, after: { lifecycleStatus: TenantLifecycleStatus.ARCHIVED }, ...auditHttpContext(context) }, tx);
    return admin;
  });
  await revokeTenantSessions(tenant.id);
  await invalidateTenantCaches(tenant);
  return updated;
};

export const restoreTenant = async (identifier: string, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier);
  const reason = normalizedReason(context.reason);
  assertTenantMutable(tenant);
  if (tenant.lifecycleStatus !== TenantLifecycleStatus.ARCHIVED) throw new AppError(status.CONFLICT, "Tenant is not archived.");
  const restoredStatus = tenant.preArchiveLifecycleStatus === TenantLifecycleStatus.SUSPENDED ? TenantLifecycleStatus.SUSPENDED : TenantLifecycleStatus.ACTIVE;
  const updated = await prisma.$transaction(async (tx) => {
    const admin = await tx.adminProfile.update({ where: { id: tenant.id }, data: { lifecycleStatus: restoredStatus, restoredAt: new Date(), restoredReason: reason, preArchiveLifecycleStatus: null } });
    await tx.user.update({ where: { id: tenant.userId }, data: { status: restoredStatus === TenantLifecycleStatus.ACTIVE ? AccountStatus.ACTIVE : AccountStatus.SUSPENDED } });
    await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: "TENANT_RESTORED", reason, metadata: { restoredStatus }, before: { lifecycleStatus: TenantLifecycleStatus.ARCHIVED }, after: { lifecycleStatus: restoredStatus }, ...auditHttpContext(context) }, tx);
    return admin;
  });
  await invalidateTenantCaches(tenant);
  return updated;
};

export const getTenantDeletionPreview = async (identifier: string) => {
  const tenant = await resolveTenant(identifier);
  const website = await prisma.businessWebsite.findUnique({ where: { adminId: tenant.id }, select: { id: true } });
  const subscriptionIds = (await prisma.subscription.findMany({ where: { adminId: tenant.id }, select: { id: true } })).map((row) => row.id);
  const [users, staff, clients, leads, leadActivities, jobs, bookings, recurringBookings, services, quotes, estimates, invoices, payments, expenses, websiteRevisions, domains, assets, submissions, reviews, notifications, subscriptions, billingHistory, pendingPlanChanges, couponUsages] = await Promise.all([
    prisma.user.count({ where: { OR: [{ id: tenant.userId }, { staff: { adminId: tenant.id } }] } }),
    prisma.staffProfile.count({ where: { adminId: tenant.id } }), prisma.client.count({ where: { adminId: tenant.id } }), prisma.lead.count({ where: { adminId: tenant.id } }), prisma.leadActivity.count({ where: { adminId: tenant.id } }), prisma.job.count({ where: { adminId: tenant.id } }), prisma.booking.count({ where: { adminId: tenant.id } }), prisma.recurringSchedule.count({ where: { adminId: tenant.id } }), prisma.serviceCatalog.count({ where: { adminId: tenant.id } }), prisma.quote.count({ where: { adminId: tenant.id } }), prisma.estimate.count({ where: { adminId: tenant.id } }), prisma.invoice.count({ where: { adminId: tenant.id } }), prisma.payment.count({ where: { adminId: tenant.id } }), prisma.expense.count({ where: { adminId: tenant.id } }), website ? prisma.websiteRevision.count({ where: { websiteId: website.id } }) : 0, website ? prisma.websiteDomain.count({ where: { websiteId: website.id } }) : 0, website ? prisma.websiteAsset.count({ where: { websiteId: website.id } }) : 0, prisma.websiteSubmission.count({ where: { adminId: tenant.id } }), prisma.review.count({ where: { adminId: tenant.id } }), prisma.notification.count({ where: { adminId: tenant.id } }), prisma.subscription.count({ where: { adminId: tenant.id } }), subscriptionIds.length ? prisma.billingHistory.count({ where: { subscriptionId: { in: subscriptionIds } } }) : 0, subscriptionIds.length ? prisma.pendingPlanChange.count({ where: { subscriptionId: { in: subscriptionIds } } }) : 0, prisma.couponUsage.count({ where: { adminId: tenant.id } }),
  ]);
  return { tenant: { id: tenant.id, ownerUserId: tenant.userId, businessName: tenant.businessName, ownerEmail: tenant.user.email, lifecycleStatus: tenant.lifecycleStatus }, confirmationAdminId: tenant.id, confirmationText: HARD_DELETE_TEXT, retryable: tenant.lifecycleStatus === PENDING_DELETION, deletion: { startedAt: tenant.deletionStartedAt, attemptCount: tenant.deletionAttemptCount, lastAttemptAt: tenant.deletionLastAttemptAt, lastError: tenant.deletionLastError }, counts: { users, staff, clients, leads, leadActivities, jobs, bookings, recurringBookings, services, quotes, estimates, invoices, payments, expenses, commissions: 0, website: website ? 1 : 0, websiteRevisions, domains, assets, submissions, reviews, notifications, subscriptions, billingHistory, pendingPlanChanges, couponUsages } };
};

const tenantCloudinaryUrls = async (adminId: string) => {
  const website = await prisma.businessWebsite.findUnique({ where: { adminId }, select: { logo: true, favicon: true, assets: { select: { url: true } } } });
  const [attachments, payments, billing] = await Promise.all([
    prisma.jobAttachment.findMany({ where: { adminId }, select: { fileUrl: true } }),
    prisma.payment.findMany({ where: { adminId }, select: { invoiceUrl: true, paymentProofUrl: true } }),
    prisma.billingHistory.findMany({ where: { subscription: { adminId } }, select: { invoiceUrl: true, paymentProofUrl: true } }),
  ]);
  const values = [website?.logo, website?.favicon, ...(website?.assets.map((x) => x.url) ?? []), ...attachments.map((x) => x.fileUrl), ...payments.flatMap((x) => [x.invoiceUrl, x.paymentProofUrl]), ...billing.flatMap((x) => [x.invoiceUrl, x.paymentProofUrl])];
  return [...new Set(values.filter((url): url is string => Boolean(url && url.includes("cloudinary"))))];
};

export const hardDeleteTenant = async (
  identifier: string,
  input: { adminId: string; confirmationText: string; reason: string },
  context: TenantMutationContext,
) => {
  const tenant = await resolveTenant(identifier);
  if (input.adminId !== tenant.id || input.confirmationText !== HARD_DELETE_TEXT) {
    throw new AppError(status.BAD_REQUEST, "Permanent deletion confirmation did not match the organization id and required text.");
  }
  if (context.actorUserId === tenant.userId) {
    throw new AppError(status.BAD_REQUEST, "A Super Admin cannot permanently delete their own account through organization deletion.");
  }
  const reason = normalizedReason(input.reason);
  const preview = await getTenantDeletionPreview(tenant.id);
  const retry = tenant.lifecycleStatus === PENDING_DELETION;
  const now = new Date();

  // Mark PENDING_DELETION before touching sessions, caches, storage or tenant
  // rows. The conditional claim prevents two initial delete requests from
  // purging the same organization concurrently. A retry is allowed after a
  // recorded failure, or after a stale in-progress attempt (5 minutes).
  await prisma.$transaction(async (tx) => {
    const before = {
      lifecycleStatus: tenant.lifecycleStatus,
      deletionAttemptCount: tenant.deletionAttemptCount,
      deletionLastError: tenant.deletionLastError,
    };

    if (!retry) {
      const claim = await tx.adminProfile.updateMany({
        where: { id: tenant.id, lifecycleStatus: { not: PENDING_DELETION } },
        data: {
          lifecycleStatus: PENDING_DELETION,
          deletionStartedAt: tenant.deletionStartedAt ?? now,
          deletionReason: reason,
          deletionAttemptCount: { increment: 1 },
          deletionLastAttemptAt: now,
          deletionLastError: null,
        },
      });
      if (claim.count !== 1) {
        throw new AppError(status.CONFLICT, "Permanent deletion is already in progress. Refresh the deletion preview before retrying.", {
          code: "TENANT_DELETE_ALREADY_IN_PROGRESS",
          retryable: true,
        });
      }
    } else {
      const lastAttemptAt = tenant.deletionLastAttemptAt?.getTime() ?? 0;
      const stale = !lastAttemptAt || now.getTime() - lastAttemptAt >= 5 * 60 * 1000;
      if (!tenant.deletionLastError && !stale) {
        throw new AppError(status.CONFLICT, "Permanent deletion is already in progress. Retry after the current attempt finishes or becomes stale.", {
          code: "TENANT_DELETE_ALREADY_IN_PROGRESS",
          retryable: true,
        });
      }
      await tx.adminProfile.update({
        where: { id: tenant.id },
        data: {
          lifecycleStatus: PENDING_DELETION,
          deletionStartedAt: tenant.deletionStartedAt ?? now,
          deletionReason: reason,
          deletionAttemptCount: { increment: 1 },
          deletionLastAttemptAt: now,
          deletionLastError: null,
        },
      });
    }

    const updated = await tx.adminProfile.findUniqueOrThrow({
      where: { id: tenant.id },
      select: { lifecycleStatus: true, deletionAttemptCount: true, deletionStartedAt: true, deletionLastAttemptAt: true },
    });
    await tx.user.update({ where: { id: tenant.userId }, data: { status: AccountStatus.SUSPENDED } });
    await writeSuperAdminAudit({
      actorUserId: context.actorUserId,
      tenantAdminId: tenant.id,
      targetUserId: tenant.userId,
      action: retry ? "TENANT_HARD_DELETE_RETRIED" : "TENANT_HARD_DELETE_STARTED",
      reason,
      metadata: { counts: preview.counts, attempt: updated.deletionAttemptCount },
      before,
      after: updated,
      ...auditHttpContext(context),
    }, tx);
  });

  await revokeTenantSessions(tenant.id);
  await invalidateTenantCaches(tenant);

  const recordFailure = async (stage: "EXTERNAL_ASSETS" | "DATABASE" | "VERIFICATION", error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const safeMessage = message.slice(0, 1000);
    await prisma.adminProfile.update({
      where: { id: tenant.id },
      data: { lifecycleStatus: PENDING_DELETION, deletionLastError: `${stage}: ${safeMessage}`, deletionLastAttemptAt: new Date() },
    }).catch(() => undefined);
    await writeSuperAdminAudit({
      actorUserId: context.actorUserId,
      tenantAdminId: tenant.id,
      targetUserId: tenant.userId,
      action: "TENANT_HARD_DELETE_FAILED",
      reason,
      metadata: { stage, error: safeMessage },
      after: { lifecycleStatus: PENDING_DELETION, deletionLastError: `${stage}: ${safeMessage}` },
      ...auditHttpContext(context),
    }).catch(() => undefined);
  };

  const urls = await tenantCloudinaryUrls(tenant.id);
  const cleanup = await Promise.allSettled(urls.map((url) => deleteFileFromCloudinary(url)));
  const failedAssets = cleanup
    .map((result, index) => ({ result, url: urls[index] }))
    .filter((entry): entry is { result: PromiseRejectedResult; url: string } => entry.result.status === "rejected");
  if (failedAssets.length) {
    const error = new AppError(status.BAD_GATEWAY, `External asset cleanup failed for ${failedAssets.length} file(s). The organization remains pending deletion and can be retried.`, { code: "TENANT_DELETE_EXTERNAL_CLEANUP_FAILED", retryable: true });
    await recordFailure("EXTERNAL_ASSETS", error);
    throw error;
  }

  const staffUsers = await prisma.staffProfile.findMany({ where: { adminId: tenant.id }, select: { userId: true } });
  try {
    await prisma.$transaction(async (tx) => {
      await tx.couponUsage.deleteMany({ where: { adminId: tenant.id } });
      if (staffUsers.length) await tx.user.deleteMany({ where: { id: { in: staffUsers.map((row) => row.userId) } } });
      await tx.user.delete({ where: { id: tenant.userId } });
      // Keep the success audit in the same database transaction as the tenant
      // purge. If the immutable audit write fails, the tenant deletion rolls
      // back and remains PENDING_DELETION for an explicit retry.
      await writeSuperAdminAudit({
        actorUserId: context.actorUserId,
        tenantAdminId: tenant.id,
        targetUserId: tenant.userId,
        action: "TENANT_HARD_DELETED",
        reason,
        metadata: { counts: preview.counts, externalAssetsDeleted: urls.length, retry },
        before: { lifecycleStatus: PENDING_DELETION },
        after: { lifecycleStatus: "DELETED" },
        ...auditHttpContext(context),
      }, tx);
    });
  } catch (error) {
    await recordFailure("DATABASE", error);
    throw new AppError(status.INTERNAL_SERVER_ERROR, "Database cleanup failed. The organization remains pending deletion and can be retried.", { code: "TENANT_DELETE_DATABASE_FAILED", retryable: true });
  }

  const remains = await prisma.adminProfile.count({ where: { id: tenant.id } });
  if (remains !== 0) {
    const error = new AppError(status.INTERNAL_SERVER_ERROR, "Organization deletion verification failed. Retry permanent deletion.", { code: "TENANT_DELETE_VERIFICATION_FAILED", retryable: true });
    await recordFailure("VERIFICATION", error);
    throw error;
  }
  return { deleted: true, tenantId: tenant.id, externalAssetsDeleted: urls.length, counts: preview.counts, retried: retry };
};

const buildGlobalUserWhere = (query: Record<string, unknown>): Prisma.UserWhereInput => {
  const search = String(query.search ?? "").trim();
  const and: Prisma.UserWhereInput[] = [];
  if (query.tenant) {
    const tenant = String(query.tenant);
    and.push({ OR: [{ admin: { id: tenant } }, { staff: { adminId: tenant } }] });
  }
  if (search) {
    and.push({ OR: [{ name: { contains: search, mode: "insensitive" } }, { email: { contains: search, mode: "insensitive" } }] });
  }
  return {
    ...(query.role ? { role: String(query.role) as UserRole } : {}),
    ...(query.status ? { status: String(query.status) as AccountStatus } : {}),
    ...(query.verified !== undefined ? { emailVerified: String(query.verified) === "true" } : {}),
    ...(query.createdFrom || query.createdTo ? { createdAt: { ...(query.createdFrom ? { gte: new Date(String(query.createdFrom)) } : {}), ...(query.createdTo ? { lte: new Date(String(query.createdTo)) } : {}) } } : {}),
    ...(and.length ? { AND: and } : {}),
  };
};

const globalUserSelect = {
  id: true, name: true, email: true, emailVerified: true, image: true, role: true, status: true, createdAt: true, updatedAt: true,
  admin: { select: { id: true, businessName: true, lifecycleStatus: true } },
  staff: { select: { id: true, adminId: true, staffRole: true, admin: { select: { businessName: true, lifecycleStatus: true } } } },
} satisfies Prisma.UserSelect;

export const getGlobalUsers = async (query: Record<string, unknown>) => {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const where = buildGlobalUserWhere(query);
  const [total, rows] = await Promise.all([
    prisma.user.count({ where }),
    prisma.user.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" }, select: globalUserSelect }),
  ]);
  return { data: rows, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
};

export const getGlobalUsersSummary = async () => {
  const [total, verified, pending, active, suspended, admins, staff, superAdmins] = await Promise.all([
    prisma.user.count(), prisma.user.count({ where: { emailVerified: true } }), prisma.user.count({ where: { status: AccountStatus.PENDING } }), prisma.user.count({ where: { status: AccountStatus.ACTIVE } }), prisma.user.count({ where: { status: AccountStatus.SUSPENDED } }), prisma.user.count({ where: { role: UserRole.ADMIN } }), prisma.user.count({ where: { role: UserRole.STAFF } }), prisma.user.count({ where: { role: UserRole.SUPER_ADMIN } }),
  ]);
  return { total, verified, unverified: total - verified, pending, active, suspended, roles: { admins, staff, superAdmins } };
};

const csvCell = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
export const exportGlobalUsersCsv = async (query: Record<string, unknown>) => {
  const where = buildGlobalUserWhere(query);
  const total = await prisma.user.count({ where });
  const EXPORT_LIMIT = 50_000;
  if (total > EXPORT_LIMIT) {
    throw new AppError(status.BAD_REQUEST, `The export matches ${total} users. Narrow the filters below ${EXPORT_LIMIT} rows before exporting.`);
  }
  const rows = await prisma.user.findMany({ where, orderBy: { createdAt: "desc" }, take: EXPORT_LIMIT, select: globalUserSelect });
  const headers = ["id", "name", "email", "role", "status", "verified", "tenantId", "tenant", "createdAt"];
  const values = rows.map((u) => [u.id, u.name, u.email, u.role, u.status, u.emailVerified, u.admin?.id ?? u.staff?.adminId ?? "", u.admin?.businessName ?? u.staff?.admin.businessName ?? "", u.createdAt.toISOString()]);
  return [headers.map(csvCell).join(","), ...values.map((row) => row.map(csvCell).join(","))].join("\n");
};

export const updateGlobalUserStatus = async (userId: string, nextStatus: AccountStatus, context: TenantMutationContext) => {
  const reason = normalizedReason(context.reason);
  const target = await prisma.user.findUnique({ where: { id: userId }, include: { admin: { select: { id: true } }, staff: { select: { adminId: true } } } });
  if (!target) throw new AppError(status.NOT_FOUND, "User not found.");
  if (target.admin?.id) { const tenant = await resolveTenant(target.admin.id); assertTenantMutable(tenant); }
  if (target.id === context.actorUserId && nextStatus !== AccountStatus.ACTIVE) throw new AppError(status.BAD_REQUEST, "You cannot suspend your own Super Admin account.");
  if (target.role === UserRole.ADMIN && target.admin) {
    return nextStatus === AccountStatus.ACTIVE ? reactivateTenant(target.admin.id, context) : suspendTenant(target.admin.id, context);
  }
  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: { status: nextStatus }, select: { id: true, name: true, email: true, role: true, status: true } });
    await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: target.staff?.adminId ?? null, targetUserId: userId, action: "USER_STATUS_UPDATED", reason, metadata: { from: target.status, to: nextStatus }, before: { status: target.status }, after: { status: nextStatus }, ...auditHttpContext(context) }, tx);
    return user;
  });
  if (nextStatus !== AccountStatus.ACTIVE) await revokeAllSessionsForUser(userId);
  invalidateRuntimeAuth(userId);
  return updated;
};

export const updateGlobalUserRole = async (userId: string, role: UserRole, context: TenantMutationContext) => {
  const reason = normalizedReason(context.reason);
  if (userId === context.actorUserId) throw new AppError(status.BAD_REQUEST, "You cannot change your own role.");
  const target = await prisma.user.findUnique({ where: { id: userId }, include: { admin: { select: { id: true } }, staff: { select: { adminId: true } } } });
  if (!target) throw new AppError(status.NOT_FOUND, "User not found.");
  if ((target.admin || target.staff) && role !== target.role) throw new AppError(status.CONFLICT, "Role conversion for a tenant owner or staff profile requires a dedicated migration and is blocked to preserve data integrity.");
  if (target.role === UserRole.SUPER_ADMIN && role !== UserRole.SUPER_ADMIN) {
    const remaining = await prisma.user.count({ where: { role: UserRole.SUPER_ADMIN, id: { not: userId } } });
    if (!remaining) throw new AppError(status.CONFLICT, "The final Super Admin cannot be demoted.");
  }
  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: { role }, select: { id: true, name: true, email: true, role: true, status: true } });
    await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: target.admin?.id ?? target.staff?.adminId ?? null, targetUserId: userId, action: "USER_ROLE_UPDATED", reason, metadata: { from: target.role, to: role }, before: { role: target.role }, after: { role }, ...auditHttpContext(context) }, tx);
    return user;
  });
  await revokeAllSessionsForUser(userId); invalidateRuntimeAuth(userId); return updated;
};

export const verifyGlobalUser = async (userId: string, context: TenantMutationContext) => {
  const reason = normalizedReason(context.reason);
  const target = await prisma.user.findUnique({ where: { id: userId }, include: { admin: { select: { id: true } }, staff: { select: { adminId: true } } } });
  if (!target) throw new AppError(status.NOT_FOUND, "User not found.");
  if (target.admin?.id) { const tenant = await resolveTenant(target.admin.id); assertTenantMutable(tenant); }
  const updated = await prisma.$transaction(async (tx) => {
    const user = await tx.user.update({ where: { id: userId }, data: { emailVerified: true, ...(target.status === AccountStatus.PENDING ? { status: AccountStatus.ACTIVE } : {}) }, select: { id: true, name: true, email: true, emailVerified: true, status: true, role: true } });
    await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: target.admin?.id ?? target.staff?.adminId ?? null, targetUserId: userId, action: "USER_MANUALLY_VERIFIED", reason, before: { emailVerified: target.emailVerified, status: target.status }, after: { emailVerified: user.emailVerified, status: user.status }, ...auditHttpContext(context) }, tx);
    return user;
  });
  invalidateRuntimeAuth(userId); return updated;
};


export const getSuperAdminAuditLogs = async (query: Record<string, unknown>) => {
  const page = Math.max(1, Number(query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const search = String(query.search ?? "").trim();
  const where: Prisma.SuperAdminAuditLogWhereInput = {
    ...(query.action ? { action: String(query.action) } : {}),
    ...(query.tenant ? { tenantAdminId: String(query.tenant) } : {}),
    ...(query.actor ? { actorUserId: String(query.actor) } : {}),
    ...(query.target ? { targetUserId: String(query.target) } : {}),
    ...(query.createdFrom || query.createdTo ? { createdAt: { ...(query.createdFrom ? { gte: new Date(String(query.createdFrom)) } : {}), ...(query.createdTo ? { lte: new Date(String(query.createdTo)) } : {}) } } : {}),
    ...(search ? { OR: [
      { action: { contains: search, mode: "insensitive" } },
      { reason: { contains: search, mode: "insensitive" } },
      { actor: { is: { name: { contains: search, mode: "insensitive" } } } },
      { actor: { is: { email: { contains: search, mode: "insensitive" } } } },
    ] } : {}),
  };
  const [total, rows] = await Promise.all([
    prisma.superAdminAuditLog.count({ where }),
    prisma.superAdminAuditLog.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" }, include: { actor: { select: { id: true, name: true, email: true } } } }),
  ]);
  const tenantIds = [...new Set(rows.map((row) => row.tenantAdminId).filter((id): id is string => Boolean(id)))];
  const targetIds = [...new Set(rows.map((row) => row.targetUserId).filter((id): id is string => Boolean(id)))];
  const [tenants, targets] = await Promise.all([
    tenantIds.length ? prisma.adminProfile.findMany({ where: { id: { in: tenantIds } }, select: { id: true, businessName: true } }) : Promise.resolve([]),
    targetIds.length ? prisma.user.findMany({ where: { id: { in: targetIds } }, select: { id: true, name: true, email: true } }) : Promise.resolve([]),
  ]);
  const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));
  const targetMap = new Map(targets.map((user) => [user.id, user]));
  return {
    data: rows.map((row) => ({ ...row, tenant: row.tenantAdminId ? tenantMap.get(row.tenantAdminId) ?? null : null, targetUser: row.targetUserId ? targetMap.get(row.targetUserId) ?? null : null })),
    meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
};

export const getSuperAdminAuditStats = async () => {
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekStart = new Date(dayStart); weekStart.setDate(dayStart.getDate() - dayStart.getDay());
  const [total, today, week] = await Promise.all([
    prisma.superAdminAuditLog.count(),
    prisma.superAdminAuditLog.count({ where: { createdAt: { gte: dayStart } } }),
    prisma.superAdminAuditLog.count({ where: { createdAt: { gte: weekStart } } }),
  ]);
  return { total, today, week };
};


export const approveSubscriptionRequest = async (requestId: string, context: TenantMutationContext) => {
  const reason = normalizedReason(context.reason);
  const request = await prisma.pendingPlanChange.findFirst({
    where: { id: requestId, isAdministrative: false },
    include: {
      subscription: { select: { adminId: true, admin: { select: { userId: true } } } },
      billingHistory: { where: { status: "PENDING", paymentProofUrl: { not: null } }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!request) throw new AppError(status.NOT_FOUND, "Subscription request not found.");
  assertTenantMutable(await resolveTenant(request.subscription.adminId));
  if (request.status !== PendingPlanChangeStatus.UNDER_REVIEW) throw new AppError(status.CONFLICT, "Only requests under review can be approved.");
  const billing = request.billingHistory[0];
  if (!billing) throw new AppError(status.BAD_REQUEST, "This request has no pending payment proof to approve.");
  const result = await superAdminService.approvePaymentProof(billing.id, { note: `Approved by Super Admin: ${reason}` });
  await writeSuperAdminAudit({
    actorUserId: context.actorUserId, tenantAdminId: request.subscription.adminId, targetUserId: request.subscription.admin.userId,
    action: "SUBSCRIPTION_REQUEST_APPROVED", reason, metadata: { requestId, billingId: billing.id }, before: { status: request.status }, after: { status: PendingPlanChangeStatus.APPROVED }, ...auditHttpContext(context),
  });
  return result;
};

export const rejectSubscriptionRequest = async (requestId: string, context: TenantMutationContext) => {
  const reason = normalizedReason(context.reason);
  const request = await prisma.pendingPlanChange.findFirst({
    where: { id: requestId, isAdministrative: false },
    include: {
      subscription: { select: { adminId: true, admin: { select: { userId: true } } } },
      billingHistory: { where: { status: "PENDING", paymentProofUrl: { not: null } }, orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!request) throw new AppError(status.NOT_FOUND, "Subscription request not found.");
  assertTenantMutable(await resolveTenant(request.subscription.adminId));
  if (request.status !== PendingPlanChangeStatus.UNDER_REVIEW) throw new AppError(status.CONFLICT, "Only requests under review can be rejected.");
  const billing = request.billingHistory[0];
  if (!billing) throw new AppError(status.BAD_REQUEST, "This request has no pending payment proof to reject.");
  const result = await superAdminService.rejectPaymentProof(billing.id, { reason });
  await writeSuperAdminAudit({
    actorUserId: context.actorUserId, tenantAdminId: request.subscription.adminId, targetUserId: request.subscription.admin.userId,
    action: "SUBSCRIPTION_REQUEST_REJECTED", reason, metadata: { requestId, billingId: billing.id }, before: { status: request.status }, after: { status: PendingPlanChangeStatus.REJECTED }, ...auditHttpContext(context),
  });
  return result;
};

export const getSubscriptionRequests = async (query: Record<string, unknown>) => {
  const page = Math.max(1, Number(query.page) || 1); const limit = Math.min(100, Math.max(1, Number(query.limit) || 20));
  const where: Prisma.PendingPlanChangeWhereInput = { isAdministrative: false, ...(query.status ? { status: String(query.status) as PendingPlanChangeStatus } : {}), ...(query.tenant ? { subscription: { adminId: String(query.tenant) } } : {}) };
  const [total, rows] = await Promise.all([
    prisma.pendingPlanChange.count({ where }),
    prisma.pendingPlanChange.findMany({ where, skip: (page - 1) * limit, take: limit, orderBy: { createdAt: "desc" }, include: { targetPlan: { include: { subscriptionPlan: true } }, coupon: true, billingHistory: { orderBy: { createdAt: "desc" }, take: 5 }, subscription: { include: { admin: { select: { id: true, businessName: true, user: { select: { name: true, email: true } } } }, plan: { include: { subscriptionPlan: true } } } } } }),
  ]);
  return { data: rows, meta: { page, limit, total, totalPages: Math.ceil(total / limit) } };
};

const latestSubscription = async (tenantId: string) => {
  const sub = await prisma.subscription.findFirst({ where: { adminId: tenantId }, orderBy: { createdAt: "desc" }, include: { plan: { include: { subscriptionPlan: true } }, subscriptionPlan: true } });
  if (!sub) throw new AppError(status.NOT_FOUND, "Tenant subscription not found.");
  return sub;
};

export const changeTenantPlan = async (identifier: string, targetPlanId: string, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier); const reason = normalizedReason(context.reason); assertTenantMutable(tenant); const current = await latestSubscription(tenant.id);
  const target = await prisma.plan.findUnique({ where: { id: targetPlanId }, include: { subscriptionPlan: true } });
  if (!target || !target.subscriptionPlan.isActive) throw new AppError(status.NOT_FOUND, "Target plan is not available.");
  const now = new Date(); const currentEnd = current.currentPeriodEnd && current.currentPeriodEnd > now ? current.currentPeriodEnd : (target.interval === SubscriptionPlanInterval.YEARLY ? addYears(now, 1) : addMonths(now, 1));
  const updated = await prisma.$transaction(async (tx) => {
    await tx.pendingPlanChange.updateMany({ where: { subscriptionId: current.id, isAdministrative: true, applyAt: { not: null }, status: PendingPlanChangeStatus.APPROVED }, data: { status: PendingPlanChangeStatus.CANCELLED, rejectionReason: "Superseded by immediate Super Admin plan override.", reviewedAt: now } });
    const sub = await tx.subscription.update({ where: { id: current.id }, data: { planId: target.id, subscriptionPlanId: target.subscriptionPlanId, status: SubscriptionStatus.ACTIVE, isTrial: false, trialEndsAt: null, currentPeriodStart: current.currentPeriodStart ?? now, currentPeriodEnd: currentEnd, cancelAtPeriodEnd: false, canceledAt: null } });
    await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: "TENANT_PLAN_OVERRIDDEN", reason, metadata: { noCharge: true }, before: { planId: current.planId, subscriptionPlanId: current.subscriptionPlanId }, after: { planId: target.id, subscriptionPlanId: target.subscriptionPlanId }, ...auditHttpContext(context) }, tx); return sub;
  });
  await invalidateTenantCaches(tenant); return updated;
};

const tierRank: Record<string, number> = { STARTER: 1, GROWTH: 2, PRO: 3, CUSTOM: 4 };
export const scheduleTenantDowngrade = async (identifier: string, targetPlanId: string, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier); const reason = normalizedReason(context.reason); assertTenantMutable(tenant); const current = await latestSubscription(tenant.id);
  if (!current.currentPeriodEnd) throw new AppError(status.CONFLICT, "A billing period end is required to schedule a downgrade.");
  const target = await prisma.plan.findUnique({ where: { id: targetPlanId }, include: { subscriptionPlan: true } });
  if (!target || tierRank[target.subscriptionPlan.name] >= tierRank[current.subscriptionPlan.name]) throw new AppError(status.BAD_REQUEST, "Scheduled plan changes must be a downgrade.");
  const existing = await prisma.pendingPlanChange.findFirst({ where: { subscriptionId: current.id, isAdministrative: true, status: PendingPlanChangeStatus.APPROVED, applyAt: { not: null } } });
  if (existing) throw new AppError(status.CONFLICT, "This tenant already has a scheduled plan change.");
  const row = await prisma.$transaction(async (tx) => {
    const created = await tx.pendingPlanChange.create({ data: { subscriptionId: current.id, targetPlanId: target.id, quotedAmount: 0, currency: target.subscriptionPlan.currency, status: PendingPlanChangeStatus.APPROVED, submittedAt: new Date(), reviewedAt: new Date(), expiresAt: addDays(current.currentPeriodEnd!, 30), applyAt: current.currentPeriodEnd, isAdministrative: true, reason, requestedByUserId: context.actorUserId, reviewedByUserId: context.actorUserId } });
    await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: "TENANT_DOWNGRADE_SCHEDULED", reason, metadata: { targetPlanId, applyAt: current.currentPeriodEnd, noCharge: true }, before: { scheduled: false }, after: { scheduled: true, targetPlanId, applyAt: current.currentPeriodEnd }, ...auditHttpContext(context) }, tx); return created;
  }); return row;
};

export const cancelScheduledTenantChange = async (identifier: string, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier); const reason = normalizedReason(context.reason); assertTenantMutable(tenant); const current = await latestSubscription(tenant.id);
  const pending = await prisma.pendingPlanChange.findFirst({ where: { subscriptionId: current.id, isAdministrative: true, status: PendingPlanChangeStatus.APPROVED, applyAt: { not: null } }, orderBy: { createdAt: "desc" } });
  if (!pending) throw new AppError(status.NOT_FOUND, "No scheduled administrative plan change exists.");
  return prisma.$transaction(async (tx) => { const row = await tx.pendingPlanChange.update({ where: { id: pending.id }, data: { status: PendingPlanChangeStatus.CANCELLED, rejectionReason: reason, reviewedAt: new Date(), applyAt: null } }); await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: "TENANT_SCHEDULED_PLAN_CHANGE_CANCELLED", reason, metadata: { pendingPlanChangeId: pending.id }, before: { status: pending.status, applyAt: pending.applyAt }, after: { status: PendingPlanChangeStatus.CANCELLED, applyAt: null }, ...auditHttpContext(context) }, tx); return row; });
};

export const setTenantCancelAtPeriodEnd = async (identifier: string, cancelAtPeriodEnd: boolean, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier); const reason = normalizedReason(context.reason); assertTenantMutable(tenant); const current = await latestSubscription(tenant.id);
  const row = await prisma.$transaction(async (tx) => { const sub = await tx.subscription.update({ where: { id: current.id }, data: { cancelAtPeriodEnd, canceledAt: cancelAtPeriodEnd ? new Date() : null } }); await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: cancelAtPeriodEnd ? "TENANT_CANCELLATION_SCHEDULED" : "TENANT_CANCELLATION_REMOVED", reason, before: { cancelAtPeriodEnd: current.cancelAtPeriodEnd }, after: { cancelAtPeriodEnd }, ...auditHttpContext(context) }, tx); return sub; });
  await invalidateTenantCaches(tenant); return row;
};

export const manageTenantTrial = async (identifier: string, input: { action: "RESTART" | "EXTEND" | "SET_END" | "END"; days?: number; endAt?: string }, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier); const reason = normalizedReason(context.reason); assertTenantMutable(tenant); const current = await latestSubscription(tenant.id); const now = new Date();
  let data: Prisma.SubscriptionUpdateInput;
  if (input.action === "RESTART") { const days = input.days ?? (await getPlatformConfig()).defaultTrialDays; data = { isTrial: true, status: SubscriptionStatus.ACTIVE, trialEndsAt: addDays(now, days), currentPeriodStart: now, currentPeriodEnd: null, cancelAtPeriodEnd: false, canceledAt: null }; }
  else if (input.action === "EXTEND") { const days = input.days ?? 0; if (days < 1 || days > 365) throw new AppError(status.BAD_REQUEST, "days must be between 1 and 365."); const base = current.trialEndsAt && current.trialEndsAt > now ? current.trialEndsAt : now; data = { isTrial: true, status: SubscriptionStatus.ACTIVE, trialEndsAt: addDays(base, days) }; }
  else if (input.action === "SET_END") { if (!input.endAt) throw new AppError(status.BAD_REQUEST, "endAt is required."); const endAt = new Date(input.endAt); if (!Number.isFinite(endAt.getTime()) || endAt <= now) throw new AppError(status.BAD_REQUEST, "endAt must be a future date."); data = { isTrial: true, status: SubscriptionStatus.ACTIVE, trialEndsAt: endAt }; }
  else data = { isTrial: true, status: SubscriptionStatus.EXPIRED, trialEndsAt: now };
  const row = await prisma.$transaction(async (tx) => {
    const sub = await tx.subscription.update({ where: { id: current.id }, data });
    await writeSuperAdminAudit({
      actorUserId: context.actorUserId,
      tenantAdminId: tenant.id,
      targetUserId: tenant.userId,
      action: `TENANT_TRIAL_${input.action}`,
      reason,
      metadata: { days: input.days ?? null, requestedEndAt: input.endAt ?? null },
      before: { isTrial: current.isTrial, status: current.status, trialEndsAt: current.trialEndsAt?.toISOString() ?? null },
      after: { isTrial: sub.isTrial, status: sub.status, trialEndsAt: sub.trialEndsAt?.toISOString() ?? null },
      ...auditHttpContext(context),
    }, tx);
    return sub;
  });
  await invalidateTenantCaches(tenant);
  return row;
};

export const setTenantEntitlements = async (identifier: string, payload: Parameters<typeof TenantEntitlementService.setTenantEntitlementOverride>[2], context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier); const reason = normalizedReason(payload.reason); assertTenantMutable(tenant);
  const before = await TenantEntitlementService.getTenantEntitlementOverride(tenant.id);
  const result = await prisma.$transaction(async (tx) => { const row = await TenantEntitlementService.setTenantEntitlementOverride(tenant.id, context.actorUserId, { ...payload, reason }, tx); await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: "TENANT_ENTITLEMENTS_OVERRIDDEN", reason, metadata: { resources: payload.resources, features: payload.features, expiresAt: payload.expiresAt }, before, after: row, ...auditHttpContext(context) }, tx); return row; }); await invalidateTenantCaches(tenant); return result;
};

export const revokeTenantEntitlements = async (identifier: string, context: TenantMutationContext) => {
  const tenant = await resolveTenant(identifier); const reason = normalizedReason(context.reason); assertTenantMutable(tenant);
  const before = await TenantEntitlementService.getTenantEntitlementOverride(tenant.id);
  const result = await prisma.$transaction(async (tx) => { const row = await TenantEntitlementService.revokeTenantEntitlementOverride(tenant.id, tx); await writeSuperAdminAudit({ actorUserId: context.actorUserId, tenantAdminId: tenant.id, targetUserId: tenant.userId, action: "TENANT_ENTITLEMENTS_REVOKED", reason, before, after: null, ...auditHttpContext(context) }, tx); return row; }); await invalidateTenantCaches(tenant); return result;
};

export const applyDueAdministrativePlanChanges = async (now = new Date()) => {
  const due = await prisma.pendingPlanChange.findMany({ where: { isAdministrative: true, status: PendingPlanChangeStatus.APPROVED, applyAt: { lte: now } }, include: { targetPlan: true, subscription: { select: { id: true, adminId: true, admin: { select: { userId: true } } } } }, take: 100 });
  let applied = 0;
  for (const change of due) {
    await prisma.$transaction(async (tx) => {
      await tx.subscription.update({ where: { id: change.subscriptionId }, data: { planId: change.targetPlanId, subscriptionPlanId: change.targetPlan.subscriptionPlanId, status: SubscriptionStatus.ACTIVE, isTrial: false, trialEndsAt: null, currentPeriodStart: now, currentPeriodEnd: change.targetPlan.interval === SubscriptionPlanInterval.YEARLY ? addYears(now, 1) : addMonths(now, 1) } });
      await tx.pendingPlanChange.update({ where: { id: change.id }, data: { applyAt: null, reviewedAt: now } });
      await writeSuperAdminAudit({ actorUserId: change.reviewedByUserId ?? null, tenantAdminId: change.subscription.adminId, action: "TENANT_SCHEDULED_PLAN_CHANGE_APPLIED", reason: change.reason ?? "Scheduled administrative plan change applied automatically.", metadata: { pendingPlanChangeId: change.id, targetPlanId: change.targetPlanId, noCharge: true } }, tx);
    });
    await Promise.all([
      invalidateRuntimeSubscriptionForAdmin(change.subscription.adminId),
      invalidateSubscriptionAccessCache(change.subscription.admin.userId).catch(() => undefined),
    ]);
    applied += 1;
  }
  return { applied };
};

export const TenantAdminService = {
  resolveTenant, resolveOrganizationIdByOwnerUserId, getTenants, getTenantsHealth, getTenant360, getTenantTeam, getTenantAudit, getTenantBilling, getTenantActivity, getTenantSessions, revokeOwnerTenantSessions, revokeAllTenantSessions, updateTenantProfile, updateTenantOwner,
  suspendTenant, reactivateTenant, archiveTenant, restoreTenant, getTenantDeletionPreview, hardDeleteTenant,
  getGlobalUsers, getGlobalUsersSummary, exportGlobalUsersCsv, updateGlobalUserStatus, updateGlobalUserRole, verifyGlobalUser,
  getSuperAdminAuditLogs, getSuperAdminAuditStats, getSubscriptionRequests, approveSubscriptionRequest, rejectSubscriptionRequest, changeTenantPlan, scheduleTenantDowngrade, cancelScheduledTenantChange, setTenantCancelAtPeriodEnd, manageTenantTrial,
  setTenantEntitlements, revokeTenantEntitlements, applyDueAdministrativePlanChanges,
};
