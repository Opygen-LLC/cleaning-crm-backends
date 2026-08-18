/**
 * checkSubscription.ts  — Phase 1 Production Version
 *
 * Two layers of enforcement:
 *  1. STATUS GATE: blocks ADMIN users whose subscription is EXPIRED/SUSPENDED/PENDING_PAYMENT
 *  2. FEATURE GATE: checkFeature(featureKey) middleware factory for per-route feature locking
 *
 * STAFF and SUPER_ADMIN are exempt from both gates.
 */

import { NextFunction, Request, Response } from "express";
import status from "http-status";
import { AccountStatus, UserRole } from "../generated/prisma/enums";
import { prisma } from "../lib/prisma/prisma";
import AppError from "../errorHelper/AppError";
import { getVerifiedAccessToken } from "../lib/utils/verifiedRequestToken";
import { CookieUtils } from "../lib/utils/cookie";
import {
  normalizeSubscriptionPlanFeatures,
  type SubscriptionPlanFeature,
} from "../lib/utils/subscriptionPlanFeatures";
import {
  getRuntimeAdminAccessContext,
  invalidateRuntimeAdminAccessContext,
  invalidateRuntimeSubscriptionForAdmin,
  type RuntimeAdminAccessContext,
} from "../lib/cache/authRuntimeCache";

function getAccessToken(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer "))
    return authHeader.slice("Bearer ".length).trim();
  return CookieUtils.getCookie(req, "accessToken");
}

// ─── Shared cached subscription + plan loader ─────────────────────────────────
//
// PERF FIX (Phase 1.3): checkSubscription (the status gate, mounted at router
// level) and checkFeature (mounted per-route) used to each independently:
//   1. look up the admin profile for the user, and
//   2. look up the subscription (checkFeature additionally joined the plan)
// on every single request — checkFeature had NO caching at all, unlike the
// status gate below, so every hit on a feature-gated route (auto-dispatch,
// coupons, recurring bookings, ...) paid for two uncached DB round-trips.
//
// Both gates now reuse the Redis TenantContext (`auth-context:{userId}`).
// It contains tenant ownership plus the latest subscription/feature snapshot,
// so the common path is one Redis read shared across the request instead of
// repeated user/profile/subscription queries.
type CachedSubscriptionPayload = {
  adminId: string | null;
  status: string | null;
  isTrial: boolean | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean | null;
  features: SubscriptionPlanFeature[];
} | null; // null = admin has no subscription/profile at all → both gates just call next()

/** Clear the status/feature snapshot after an approved/cancelled plan mutation. */
export async function invalidateSubscriptionAccessCache(userId: string) {
  // Capture the tenant id before clearing auth-context so invalidation never
  // performs a second profile lookup on the mutation path.
  const accessContext = await getRuntimeAdminAccessContext(userId).catch(() => null);
  await Promise.all([
    invalidateRuntimeAdminAccessContext(userId),
    accessContext?.adminId
      ? invalidateRuntimeSubscriptionForAdmin(accessContext.adminId)
      : Promise.resolve(),
  ]);

  // Website entitlements are evaluated from the live subscription on public
  // projection/host cache misses. Any plan/status mutation must therefore drop
  // those caches immediately so a downgrade cannot keep premium domains,
  // templates or SEO alive until TTL expiry.
  try {
    const adminId = accessContext?.adminId ?? null;
    if (!adminId) return;
    const website = await prisma.businessWebsite.findUnique({
      where: { adminId },
      select: {
        id: true,
        subdomain: true,
        subdomainAliases: { select: { subdomain: true } },
        domains: { select: { domain: true } },
      },
    });
    if (!website) return;
    const [{ WebsiteProjectionCacheService }, { WebsiteHostResolverService }] = await Promise.all([
      import("../modules/Website/websiteProjectionCache.service"),
      import("../modules/Website/websiteHostResolver.service"),
    ]);
    await Promise.all([
      WebsiteProjectionCacheService.invalidateWebsite(website.id),
      WebsiteHostResolverService.invalidateSubdomains([
        website.subdomain,
        ...website.subdomainAliases.map((alias) => alias.subdomain),
      ]),
      WebsiteHostResolverService.invalidateHosts(website.domains.map((domain) => domain.domain)),
    ]);
  } catch {
    // Subscription state in Postgres is authoritative. Cache invalidation is
    // best-effort; versioned/short TTL public caches self-heal if Redis is down.
  }
}

