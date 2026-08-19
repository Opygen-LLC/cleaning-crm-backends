import { createHash } from "node:crypto";

const MAX_SAMPLES_PER_BUCKET = 512;
const MAX_ROUTE_BUCKETS = 250;
const MAX_QUERY_BUCKETS = 200;

type SampleBucket = {
  samples: number[];
  count: number;
  errors: number;
  totalMs: number;
  maxMs: number;
  lastSeenAt: number;
};

type QueryBucket = SampleBucket & { fingerprint: string; sample: string };
type RedisStats = { reads: number; hits: number; misses: number; errors: number; totalMs: number; samples: number[] };

const routes = new Map<string, SampleBucket>();
const queries = new Map<string, QueryBucket>();
const database: SampleBucket = { samples: [], count: 0, errors: 0, totalMs: 0, maxMs: 0, lastSeenAt: Date.now() };
const redis: RedisStats = { reads: 0, hits: 0, misses: 0, errors: 0, totalMs: 0, samples: [] };

const pushSample = (samples: number[], value: number) => {
  samples.push(Math.max(0, value));
  if (samples.length > MAX_SAMPLES_PER_BUCKET) samples.splice(0, samples.length - MAX_SAMPLES_PER_BUCKET);
};
const percentile = (samples: number[], p: number): number => {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[index]! * 10) / 10;
};
const average = (total: number, count: number) => count > 0 ? Math.round((total / count) * 10) / 10 : 0;
const evictOldest = <T extends { lastSeenAt: number }>(map: Map<string, T>, max: number) => {
  if (map.size < max) return;
  let oldestKey: string | null = null;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, bucket] of map.entries()) if (bucket.lastSeenAt < oldestAt) { oldestAt = bucket.lastSeenAt; oldestKey = key; }
  if (oldestKey) map.delete(oldestKey);
};
const summarizeBucket = (bucket: SampleBucket) => ({
  count: bucket.count,
  errors: bucket.errors,
  avgMs: average(bucket.totalMs, bucket.count),
  p50Ms: percentile(bucket.samples, 50),
  p95Ms: percentile(bucket.samples, 95),
  p99Ms: percentile(bucket.samples, 99),
  maxMs: Math.round(bucket.maxMs * 10) / 10,
});
const normalizeQuery = (query: string) => query.replace(/\s+/g, " ").trim();

export const recordRequestMetric = (input: { method: string; route: string; statusCode: number; durationMs: number }): void => {
  const key = `${input.method.toUpperCase()} ${input.route}`;
  let bucket = routes.get(key);
  if (!bucket) {
    evictOldest(routes, MAX_ROUTE_BUCKETS);
    bucket = { samples: [], count: 0, errors: 0, totalMs: 0, maxMs: 0, lastSeenAt: Date.now() };
    routes.set(key, bucket);
  }
  bucket.count += 1; if (input.statusCode >= 500) bucket.errors += 1; bucket.totalMs += input.durationMs;
  bucket.maxMs = Math.max(bucket.maxMs, input.durationMs); bucket.lastSeenAt = Date.now(); pushSample(bucket.samples, input.durationMs);
};

export const recordDatabaseQueryMetric = (durationMs: number, query?: string): void => {
  database.count += 1; database.totalMs += durationMs; database.maxMs = Math.max(database.maxMs, durationMs); database.lastSeenAt = Date.now(); pushSample(database.samples, durationMs);
  if (!query) return;
  const normalized = normalizeQuery(query);
  const fingerprint = createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  let bucket = queries.get(fingerprint);
  if (!bucket) {
    evictOldest(queries, MAX_QUERY_BUCKETS);
    bucket = { fingerprint, sample: normalized.slice(0, 220), samples: [], count: 0, errors: 0, totalMs: 0, maxMs: 0, lastSeenAt: Date.now() };
    queries.set(fingerprint, bucket);
  }
  bucket.count += 1; bucket.totalMs += durationMs; bucket.maxMs = Math.max(bucket.maxMs, durationMs); bucket.lastSeenAt = Date.now(); pushSample(bucket.samples, durationMs);
};

export const recordRedisReadMetric = (input: { durationMs: number; hits: number; misses: number; error?: boolean }): void => {
  redis.reads += input.hits + input.misses || 1; redis.hits += input.hits; redis.misses += input.misses;
  if (input.error) redis.errors += 1; redis.totalMs += input.durationMs; pushSample(redis.samples, input.durationMs);
};

export const getPerformanceSnapshot = () => {
  const routeMetrics = Array.from(routes.entries()).map(([route, bucket]) => ({ route, ...summarizeBucket(bucket) })).sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count);
  const queryMetrics = Array.from(queries.values()).map((bucket) => ({ fingerprint: bucket.fingerprint, sample: bucket.sample, ...summarizeBucket(bucket) })).sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count);
  const redisAttempts = redis.hits + redis.misses;
  return {
    generatedAt: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()),
    requests: { trackedRoutes: routeMetrics.length, topSlowRoutes: routeMetrics.slice(0, 30) },
    database: { ...summarizeBucket(database), trackedQueryShapes: queryMetrics.length, topSlowQueries: queryMetrics.slice(0, 30) },
    redis: {
      reads: redis.reads, hits: redis.hits, misses: redis.misses, errors: redis.errors,
      hitRate: redisAttempts > 0 ? Math.round((redis.hits / redisAttempts) * 10_000) / 100 : 0,
      avgMs: average(redis.totalMs, redis.samples.length), p50Ms: percentile(redis.samples, 50), p95Ms: percentile(redis.samples, 95), p99Ms: percentile(redis.samples, 99),
    },
  };
};
