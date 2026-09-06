import { createHash } from "node:crypto";
import type { TargetMarket } from "./requestGeography";

const MAX_SAMPLES_PER_BUCKET = 512;
const MAX_ROUTE_BUCKETS = 250;
const MAX_QUERY_BUCKETS = 200;
const RECENT_WINDOW_MS = Math.min(60 * 60_000, Math.max(60_000, Number(process.env.OBSERVABILITY_WINDOW_MS) || 10 * 60_000));
const MAX_RECENT_REQUESTS = 5_000;
const TARGET_MARKET_ORDER: TargetMarket[] = ["USA", "Canada", "UK", "Europe", "Australia", "Other"];

type SampleBucket = { samples: number[]; count: number; errors: number; totalMs: number; maxMs: number; lastSeenAt: number };
type RouteBucket = SampleBucket & {
  poolWaitSamples: number[]; queryCountSamples: number[]; redisCountSamples: number[]; cacheStateSamples: Record<string, number[]>; redisCommandCount: number; poolAcquisitions: number; dbSamples: number[]; redisSamples: number[]; authSamples: number[]; serializationSamples: number[]; externalSamples: number[]; responseByteSamples: number[]; dbQueryCount: number;
  statusCounts: Record<string, number>; redisHits: number; redisMisses: number; cacheHits: number; cacheMisses: number; totalResponseBytes: number;
};
type QueryBucket = SampleBucket & { fingerprint: string; sample: string };
type RedisStats = { commands: number; reads: number; hits: number; misses: number; errors: number; totalMs: number; samples: number[] };
type RecentRequest = {
  at: number; method: string; route: string; statusCode: number; durationMs: number;
  dbDurationMs: number; redisDurationMs: number; serializationDurationMs: number; externalDurationMs: number; responseBytes: number;
  authErrorCode: string | null; market: TargetMarket | null;
};

const routes = new Map<string, RouteBucket>();
const queries = new Map<string, QueryBucket>();
const database: SampleBucket = { samples: [], count: 0, errors: 0, totalMs: 0, maxMs: 0, lastSeenAt: Date.now() };
const redis: RedisStats = { commands: 0, reads: 0, hits: 0, misses: 0, errors: 0, totalMs: 0, samples: [] };
const marketRequests = new Map<TargetMarket, SampleBucket>();
const recentRequests: RecentRequest[] = [];

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
const percent = (numerator: number, denominator: number) => denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 100 : 0;
const evictOldest = <T extends { lastSeenAt: number }>(map: Map<string, T>, max: number) => {
  if (map.size < max) return;
  let oldestKey: string | null = null; let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, bucket] of map.entries()) if (bucket.lastSeenAt < oldestAt) { oldestAt = bucket.lastSeenAt; oldestKey = key; }
  if (oldestKey) map.delete(oldestKey);
};
const summarizeBucket = (bucket: SampleBucket) => ({
  count: bucket.count, errors: bucket.errors, errorRate: percent(bucket.errors, bucket.count),
  avgMs: average(bucket.totalMs, bucket.count), p50Ms: percentile(bucket.samples, 50),
  p95Ms: percentile(bucket.samples, 95), p99Ms: percentile(bucket.samples, 99), maxMs: Math.round(bucket.maxMs * 10) / 10,
});
const summarizeSamples = (samples: number[]) => ({ p50Ms: percentile(samples, 50), p95Ms: percentile(samples, 95), p99Ms: percentile(samples, 99) });
// Driver-boundary probes can include raw SQL. Keep literals out of metrics,
// and bound fingerprints so high-cardinality tenant values cannot leak here.
const normalizeQuery = (query: string) => query
  .replace(/\$([A-Za-z_][A-Za-z0-9_]*|)\$[\s\S]*?\$\1\$/g, "?")
  .replace(/'(?:\\.|''|[^'])*'/g, "?")
  .replace(/\/\*[\s\S]*?\*\/|--[^\r\n]*/g, " ")
  .replace(/\b\d+(?:\.\d+)?\b/g, "?").replace(/\s+/g, " ").trim();
