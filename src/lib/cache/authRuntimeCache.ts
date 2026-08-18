import { UserRole } from "../../generated/prisma/enums";
import redis from "../../config/redis";
import { prisma } from "../prisma/prisma";
import { singleFlight } from "../utils/singleFlight";
import { normalizeSubscriptionPlanFeatures, type SubscriptionPlanFeature } from "../utils/subscriptionPlanFeatures";
import { CacheNamespaces, CacheTtl, ttlForKey } from "./cachePolicy";

export interface RuntimeAdminSubscription {
  status: string;
  planId: string | null;
  planName: string | null;
  isTrial: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  features: unknown;
}

export interface RuntimeAdminAccessContext {
  role: UserRole.ADMIN;
  userStatus: string | null;
  adminId: string | null;
  subscription: RuntimeAdminSubscription | null;
  entitlementSummary: SubscriptionPlanFeature[];
}

export interface RuntimeStaffAccessContext {
  role: UserRole.STAFF;
  userStatus: string | null;
  adminId: string | null;
}

const LEGACY_CONTEXT_TTL_SECONDS = 300;
const adminContextKey = CacheNamespaces.authContext;
const staffContextKey = CacheNamespaces.authContext;
const userStatusKey = (userId: string) => `auth:status:${userId}`;
const tenantIdKey = (role: UserRole, userId: string) => `tenantId:${role}:${userId}`;
const subscriptionKey = CacheNamespaces.subscription;

const parseAdminContext = (raw: string): RuntimeAdminAccessContext | null => {
  try {
    const value = JSON.parse(raw) as RuntimeAdminAccessContext;
    if (!value || typeof value !== "object") return null;
    return value;
  } catch {
    return null;
  }
};

/**
 * Cold-path ADMIN auth loader.
 *
 * Before this loader, an expired Redis cache could cause three sequential
 * cross-region queries before the controller ran: User status -> AdminProfile
 * -> latest Subscription. This resolves the same information through one
 * Prisma relation query and primes the legacy cache keys used by the rest of
 * the app. Warm requests are a single Redis GET.
 */
export async function getRuntimeAdminAccessContext(userId: string): Promise<RuntimeAdminAccessContext> {
  const key = adminContextKey(userId);
  const shared = await redis.get(key).catch(() => null);
  if (shared) {
    const parsed = parseAdminContext(shared);
    if (parsed?.role === UserRole.ADMIN) return parsed;
  }

  return singleFlight(`admin-access-context:${userId}`, async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        admin: {
          select: {
            id: true,
            subscription: {
              orderBy: { createdAt: "desc" },
              take: 1,
              select: {
                status: true,
                isTrial: true,
                trialEndsAt: true,
                currentPeriodEnd: true,
                cancelAtPeriodEnd: true,
                subscriptionPlan: { select: { id: true, name: true, features: true } },
              },
            },
          },
        },
      },
    });

    const latest = user?.admin?.subscription?.[0] ?? null;
    const normalizedFeatures = normalizeSubscriptionPlanFeatures(latest?.subscriptionPlan?.features ?? []);
    const context: RuntimeAdminAccessContext = {
      role: UserRole.ADMIN,
      userStatus: user?.status ?? null,
      adminId: user?.admin?.id ?? null,
      subscription: latest
        ? {
            status: latest.status,
            planId: latest.subscriptionPlan?.id ?? null,
            planName: latest.subscriptionPlan?.name ?? null,
            isTrial: latest.isTrial,
            trialEndsAt: latest.trialEndsAt?.toISOString() ?? null,
            currentPeriodEnd: latest.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: latest.cancelAtPeriodEnd,
            features: latest.subscriptionPlan?.features ?? [],
          }
        : null,
      entitlementSummary: normalizedFeatures,
    };

    const writes: Promise<unknown>[] = [
      redis.setex(key, ttlForKey(CacheTtl.authContext, key), JSON.stringify(context)),
    ];
    if (context.adminId && context.subscription) {
      const subKey = subscriptionKey(context.adminId);
      writes.push(
        redis.setex(
          subKey,
          ttlForKey(CacheTtl.subscription, subKey),
          JSON.stringify(context.subscription),
        ),
      );
    }
    if (context.userStatus) {
      writes.push(redis.setex(userStatusKey(userId), LEGACY_CONTEXT_TTL_SECONDS, context.userStatus));
    }
    writes.push(
      redis.setex(
        tenantIdKey(UserRole.ADMIN, userId),
        300,
        context.adminId ?? "__none__",
      ),
    );
    // Cold requests should leave the shared TenantContext fully primed before
    // downstream entitlement/services run. Redis failure is still fail-open.
    await Promise.all(writes).catch(() => []);

    return context;
  });
}