const subscriptionFromContext = (context: RuntimeAdminAccessContext): CachedSubscriptionPayload => {
  if (!context.adminId || !context.subscription) return null;
  return {
    adminId: context.adminId,
    status: context.subscription.status,
    isTrial: context.subscription.isTrial,
    trialEndsAt: context.subscription.trialEndsAt,
    currentPeriodEnd: context.subscription.currentPeriodEnd,
    cancelAtPeriodEnd: context.subscription.cancelAtPeriodEnd,
    features: normalizeSubscriptionPlanFeatures(context.subscription.features ?? []),
  };
};

async function getCachedSubscriptionForUser(
  userId: string,
): Promise<CachedSubscriptionPayload> {
  // Standalone feature gates reuse the same Redis-backed TenantContext as
  // checkSubscription. No parallel user-scoped subscription namespace is
  // maintained anymore.
  return subscriptionFromContext(await getRuntimeAdminAccessContext(userId));
}

// ─── Status gate (mounted at router level) ────────────────────────────────────
export const checkSubscription = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const accessToken = getAccessToken(req);
    if (!accessToken) return next();

    // PERF FIX (Phase 1.4): shared per-request verification cache — see
    // src/lib/utils/verifiedRequestToken.ts. checkSubscription is the
    // first gate to run on gated routes, so this is normally the call
    // that performs the actual jwt.verify(); checkAuth/checkFeature
    // reuse the cached result afterwards instead of re-verifying.
    const verified = getVerifiedAccessToken(req, accessToken);
    if (!verified.success) return next();

    const { userId, role } = verified.data as {
      userId: string;
      role: string;
    };
    if (role !== UserRole.ADMIN) return next();

    // One warm Redis GET / one cold joined DB query resolves status, tenant and
    // subscription together. This removes the previous sequential
    // status -> AdminProfile -> Subscription round trips.
    const accessContext = await getRuntimeAdminAccessContext(userId);
    const userStatus = accessContext.userStatus;
    const sub = subscriptionFromContext(accessContext);
    req.authRuntime = {
      userStatus,
      adminId: accessContext.adminId,
      subscriptionPlanName: accessContext.subscription?.planName ?? null,
      subscriptionFeatures: sub?.features ?? null,
      entitlementSummary: accessContext.entitlementSummary,
    };


    if (userStatus === AccountStatus.SUSPENDED)
      throw new AppError(
        status.FORBIDDEN,
        "Your account has been suspended. Please contact support.",
        { code: "ACCOUNT_SUSPENDED", retryable: false },
      );
    if (userStatus === AccountStatus.DELETED)
      throw new AppError(status.FORBIDDEN, "This account has been deleted.");

    // ── Subscription lookup ──────────────────────────────────────────────
    if (!sub) return next();

    const now = new Date();
    const trialEnd = sub.trialEndsAt ? new Date(sub.trialEndsAt) : null;
    const periodEnd = sub.currentPeriodEnd
      ? new Date(sub.currentPeriodEnd)
      : null;

    if (sub.status === "SUSPENDED")
      throw new AppError(
        status.PAYMENT_REQUIRED,
        "Your account has been suspended. Please contact support or submit a payment proof.",
      );

    if (sub.status === "EXPIRED")
      throw new AppError(
        status.PAYMENT_REQUIRED,
        "Your subscription has expired. Please renew to continue using the platform.",
      );
    if (sub.status === "PENDING_PAYMENT")
      throw new AppError(
        status.PAYMENT_REQUIRED,
        "Your payment proof is under review. Your account will be reactivated once approved.",
      );
    // BUGFIX: CANCELLED was never checked here. superAdmin.service.ts'
    // cancelSubscription() sets status: CANCELLED immediately (no grace
    // period) — that's distinct from cancelAtPeriodEnd (self-serve
    // cancellation, which keeps status ACTIVE until currentPeriodEnd).
    // Without this branch a super-admin-cancelled subscription kept full
    // API access forever even though the frontend's useGateMap already
    // treats "Cancelled" as hasActiveAccess === false, so the sidebar
    // showed everything locked while the API happily served requests.
    if (sub.status === "CANCELLED")
      throw new AppError(
        status.PAYMENT_REQUIRED,
        "Your subscription has been cancelled. Please subscribe to a plan to continue using the platform.",
      );
    if (sub.isTrial && trialEnd && trialEnd < now)
      throw new AppError(
        status.PAYMENT_REQUIRED,
        "Your free trial has ended. Please upgrade to continue.",
      );
    if (!sub.isTrial && periodEnd && periodEnd < now)
      throw new AppError(
        status.PAYMENT_REQUIRED,
        sub.cancelAtPeriodEnd
          ? "Your subscription was cancelled and your billing period has ended. Please resubscribe to continue."
          : "Your billing period has ended. Please renew your subscription.",
      );

    next();
  } catch (error) {
    next(error);
  }
};

