export type OperationalMetricOutcome = "success" | "retry" | "failed" | "dead" | "skipped";

const cacheInvalidations = new Map<string, number>();
const cacheInvalidationFailures = new Map<string, number>();
const outboxOutcomes = new Map<string, number>();
const notificationOutcomes = new Map<string, number>();
const googleAnalyticsOutcomes = new Map<string, number>();

let smtpSucceeded = 0;
let smtpFailed = 0;
let websitePublishAttempts = 0;
let websitePublishSucceeded = 0;
let websitePublishFailed = 0;

const increment = (map: Map<string, number>, key: string, count = 1) => {
  map.set(key, (map.get(key) ?? 0) + count);
};

const toObject = (map: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...map.entries()].sort(([a], [b]) => a.localeCompare(b)));

export const recordCacheVersionInvalidation = (
  resources: readonly string[],
  success: boolean,
): void => {
  for (const resource of new Set(resources)) {
    increment(success ? cacheInvalidations : cacheInvalidationFailures, resource);
  }
};

export const recordOutboxOutcome = (topic: string, outcome: OperationalMetricOutcome): void => {
  increment(outboxOutcomes, `${topic}:${outcome}`);
};

export const recordSmtpDelivery = (success: boolean): void => {
  if (success) smtpSucceeded += 1;
  else smtpFailed += 1;
};

export const recordNotificationDelivery = (
  templateKey: string,
  outcome: Exclude<OperationalMetricOutcome, "dead">,
): void => {
  increment(notificationOutcomes, `${templateKey}:${outcome}`);
};

export const recordWebsitePublishAttempt = (): void => {
  websitePublishAttempts += 1;
};

export const recordWebsitePublishResult = (success: boolean): void => {
  if (success) websitePublishSucceeded += 1;
  else websitePublishFailed += 1;
};

export const recordGoogleAnalyticsRequest = (operation: string, success: boolean): void => {
  increment(googleAnalyticsOutcomes, `${operation}:${success ? "success" : "failed"}`);
};

export const getOperationalMetricsSnapshot = () => ({
  generatedAt: new Date().toISOString(),
  cacheVersions: {
    invalidations: toObject(cacheInvalidations),
    failures: toObject(cacheInvalidationFailures),
  },
  outbox: toObject(outboxOutcomes),
  smtp: { succeeded: smtpSucceeded, failed: smtpFailed },
  notifications: toObject(notificationOutcomes),
  websitePublish: {
    attempts: websitePublishAttempts,
    succeeded: websitePublishSucceeded,
    failed: websitePublishFailed,
  },
  googleAnalytics: toObject(googleAnalyticsOutcomes),
});

export const resetOperationalMetricsForTests = (): void => {
  cacheInvalidations.clear();
  cacheInvalidationFailures.clear();
  outboxOutcomes.clear();
  notificationOutcomes.clear();
  googleAnalyticsOutcomes.clear();
  smtpSucceeded = 0;
  smtpFailed = 0;
  websitePublishAttempts = 0;
  websitePublishSucceeded = 0;
  websitePublishFailed = 0;
};
