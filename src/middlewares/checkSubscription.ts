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
import redis from "../config/redis";

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
// This single helper now backs both gates: one Redis-cached payload (60s
// TTL) per user, containing everything either gate needs, including the
// plan's feature list. This cuts checkFeature from 2 uncached queries per
// request down to a Redis GET on the (very common) cache-hit path.
type CachedSubscriptionPayload = {
  adminId: string | null;
  status: string | null;
  isTrial: boolean | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean | null;
  features: string[];
} | null; // null = admin has no subscription/profile at all → both gates just call next()

// PERF FIX: Increased from 60s to 300s — subscription status changes rarely.
// When it does change (upgrade/downgrade/cancel), the relevant service
// manually invalidates this key via redis.del(subscriptionCacheKey(userId)).
const SUBSCRIPTION_CACHE_TTL_SECONDS = 300;
const subscriptionCacheKey = (userId: string) => `sub:full:user:${userId}`;

async function getCachedSubscriptionForUser(
  userId: string,
): Promise<CachedSubscriptionPayload> {
  const cached = await redis
    .get(subscriptionCacheKey(userId))
    .catch(() => null);

  if (cached !== null) {
    try {
      return JSON.parse(cached) as CachedSubscriptionPayload;
    } catch {
      // fall through and reload from DB on a corrupt cache entry
    }
  }

  const admin = await prisma.adminProfile.findFirst({
    where: { userId },
    select: { id: true },
  });

  let payload: CachedSubscriptionPayload = null;

  if (admin) {
    const sub = await prisma.subscription.findFirst({
      where: { adminId: admin.id },
      select: {
        status: true,
        isTrial: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        subscriptionPlan: { select: { features: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    if (sub) {
      payload = {
        adminId: admin.id,
        status: sub.status,
        isTrial: sub.isTrial,
        trialEndsAt: sub.trialEndsAt ? sub.trialEndsAt.toISOString() : null,
        currentPeriodEnd: sub.currentPeriodEnd
          ? sub.currentPeriodEnd.toISOString()
          : null,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        features: sub.subscriptionPlan?.features ?? [],
      };
    }
  }

  await redis
    .setex(
      subscriptionCacheKey(userId),
      SUBSCRIPTION_CACHE_TTL_SECONDS,
      JSON.stringify(payload),
    )
    .catch(() => {});

  return payload;
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

    let userStatus: string | null = await redis
      .get(`auth:status:${userId}`)
      .catch(() => null);

    if (!userStatus) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { status: true },
      });
      if (user) {
        userStatus = user.status;
        await redis
          .setex(`auth:status:${userId}`, 60, user.status)
          .catch(() => {});
      }
    }

    if (userStatus === AccountStatus.SUSPENDED)
      throw new AppError(
        status.FORBIDDEN,
        "Your account has been suspended. Please contact support.",
      );
    if (userStatus === AccountStatus.DELETED)
      throw new AppError(status.FORBIDDEN, "This account has been deleted.");

    // ── Subscription lookup (shared Redis-cached loader, 60s TTL) ────────
    const sub = await getCachedSubscriptionForUser(userId);
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

      // PERF FIX (Phase 1.3): was two uncached DB queries (adminProfile +
      // subscription join) on every request to a feature-gated route.
      // Now shares the same 60s Redis-cached payload as checkSubscription.
      const sub = await getCachedSubscriptionForUser(userId);
      if (!sub) return next();

      const includedRaw = sub.features ?? [];
      const included = includedRaw.map((f) => {
        try {
          return JSON.parse(f) as {
            label: string;
            included: boolean;
          };
        } catch {
          return { label: f, included: true };
        }
      });
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