const pruneRecent = (now = Date.now()) => {
  const cutoff = now - RECENT_WINDOW_MS;
  let remove = 0;
  while (remove < recentRequests.length && recentRequests[remove]!.at < cutoff) remove += 1;
  if (remove) recentRequests.splice(0, remove);
  if (recentRequests.length > MAX_RECENT_REQUESTS) recentRequests.splice(0, recentRequests.length - MAX_RECENT_REQUESTS);
};

export const recordRequestMetric = (input: {
  method: string; route: string; statusCode: number; durationMs: number; dbDurationMs?: number; dbQueryCount?: number; dbPoolWaitMs?: number; dbPoolAcquisitions?: number; redisCommandCount?: number;
  redisDurationMs?: number; redisHits?: number; redisMisses?: number; authDurationMs?: number; cacheHits?: number;
  cacheMisses?: number; market?: TargetMarket; serializationDurationMs?: number; externalDurationMs?: number; responseBytes?: number; authErrorCode?: string | null;
}): void => {
  const key = `${input.method.toUpperCase()} ${input.route}`;
  let bucket = routes.get(key);
  if (!bucket) {
    evictOldest(routes, MAX_ROUTE_BUCKETS);
    bucket = { samples: [], count: 0, errors: 0, totalMs: 0, maxMs: 0, lastSeenAt: Date.now(), poolWaitSamples: [], queryCountSamples: [], redisCountSamples: [], cacheStateSamples: {}, redisCommandCount: 0, poolAcquisitions: 0, dbSamples: [], redisSamples: [], authSamples: [], serializationSamples: [], externalSamples: [], responseByteSamples: [], dbQueryCount: 0, statusCounts: {}, redisHits: 0, redisMisses: 0, cacheHits: 0, cacheMisses: 0, totalResponseBytes: 0 };
    routes.set(key, bucket);
  }
  bucket.redisCommandCount += input.redisCommandCount ?? 0;
  bucket.poolAcquisitions += input.dbPoolAcquisitions ?? 0;
  pushSample(bucket.poolWaitSamples, input.dbPoolWaitMs ?? 0);
  pushSample(bucket.queryCountSamples, input.dbQueryCount ?? 0);
  pushSample(bucket.redisCountSamples, input.redisCommandCount ?? 0);
  const cacheState = (input.cacheMisses ?? 0) > 0 ? "miss" : (input.cacheHits ?? 0) > 0 ? "hit" : "unclassified";
  pushSample(bucket.cacheStateSamples[cacheState] ??= [], input.durationMs);
  bucket.count += 1;
  if (input.statusCode >= 500) bucket.errors += 1;
  bucket.totalMs += input.durationMs; bucket.maxMs = Math.max(bucket.maxMs, input.durationMs); bucket.lastSeenAt = Date.now();
  bucket.dbQueryCount += input.dbQueryCount ?? 0; bucket.redisHits += input.redisHits ?? 0; bucket.redisMisses += input.redisMisses ?? 0;
  bucket.cacheHits += input.cacheHits ?? 0; bucket.cacheMisses += input.cacheMisses ?? 0; bucket.totalResponseBytes += input.responseBytes ?? 0;
  bucket.statusCounts[String(input.statusCode)] = (bucket.statusCounts[String(input.statusCode)] ?? 0) + 1;
  pushSample(bucket.samples, input.durationMs); pushSample(bucket.dbSamples, input.dbDurationMs ?? 0); pushSample(bucket.redisSamples, input.redisDurationMs ?? 0); pushSample(bucket.authSamples, input.authDurationMs ?? 0); pushSample(bucket.serializationSamples, input.serializationDurationMs ?? 0); pushSample(bucket.externalSamples, input.externalDurationMs ?? 0); pushSample(bucket.responseByteSamples, input.responseBytes ?? 0);

  if (input.market) {
    let marketBucket = marketRequests.get(input.market);
    if (!marketBucket) { marketBucket = { samples: [], count: 0, errors: 0, totalMs: 0, maxMs: 0, lastSeenAt: Date.now() }; marketRequests.set(input.market, marketBucket); }
    marketBucket.count += 1; if (input.statusCode >= 500) marketBucket.errors += 1;
    marketBucket.totalMs += input.durationMs; marketBucket.maxMs = Math.max(marketBucket.maxMs, input.durationMs); marketBucket.lastSeenAt = Date.now(); pushSample(marketBucket.samples, input.durationMs);
  }

  recentRequests.push({ at: Date.now(), method: input.method.toUpperCase(), route: input.route, statusCode: input.statusCode, durationMs: input.durationMs, dbDurationMs: input.dbDurationMs ?? 0, redisDurationMs: input.redisDurationMs ?? 0, serializationDurationMs: input.serializationDurationMs ?? 0, externalDurationMs: input.externalDurationMs ?? 0, responseBytes: input.responseBytes ?? 0, authErrorCode: input.authErrorCode ?? null, market: input.market ?? null });
  pruneRecent();
};

