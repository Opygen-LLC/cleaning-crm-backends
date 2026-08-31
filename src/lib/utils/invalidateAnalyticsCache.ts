import { bumpCacheResourceVersions, CacheResource } from "../cache/resourceCacheVersion";

/**
 * Backward-compatible analytics invalidation hook used by older services.
 * Phase 3 replaces Redis SCAN/UNLINK loops with O(1) resource generation
 * bumps. Controllers on freshness-critical mutation paths await their own
 * exact bumps before responding; this helper keeps older job/background paths
 * coherent without keyspace scans.
 */
export const invalidateAnalyticsCache = (adminId: string): void => {
  void bumpCacheResourceVersions(adminId, [CacheResource.dashboard, CacheResource.reports]);
};
