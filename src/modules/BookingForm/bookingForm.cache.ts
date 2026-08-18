import redis from "../../config/redis";
import { CacheNamespaces, CacheTtl, ttlForKey } from "../../lib/cache/cachePolicy";

const adminIndexKey = (adminId: string) => `booking-form-index:${adminId}`;

export async function getCachedBookingForm<T>(formId: string): Promise<T | null> {
  const key = CacheNamespaces.bookingForm(formId);
  const raw = await redis.get(key).catch(() => null);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    void redis.del(key).catch(() => {});
    return null;
  }
}

export function cacheBookingForm(adminId: string, formId: string, value: unknown): void {
  const key = CacheNamespaces.bookingForm(formId);
  const ttl = ttlForKey(CacheTtl.bookingForm, key);
  void Promise.all([
    redis.setex(key, ttl, JSON.stringify(value)),
    redis.sadd(adminIndexKey(adminId), key),
    redis.expire(adminIndexKey(adminId), Math.max(900, ttl * 3)),
  ]).catch(() => {});
}

export async function invalidateBookingForm(formId: string): Promise<void> {
  await redis.del(CacheNamespaces.bookingForm(formId)).catch(() => {});
}

export async function invalidateBookingFormsForAdmin(adminId: string): Promise<void> {
  const index = adminIndexKey(adminId);
  const keys = await redis.smembers(index).catch(() => [] as string[]);
  if (keys.length) await redis.unlink(...keys).catch(() => {});
  await redis.del(index).catch(() => {});
}
