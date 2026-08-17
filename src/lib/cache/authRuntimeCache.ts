import { UserRole } from "../../generated/prisma/enums";
import redis from "../../config/redis";
import { prisma } from "../prisma/prisma";
import { singleFlight } from "../utils/singleFlight";

export interface RuntimeAdminSubscription {
  status: string;
  isTrial: boolean;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  features: unknown;
}

export interface RuntimeAdminAccessContext {
  userStatus: string | null;
  adminId: string | null;
  subscription: RuntimeAdminSubscription | null;
}

export interface RuntimeStaffAccessContext {
  userStatus: string | null;
  adminId: string | null;
}

const ADMIN_CONTEXT_TTL_SECONDS = 60;
const STAFF_CONTEXT_TTL_SECONDS = 60;
const adminContextKey = (userId: string) => `auth:admin-context:v1:${userId}`;
const staffContextKey = (userId: string) => `auth:staff-context:v1:${userId}`;
const userStatusKey = (userId: string) => `auth:status:${userId}`;
const tenantIdKey = (role: UserRole, userId: string) => `tenantId:${role}:${userId}`;

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
    if (parsed) return parsed;
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
                subscriptionPlan: { select: { features: true } },
              },
            },
          },
        },
      },
    });

    const latest = user?.admin?.subscription?.[0] ?? null;
    const context: RuntimeAdminAccessContext = {
      userStatus: user?.status ?? null,
      adminId: user?.admin?.id ?? null,
      subscription: latest
        ? {
            status: latest.status,
            isTrial: latest.isTrial,
            trialEndsAt: latest.trialEndsAt?.toISOString() ?? null,
            currentPeriodEnd: latest.currentPeriodEnd?.toISOString() ?? null,
            cancelAtPeriodEnd: latest.cancelAtPeriodEnd,
            features: latest.subscriptionPlan?.features ?? [],
          }
        : null,
    };

    const writes: Promise<unknown>[] = [
      redis.setex(key, ADMIN_CONTEXT_TTL_SECONDS, JSON.stringify(context)),
    ];
    if (context.userStatus) {
      writes.push(redis.setex(userStatusKey(userId), ADMIN_CONTEXT_TTL_SECONDS, context.userStatus));
    }
    writes.push(
      redis.setex(
        tenantIdKey(UserRole.ADMIN, userId),
        300,
        context.adminId ?? "__none__",
      ),
    );
    void Promise.all(writes).catch(() => {});

    return context;
  });
}

export async function getRuntimeStaffAccessContext(userId: string): Promise<RuntimeStaffAccessContext> {
  const key = staffContextKey(userId);
  const shared = await redis.get(key).catch(() => null);
  if (shared) {
    try {
      return JSON.parse(shared) as RuntimeStaffAccessContext;
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
      userStatus: user?.status ?? null,
      adminId: user?.staff?.adminId ?? null,
    };

    const writes: Promise<unknown>[] = [
      redis.setex(key, STAFF_CONTEXT_TTL_SECONDS, JSON.stringify(context)),
      redis.setex(tenantIdKey(UserRole.STAFF, userId), 300, context.adminId ?? "__none__"),
    ];
    if (context.userStatus) {
      writes.push(redis.setex(userStatusKey(userId), STAFF_CONTEXT_TTL_SECONDS, context.userStatus));
    }
    void Promise.all(writes).catch(() => {});
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
