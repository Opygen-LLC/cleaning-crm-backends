/**
 * Canonical tenant access middleware.
 *
 * Authorization decisions come from TenantAccessResolver only. Plan labels are
 * display metadata and are never compared for access control here.
 */
import { NextFunction, Request, Response } from "express";
import status from "http-status";
import { UserRole } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma/prisma";
import AppError from "../errorHelper/AppError";
import { getVerifiedAccessToken } from "../lib/utils/verifiedRequestToken";
import { CookieUtils } from "../lib/utils/cookie";
import { recordTraceSpan } from "../lib/monitoring/requestTrace";
import {
  getRuntimeAdminAccessContext,
  getRuntimeStaffAccessContext,
  invalidateRuntimeAdminAccessContext,
  invalidateRuntimeSubscriptionForAdmin,
} from "../lib/cache/authRuntimeCache";
import { TenantAccessResolver, type TenantAccessDeniedReason } from "../modules/Entitlement/tenantAccessResolver.service";
import { resolveFeatureKey, type FeatureKey } from "../modules/Entitlement/featureCatalog";
import { SupportModeService } from "../modules/SuperAdmin/supportMode.service";

function getAccessToken(req: Request): string | undefined {
  const cookieToken = CookieUtils.getCookie(req, "accessToken");
  if (cookieToken) return cookieToken;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice("Bearer ".length).trim();
  return undefined;
}

function accessError(reason: TenantAccessDeniedReason): AppError {
  switch (reason) {
    case "TENANT_PENDING_DELETION":
      return new AppError(status.FORBIDDEN, "This organization is pending permanent deletion and is locked.", { code: reason, retryable: false });
    case "TENANT_ARCHIVED":
      return new AppError(status.FORBIDDEN, "This business account has been archived.", { code: reason, retryable: false });
    case "TENANT_SUSPENDED":
      return new AppError(status.FORBIDDEN, "This business account has been suspended. Please contact support.", { code: reason, retryable: false });
    case "OWNER_ACCOUNT_SUSPENDED":
      return new AppError(status.FORBIDDEN, "Your account has been suspended. Please contact support.", { code: reason, retryable: false });
    case "OWNER_ACCOUNT_DELETED":
      return new AppError(status.FORBIDDEN, "This account has been deleted.", { code: reason, retryable: false });
    case "OWNER_ACCOUNT_PENDING":
      return new AppError(status.FORBIDDEN, "This account is not active yet.", { code: reason, retryable: false });
    case "SUBSCRIPTION_SUSPENDED":
      return new AppError(status.PAYMENT_REQUIRED, "Your subscription has been suspended. Please contact support or submit a payment proof.", { code: reason, retryable: false });
    case "PAYMENT_PENDING":
      return new AppError(status.PAYMENT_REQUIRED, "Your payment proof is under review. Your account will be reactivated once approved.", { code: reason, retryable: false });
    case "TRIAL_EXPIRED":
      return new AppError(status.PAYMENT_REQUIRED, "Your free trial has ended. Please upgrade to continue.", { code: reason, retryable: false });
    case "SUBSCRIPTION_MISSING":
      return new AppError(status.PAYMENT_REQUIRED, "No subscription is configured for this organization. Please choose a plan or contact support.", { code: reason, retryable: false });
    case "SUBSCRIPTION_EXPIRED":
      return new AppError(status.PAYMENT_REQUIRED, "Your subscription is no longer active. Please renew or resubscribe to continue.", { code: reason, retryable: false });
    case "ACTIVE":
    default:
      return new AppError(status.FORBIDDEN, "Access to this organization is currently unavailable.", { code: reason, retryable: false });
  }
}

/** Clear all cached access snapshots after a subscription mutation. */
export async function invalidateSubscriptionAccessCache(userId: string): Promise<boolean> {
  const context = await getRuntimeAdminAccessContext(userId).catch(() => null);
  const adminId = context?.adminId ?? (await prisma.adminProfile.findUnique({
    where: { userId }, select: { id: true },
  }))?.id;
  await Promise.all([
    invalidateRuntimeAdminAccessContext(userId),
    adminId ? invalidateRuntimeSubscriptionForAdmin(adminId) : Promise.resolve(),
  ]);
  if (!adminId) return true;
  // A failed epoch rotation is NOT permission to rebuild with stale access.
  if (!await TenantAccessResolver.invalidate(adminId)) return false;
  try {
    const website = await prisma.businessWebsite.findUnique({
      where: { adminId }, select: { id: true, subdomain: true,
        subdomainAliases: { select: { subdomain: true } }, domains: { select: { domain: true } } },
    });
    if (!website) return true;
    const [{ WebsiteProjectionCacheService }, { WebsiteHostResolverService }, { PublicWebsiteCacheRevalidation }] = await Promise.all([
      import("../modules/Website/websiteProjectionCache.service"),
      import("../modules/Website/websiteHostResolver.service"),
      import("../lib/outbox/publicWebsiteCacheOutbox"),
    ]);
    const [projection, labels, hosts] = await Promise.all([
      WebsiteProjectionCacheService.invalidateWebsite(website.id, adminId, { revalidateNext: false }),
      WebsiteHostResolverService.invalidateSubdomains([website.subdomain, ...website.subdomainAliases.map(a => a.subdomain)]),
      WebsiteHostResolverService.invalidateHosts(website.domains.map(d => d.domain)),
    ]);
    if (!projection.invalidated || !labels || !hosts) return false;
    const callback = await PublicWebsiteCacheRevalidation.triggerWithFallback({
      websiteId: website.id, tenantIdentifier: website.subdomain,
      tenantIdentifiers: [website.subdomain, ...website.subdomainAliases.map(a => a.subdomain), ...website.domains.map(d => d.domain)],
      reason: "subscription-access-changed",
    });
    return callback.delivered;
  } catch {
    return false;
  }
}

