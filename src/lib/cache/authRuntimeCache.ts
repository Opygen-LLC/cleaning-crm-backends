import { UserRole } from "../../generated/prisma/enums";
import redis from "../../config/redis";
import { prisma } from "../prisma/prisma";
import { singleFlight } from "../utils/singleFlight";

export async function getRuntimeUserStatus(userId: string): Promise<string | null> {
  const redisKey = `auth:status:${userId}`;
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

  const redisKey = `tenantId:${role}:${userId}`;
  const shared = await redis.get(redisKey).catch(() => null);
  if (shared !== null) {
    return shared === "__none__" ? null : shared;
  }

  const value = await singleFlight(`tenant-id:${role}:${userId}`, async () => {
    if (role === UserRole.STAFF) {
      const staff = await prisma.staffProfile.findUnique({
        where: { userId },
        select: { adminId: true },
      });
      return staff?.adminId ?? null;
    }

    const admin = await prisma.adminProfile.findFirst({
      where: { userId },
      select: { id: true },
    });
    return admin?.id ?? null;
  });

  void redis.setex(redisKey, 300, value ?? "__none__").catch(() => {});
  return value;
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
      `auth:status:${userId}`,
      `tenantId:${UserRole.ADMIN}:${userId}`,
      `tenantId:${UserRole.STAFF}:${userId}`,
    )
    .catch(() => {});
}
