export const REQUEST_STORM_CODE = "CLIENT_REQUEST_LOOP_DETECTED";
const WINDOW_MS = 10_000;
const MAX_REQUESTS_PER_WINDOW = 8;
const ALERT_COOLDOWN_MS = 60_000;
const MAX_KEYS = 2_000;

type Bucket = { timestamps: number[]; lastAlertAt: number | null };
const buckets = new Map<string, Bucket>();

export type RequestStormAlert = {
  code: typeof REQUEST_STORM_CODE;
  identity: string;
  method: string;
  route: string;
  statusCode: number;
  count: number;
  windowMs: number;
};

export const observeRequestStorm = (
  input: { identity: string | null; method: string; route: string; statusCode: number },
  now = Date.now(),
): RequestStormAlert | null => {
  if (!input.identity) return null;
  const key = `${input.identity}|${input.method.toUpperCase()}|${input.route}|${input.statusCode}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    if (buckets.size >= MAX_KEYS) {
      const oldest = buckets.keys().next().value as string | undefined;
      if (oldest) buckets.delete(oldest);
    }
    bucket = { timestamps: [], lastAlertAt: null };
    buckets.set(key, bucket);
  }
  const cutoff = now - WINDOW_MS;
  bucket.timestamps = bucket.timestamps.filter((timestamp) => timestamp >= cutoff);
  bucket.timestamps.push(now);
  if (
    bucket.timestamps.length > MAX_REQUESTS_PER_WINDOW &&
    (bucket.lastAlertAt === null || now - bucket.lastAlertAt >= ALERT_COOLDOWN_MS)
  ) {
    bucket.lastAlertAt = now;
    return {
      code: REQUEST_STORM_CODE,
      identity: input.identity,
      method: input.method.toUpperCase(),
      route: input.route,
      statusCode: input.statusCode,
      count: bucket.timestamps.length,
      windowMs: WINDOW_MS,
    };
  }
  return null;
};

export const resetRequestStormDetectorForTests = (): void => buckets.clear();