export const checkSubscription = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const authStarted = process.hrtime.bigint();
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) return next();
    const verified = getVerifiedAccessToken(req, accessToken);
    if (!verified.success) return next();

    let { userId, role } = verified.data as { userId: string; role: string };
    const actualUserId = userId;
    const actualRole = role;
    const requestPath = req.originalUrl ?? req.url ?? "";
    const controlPlaneRequest = requestPath.includes("/super-admin/") || requestPath.endsWith("/super-admin");
    if (actualRole === UserRole.SUPER_ADMIN && !controlPlaneRequest) {
      const supportMode = req.supportMode ?? await SupportModeService.fromRequest(req, actualUserId);
      if (supportMode) {
        req.supportMode = supportMode;
        req.supportActor = { id: actualUserId, role: UserRole.SUPER_ADMIN, email: String(verified.data.email ?? "") };
        SupportModeService.assertReadOnly(req);
        userId = supportMode.targetUserId;
        role = UserRole.ADMIN;
      }
    }
    if (role !== UserRole.ADMIN && role !== UserRole.STAFF) return next();

    const runtime = role === UserRole.ADMIN
      ? await getRuntimeAdminAccessContext(userId)
      : await getRuntimeStaffAccessContext(userId);
    if (!runtime.adminId) {
      throw new AppError(status.FORBIDDEN, "No organization is provisioned for this account.", { code: "ORGANIZATION_NOT_FOUND", retryable: false });
    }

    const resolution = await TenantAccessResolver.resolve(runtime.adminId);
    req.authRuntime = {
      userStatus: runtime.userStatus,
      adminId: resolution.organizationId,
      subscriptionPlanName: resolution.plan.name,
      subscriptionFeatures: resolution.plan.features,
      entitlementSummary: resolution.plan.features,
      effectiveEntitlements: resolution.effectiveEntitlements,
      accessDeniedReason: resolution.access.deniedReason,
    };

    if (req.supportMode) {
      if (!resolution.access.recoveryAllowed) throw accessError(resolution.access.deniedReason);
    } else if (!resolution.access.dashboardAllowed) {
      throw accessError(resolution.access.deniedReason);
    }
    next();
  } catch (error) {
    next(error);
  } finally {
    recordTraceSpan(
      "auth",
      Number(process.hrtime.bigint() - authStarted) / 1_000_000,
      "auth.subscription-gate",
    );
  }
};

/**
 * Per-route feature gate. Stable keys are preferred; legacy labels are resolved
 * only for rolling-deployment compatibility and never used as the decision key.
 */
export function checkFeature(feature: FeatureKey | string) {
  const canonicalKey = resolveFeatureKey(feature);
  if (!canonicalKey) {
    throw new Error(`Unknown feature gate '${feature}'. Add it to featureCatalog.ts before using it in a route.`);
  }

  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const accessToken = getAccessToken(req);
      if (!accessToken) return next();
      const verified = getVerifiedAccessToken(req, accessToken);
      if (!verified.success) return next();

      let { userId, role } = verified.data as { userId: string; role: string };
      const featureRequestPath = req.originalUrl ?? req.url ?? "";
      if (role === UserRole.SUPER_ADMIN && !featureRequestPath.includes("/super-admin/")) {
        const supportMode = req.supportMode ?? await SupportModeService.fromRequest(req, userId);
        if (supportMode) {
          req.supportMode = supportMode;
          req.supportActor = { id: userId, role: UserRole.SUPER_ADMIN, email: String(verified.data.email ?? "") };
          SupportModeService.assertReadOnly(req);
          userId = supportMode.targetUserId;
          role = UserRole.ADMIN;
        }
      }
      if (role !== UserRole.ADMIN) return next();

      const requestEntitlements = req.authRuntime?.effectiveEntitlements;
      if (requestEntitlements && requestEntitlements[canonicalKey] !== undefined) {
        if (requestEntitlements[canonicalKey]) return next();
      } else {
        const runtime = await getRuntimeAdminAccessContext(userId);
        if (!runtime.adminId) {
          throw new AppError(status.FORBIDDEN, "No organization is provisioned for this account.", { code: "ORGANIZATION_NOT_FOUND", retryable: false });
        }
        const resolution = await TenantAccessResolver.resolve(runtime.adminId);
        if (req.supportMode) {
          if (!resolution.access.recoveryAllowed) throw accessError(resolution.access.deniedReason);
        } else if (!resolution.access.dashboardAllowed) {
          throw accessError(resolution.access.deniedReason);
        }
        if (resolution.effectiveEntitlements[canonicalKey]) return next();
      }

      throw new AppError(
        status.FORBIDDEN,
        `Your current plan does not include this feature. Please upgrade to access it.`,
        { code: "FEATURE_NOT_INCLUDED", retryable: false },
      );
    } catch (error) {
      next(error);
    }
  };
}