// ─── Feature gate middleware factory (per-route) ──────────────────────────────
/**
 * checkFeature("auto-dispatch")
 *
 * Returns Express middleware that returns 403 if the admin's plan does not
 * include the given feature string (case-insensitive, normalised).
 *
 * Usage:
 *   router.post("/:id/dispatch", checkAuth(UserRole.ADMIN), checkFeature("auto-dispatch"), jobDispatchController.dispatchJob);
 *   router.post("/",             checkAuth(UserRole.ADMIN), checkFeature("coupons"),       couponController.create);
 *   router.get("/",              checkAuth(UserRole.ADMIN), checkFeature("recurring bookings"), recurringBookingController.getAll);
 */
export function checkFeature(featureKey: string) {
  // NOTE: .trim() must run again *after* the replace, not just before it.
  // A featureKey with leading/trailing punctuation (e.g. "Auto-Dispatch!")
  // gets that punctuation collapsed into a boundary space by the regex
  // (-> "auto dispatch "), which then fails to match a cleanly-normalised
  // plan label ("auto dispatch") and silently locks a paying admin out of
  // a feature their plan includes. Caught by the middleware's own test
  // suite (see checkSubscription.test.ts — "normalises punctuation").
  const normKey = featureKey
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const accessToken = getAccessToken(req);
      if (!accessToken) return next();

      // PERF FIX (Phase 1.4): reuses the same per-request cached
      // verification result as checkSubscription/checkAuth instead of
      // calling jwt.verify() a third time for this request.
      const verified = getVerifiedAccessToken(req, accessToken);
      if (!verified.success) return next();

      const { userId, role } = verified.data as {
        userId: string;
        role: string;
      };
      if (role !== UserRole.ADMIN) return next();

      // checkSubscription runs first on gated routes and already attached the
      // feature list to this request. Reuse it instead of issuing a second
      // Redis command; retain the cached fallback for standalone middleware use.
      const requestFeatures = req.authRuntime?.subscriptionFeatures;
      const sub = requestFeatures !== undefined
        ? { features: requestFeatures }
        : await getCachedSubscriptionForUser(userId);
      if (!sub) return next();

      // Product invariant: Online Booking is part of the website acquisition
      // core on every active plan. Older production STARTER rows may still
      // contain the historical `included: false` flag, so do not let stale
      // plan JSON lock the booking engine after this rollout.
      if (normKey === "online booking") return next();

      const included = normalizeSubscriptionPlanFeatures(sub.features ?? []);
      const hasFeature = included.some(
        (f) =>
          f.included &&
          f.label
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .trim() === normKey,
      );

      if (!hasFeature) {
        throw new AppError(
          status.FORBIDDEN,
          `Your current plan does not include '${featureKey}'. Please upgrade to access this feature.`,
        );
      }
      next();
    } catch (error) {
      next(error);
    }
  };
}