export const recordDatabaseQueryMetric = (durationMs: number, query?: string, error = false): void => {
  if (error) database.errors += 1;
  database.count += 1; database.totalMs += durationMs; database.maxMs = Math.max(database.maxMs, durationMs); database.lastSeenAt = Date.now(); pushSample(database.samples, durationMs);
  if (!query) return;
  const normalized = normalizeQuery(query); const fingerprint = createHash("sha1").update(normalized).digest("hex").slice(0, 12);
  let bucket = queries.get(fingerprint);
  if (!bucket) { evictOldest(queries, MAX_QUERY_BUCKETS); bucket = { fingerprint, sample: normalized.slice(0, 220), samples: [], count: 0, errors: 0, totalMs: 0, maxMs: 0, lastSeenAt: Date.now() }; queries.set(fingerprint, bucket); }
  if (error) bucket.errors += 1;
  bucket.count += 1; bucket.totalMs += durationMs; bucket.maxMs = Math.max(bucket.maxMs, durationMs); bucket.lastSeenAt = Date.now(); pushSample(bucket.samples, durationMs);
};

export const recordRedisCommandMetric = (input: { durationMs: number; hits?: number; misses?: number; error?: boolean; read?: boolean }): void => {
  redis.commands += 1;
  if (input.read) redis.reads += (input.hits ?? 0) + (input.misses ?? 0) || 1;
  redis.hits += input.hits ?? 0; redis.misses += input.misses ?? 0;
  if (input.error) redis.errors += 1;
  redis.totalMs += input.durationMs; pushSample(redis.samples, input.durationMs);
};
// Compatibility for consumers/tests of the original helper.
export const recordRedisReadMetric = (input: { durationMs: number; hits: number; misses: number; error?: boolean }): void =>
  recordRedisCommandMetric({ ...input, read: true });

const getRecentWindowSnapshot = () => {
  pruneRecent();
  const rows = [...recentRequests]; const count = rows.length;
  const rate = (fn: (row: RecentRequest) => boolean) => percent(rows.filter(fn).length, count);
  const codeCount = (code: string) => rows.filter((row) => row.authErrorCode === code).length;
  const refreshRows = rows.filter((row) => row.route.includes("/auth/refresh-token"));
  const otpRows = rows.filter((row) => /\/auth\/(verify|verify-email|resend)/.test(row.route));
  return {
    windowMs: RECENT_WINDOW_MS,
    requestCount: count,
    p50Ms: percentile(rows.map((row) => row.durationMs), 50), p95Ms: percentile(rows.map((row) => row.durationMs), 95), p99Ms: percentile(rows.map((row) => row.durationMs), 99),
    databaseP95Ms: percentile(rows.map((row) => row.dbDurationMs), 95), redisP95Ms: percentile(rows.map((row) => row.redisDurationMs), 95), serializationP95Ms: percentile(rows.map((row) => row.serializationDurationMs), 95), externalP95Ms: percentile(rows.map((row) => row.externalDurationMs), 95), responseBytesP95: percentile(rows.map((row) => row.responseBytes), 95),
    error5xxRate: rate((row) => row.statusCode >= 500), badGatewayRate: rate((row) => row.statusCode === 502 || row.statusCode === 503), auth401Rate: rate((row) => row.statusCode === 401),
    refreshFailureRate: refreshRows.length ? percent(refreshRows.filter((row) => row.statusCode >= 400).length, refreshRows.length) : 0,
    otpFailureRate: otpRows.length ? percent(otpRows.filter((row) => row.statusCode >= 400).length, otpRows.length) : 0,
    authSignals: {
      verificationSessionFailed: codeCount("AUTH_VERIFICATION_SESSION_FAILED"), accessTokenMissing: codeCount("ACCESS_TOKEN_MISSING"),
      refreshReuseDetected: codeCount("REFRESH_TOKEN_REUSE_DETECTED"), invalidSession: codeCount("INVALID_SESSION"), csrfFailures: codeCount("CSRF_VALIDATION_FAILED"),
    },
  };
};

