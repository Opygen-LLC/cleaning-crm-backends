import redis from "../../config/redis";

export const followUpVersionKey = (adminId: string) => `followups:ver:${adminId}`;
export const adminTimezoneCacheKey = (adminId: string) => `admin:tz:${adminId}`;

/**
 * Versioned invalidation avoids scanning/deleting every cached filter variant.
 * Every follow-up write path must call this after its transaction commits.
 */
export const invalidateFollowUpsCache = async (adminId: string): Promise<void> => {
  await redis.incr(followUpVersionKey(adminId)).catch(() => {});
};

/** Business timezone is cached separately from the profile read model. */
export const invalidateAdminTimezoneCache = async (adminId: string): Promise<void> => {
  await redis.del(adminTimezoneCacheKey(adminId)).catch(() => {});
};
