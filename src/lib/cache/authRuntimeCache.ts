import { UserRole } from "../../generated/prisma/enums";
import redis from "../../config/redis";
import { prisma } from "../prisma/prisma";
import { singleFlight } from "../utils/singleFlight";
import { BoundedTtlCache } from "./boundedTtlCache";

const statusCache = new BoundedTtlCache<string>({ maxEntries: 10_000 });
const tenantCache = new BoundedTtlCache<string | null>({ maxEntries: 10_000 });
const sessionCache = new BoundedTtlCache<boolean>({ maxEntries: 10_000 });

const STATUS_L1_TTL_MS = 30_000;
const TENANT_L1_TTL_MS = 5 * 60_000;
const SESSION_L1_TTL_MS = 30_000;
const l1Enabled = process.env.NODE_ENV !== "test";

export async function getRuntimeUserStatus(userId: string): Promise<string | null> {
  const l1 = l1Enabled ? statusCache.get(userId) : undefined;
  if (l1 !== undefined) return l1;

  const redisKey = `auth:status:${userId}`;
  const shared = await redis.get(redisKey).catch(() => null);
  if (shared) {
    if (l1Enabled) statusCache.set(userId, shared, STATUS_L1_TTL_MS);
    return shared;
  }

  const user = await singleFlight(`user-status:${userId}`, () =>
    prisma.user.findUnique({
      where: { id: userId },
      select: { status: true },
    }),
  );
  if (!user) return null;

  if (l1Enabled) statusCache.set(userId, user.status, STATUS_L1_TTL_MS);
  void redis.setex(redisKey, 60, user.status).catch(() => {});
  return user.status;
}

export async function getRuntimeTenantId(
  userId: string,
  role: UserRole,
): Promise<string | null> {
  if (role === UserRole.SUPER_ADMIN) return null;

  const localKey = `${role}:${userId}`;
  const l1 = l1Enabled ? tenantCache.get(localKey) : undefined;
  if (l1 !== undefined) return l1;

  const redisKey = `tenantId:${role}:${userId}`;
  const shared = await redis.get(redisKey).catch(() => null);
  if (shared !== null) {
    const value = shared === "__none__" ? null : shared;
    if (l1Enabled) tenantCache.set(localKey, value, TENANT_L1_TTL_MS);
    return value;
  }

  const value = await singleFlight(`tenant-id:${localKey}`, async () => {
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

  if (l1Enabled) tenantCache.set(localKey, value, TENANT_L1_TTL_MS);
  void redis.setex(redisKey, 300, value ?? "__none__").catch(() => {});
  return value;
}

export async function getRuntimeSessionValidity(token: string): Promise<boolean> {
  const l1 = l1Enabled ? sessionCache.get(token) : undefined;
  if (l1 !== undefined) return l1;

  const redisKey = `session:${token}`;
  const shared = await redis.get(redisKey).catch(() => null);
  if (shared !== null) {
    const valid = shared === "true";
    if (l1Enabled) sessionCache.set(token, valid, SESSION_L1_TTL_MS);
    return valid;
  }

  const session = await singleFlight(`session-valid:${token}`, () =>
    prisma.session.findFirst({
      where: { token, expiresAt: { gt: new Date() } },
      select: { id: true },
    }),
  );
  const valid = Boolean(session);
  if (l1Enabled) sessionCache.set(token, valid, SESSION_L1_TTL_MS);
  void redis.setex(redisKey, 60, valid ? "true" : "false").catch(() => {});
  return valid;
}

export function invalidateRuntimeAuth(userId: string): void {
  statusCache.delete(userId);
  tenantCache.delete(`${UserRole.ADMIN}:${userId}`);
  tenantCache.delete(`${UserRole.STAFF}:${userId}`);
}
