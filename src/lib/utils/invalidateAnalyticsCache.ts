import redis from "../../config/redis";
import logger from "../logger";

/**
 * Removes derived dashboard/report entries after a write. It intentionally
 * runs outside the mutation's critical path; Redis is only a cache and a
 * cache outage must never turn a successful database write into an error.
 */
export const invalidateAnalyticsCache = (adminId: string): void => {
  void (async () => {
    const patterns = [
      `dashboard:overview:${adminId}:*`,
      `dashboard:revenue:${adminId}:*`,
      `reports:*:${adminId}:*`,
    ];

    for (const pattern of patterns) {
      let cursor = "0";
      do {
        const [next, keys] = await redis.scan(
          cursor,
          "MATCH",
          pattern,
          "COUNT",
          100,
        );
        cursor = next;
        if (keys.length) await redis.unlink(...keys);
      } while (cursor !== "0");
    }
  })().catch((error) => {
    logger.warn(
      `[CACHE] Analytics invalidation skipped for admin ${adminId}: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
};