export async function getRuntimeStaffAccessContext(userId: string): Promise<RuntimeStaffAccessContext> {
  const key = staffContextKey(userId);
  const shared = await redis.get(key).catch(() => null);
  if (shared) {
    try {
      const parsed = JSON.parse(shared) as RuntimeStaffAccessContext;
      if (parsed?.role === UserRole.STAFF) return parsed;
    } catch {
      // reload below
    }
  }

  return singleFlight(`staff-access-context:${userId}`, async () => {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        status: true,
        staff: { select: { adminId: true } },
      },
    });
    const context: RuntimeStaffAccessContext = {
      role: UserRole.STAFF,
      userStatus: user?.status ?? null,
      adminId: user?.staff?.adminId ?? null,
    };

    const writes: Promise<unknown>[] = [
      redis.setex(key, ttlForKey(CacheTtl.authContext, key), JSON.stringify(context)),
      redis.setex(tenantIdKey(UserRole.STAFF, userId), 300, context.adminId ?? "__none__"),
    ];
    if (context.userStatus) {
      writes.push(redis.setex(userStatusKey(userId), LEGACY_CONTEXT_TTL_SECONDS, context.userStatus));
    }
    await Promise.all(writes).catch(() => []);
    return context;
  });
}

export async function getRuntimeUserStatus(userId: string): Promise<string | null> {
  const redisKey = userStatusKey(userId);
  const shared = await redis.get(redisKey).catch(() => null);
  if (shared) return shared;

  const user = await singleFlight(`user-status:${userId}`, () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    }),
  );
  if (!user) return null;

  void redis.setex(redisKey, 60, user.status).catch(() => {});
  return user.status;
}

export async function getRuntimeTenantId(
  userId: string,
  role: UserRole,
): Promise<string | null> {
  if (role === UserRole.SUPER_ADMIN) return null;

  const redisKey = tenantIdKey(role, userId);
  const shared = await redis.get(redisKey).catch(() => null);
  if (shared !== null) {
    return shared === "__none__" ? null : shared;
  }

  // ADMIN callers get the combined cold-path query instead of another
  // standalone profile lookup.
  if (role === UserRole.ADMIN) {
    return (await getRuntimeAdminAccessContext(userId)).adminId;
  }

  if (role === UserRole.STAFF) {
    return (await getRuntimeStaffAccessContext(userId)).adminId;
  }

  return null;
}

export async function getRuntimeTenantOwnerStatus(adminId: string): Promise<string | null> {
  const redisKey = `auth:tenant-owner-status:${adminId}`;
  const shared = await redis.get(redisKey).catch(() => null);
  if (shared) return shared;

  const admin = await singleFlight(`tenant-owner-status:${adminId}`, () =>
    prisma.adminProfile.findUnique({
      where: { id: adminId },
      select: { user: { select: { status: true } } },
    }),
  );
  const ownerStatus = admin?.user.status ?? null;
  if (ownerStatus) void redis.setex(redisKey, 60, ownerStatus).catch(() => {});
  return ownerStatus;
}

export function invalidateRuntimeTenantOwnerStatus(adminId: string | null | undefined): void {
  if (!adminId) return;
  void redis.del(`auth:tenant-owner-status:${adminId}`).catch(() => {});
}

export async function getRuntimeSessionValidity(token: string): Promise<boolean> {
  const redisKey = `session:${token}`;
  const shared = await redis.get(redisKey).catch(() => null);
  if (shared !== null) return shared === "true";

  const session = await singleFlight(`session-valid:${token}`, () =>
    prisma.session.findFirst({
      where: { token, expiresAt: { gt: new Date() } },
      select: { id: true },
    }),
  );
  const valid = Boolean(session);
  void redis.setex(redisKey, 60, valid ? "true" : "false").catch(() => {});
  return valid;
}


export async function getRuntimeSubscriptionForAdmin(adminId: string): Promise<RuntimeAdminSubscription | null> {
  const key = subscriptionKey(adminId);
  const raw = await redis.get(key).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as RuntimeAdminSubscription;
  } catch {
    void redis.del(key).catch(() => {});
    return null;
  }
}

export async function cacheRuntimeSubscriptionForAdmin(
  adminId: string,
  subscription: RuntimeAdminSubscription,
): Promise<void> {
  const key = subscriptionKey(adminId);
  await redis
    .setex(key, ttlForKey(CacheTtl.subscription, key), JSON.stringify(subscription))
    .catch(() => {});
}

export async function invalidateRuntimeSubscriptionForAdmin(adminId: string): Promise<void> {
  await redis.del(subscriptionKey(adminId), CacheNamespaces.entitlements(adminId)).catch(() => {});
}

export function invalidateRuntimeAuth(userId: string): void {
  void redis
    .del(
      userStatusKey(userId),
      tenantIdKey(UserRole.ADMIN, userId),
      tenantIdKey(UserRole.STAFF, userId),
      adminContextKey(userId),
      staffContextKey(userId),
    )
    .catch(() => {});
}

export async function invalidateRuntimeAdminAccessContext(userId: string): Promise<void> {
  await redis.del(adminContextKey(userId)).catch(() => {});
}