export const getPerformanceSnapshot = () => {
  const routeMetrics = Array.from(routes.entries()).map(([route, bucket]) => {
    const cacheAttempts = bucket.cacheHits + bucket.cacheMisses; const redisAttempts = bucket.redisHits + bucket.redisMisses;
    return { route, ...summarizeBucket(bucket), database: { ...summarizeSamples(bucket.dbSamples), queryCount: bucket.dbQueryCount, queriesPerRequest: summarizeSamples(bucket.queryCountSamples), poolAcquire: { ...summarizeSamples(bucket.poolWaitSamples), count: bucket.poolAcquisitions } }, cacheStates: Object.fromEntries(Object.entries(bucket.cacheStateSamples).map(([state, samples]) => [state, { sampleCount: samples.length, ...summarizeSamples(samples) }])), redis: { ...summarizeSamples(bucket.redisSamples), commandCount: bucket.redisCommandCount, commandsPerRequest: summarizeSamples(bucket.redisCountSamples), hitRate: percent(bucket.redisHits, redisAttempts) }, auth: summarizeSamples(bucket.authSamples), serialization: summarizeSamples(bucket.serializationSamples), external: summarizeSamples(bucket.externalSamples), responseBytes: { avgBytes: average(bucket.totalResponseBytes, bucket.count), p50Bytes: percentile(bucket.responseByteSamples, 50), p95Bytes: percentile(bucket.responseByteSamples, 95), p99Bytes: percentile(bucket.responseByteSamples, 99) }, statuses: bucket.statusCounts, responseCache: { hits: bucket.cacheHits, misses: bucket.cacheMisses, hitRate: percent(bucket.cacheHits, cacheAttempts) } };
  }).sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count);
  const queryMetrics = Array.from(queries.values()).map((bucket) => ({ fingerprint: bucket.fingerprint, sample: bucket.sample, ...summarizeBucket(bucket) })).sort((a, b) => b.p95Ms - a.p95Ms || b.count - a.count);
  const redisAttempts = redis.hits + redis.misses;
  const regionalPerformance = TARGET_MARKET_ORDER.map((market) => {
    const bucket = marketRequests.get(market);
    return { market, ...(bucket ? summarizeBucket(bucket) : { count: 0, errors: 0, errorRate: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 }) };
  });
  return {
    schemaVersion: 2, clock: "api-middleware-to-finish", percentileWindow: `last-${MAX_SAMPLES_PER_BUCKET}-samples-per-route`, scope: "per-process", generatedAt: new Date().toISOString(), uptimeSeconds: Math.round(process.uptime()), window: getRecentWindowSnapshot(),
    requests: { trackedRoutes: routeMetrics.length, topSlowRoutes: routeMetrics.slice(0, 30) }, geography: { markets: regionalPerformance },
    database: { ...summarizeBucket(database), trackedQueryShapes: queryMetrics.length, topSlowQueries: queryMetrics.slice(0, 30) },
    redis: { commandCount: redis.commands, reads: redis.reads, hits: redis.hits, misses: redis.misses, errors: redis.errors, hitRate: percent(redis.hits, redisAttempts), avgMs: average(redis.totalMs, redis.commands), p50Ms: percentile(redis.samples, 50), p95Ms: percentile(redis.samples, 95), p99Ms: percentile(redis.samples, 99) },
  };
};

export const resetPerformanceMetricsForTests = (): void => {
  routes.clear(); queries.clear(); marketRequests.clear(); recentRequests.splice(0, recentRequests.length);
  database.samples = []; database.count = 0; database.errors = 0; database.totalMs = 0; database.maxMs = 0; database.lastSeenAt = Date.now();
  redis.commands = 0; redis.reads = 0; redis.hits = 0; redis.misses = 0; redis.errors = 0; redis.totalMs = 0; redis.samples = [];
};
