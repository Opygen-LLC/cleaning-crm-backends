import { beforeEach, describe, expect, it } from "vitest";
import {
  getOperationalMetricsSnapshot,
  recordCacheVersionInvalidation,
  recordGoogleAnalyticsRequest,
  recordNotificationDelivery,
  recordOutboxOutcome,
  recordSmtpDelivery,
  recordWebsitePublishAttempt,
  recordWebsitePublishResult,
  resetOperationalMetricsForTests,
} from "./operationalMetrics";

describe("Phase 7 operational metrics", () => {
  beforeEach(resetOperationalMetricsForTests);

  it("tracks cache generations without tenant/user cardinality", () => {
    recordCacheVersionInvalidation(["clients", "dashboard", "clients"], true);
    recordCacheVersionInvalidation(["reports"], false);
    const snapshot = getOperationalMetricsSnapshot();
    expect(snapshot.cacheVersions.invalidations).toEqual({ clients: 1, dashboard: 1 });
    expect(snapshot.cacheVersions.failures).toEqual({ reports: 1 });
  });

  it("tracks delivery, publish and Google Analytics failures", () => {
    recordOutboxOutcome("BUSINESS_NOTIFICATION_DELIVERY_REQUESTED", "retry");
    recordNotificationDelivery("invoice-due", "failed");
    recordSmtpDelivery(false);
    recordWebsitePublishAttempt();
    recordWebsitePublishResult(false);
    recordGoogleAnalyticsRequest("GOOGLE_ANALYTICS_REPORT_FAILED", false);

    const snapshot = getOperationalMetricsSnapshot();
    expect(snapshot.smtp.failed).toBe(1);
    expect(snapshot.websitePublish).toEqual({ attempts: 1, succeeded: 0, failed: 1 });
    expect(snapshot.notifications["invoice-due:failed"]).toBe(1);
    expect(snapshot.googleAnalytics["GOOGLE_ANALYTICS_REPORT_FAILED:failed"]).toBe(1);
  });
});
