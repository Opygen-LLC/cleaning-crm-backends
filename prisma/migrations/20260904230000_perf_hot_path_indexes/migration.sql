-- Performance Hot Path Indexes (Forward-only and safe)

-- 1. Partial index on outbox_event for idle and active batch claims
-- Eliminates table scans during background poller claimBatch queries
CREATE INDEX IF NOT EXISTS "outbox_event_claim_idx"
  ON "outbox_event" ("nextAttemptAt", "createdAt")
  WHERE "processedAt" IS NULL AND "status" IN ('PENDING', 'RETRY', 'PROCESSING');

-- 2. Partial index on notification_delivery for pending queue lookups
CREATE INDEX IF NOT EXISTS "notification_delivery_claim_idx"
  ON "notification_delivery" ("scheduledFor", "createdAt")
  WHERE "processedAt" IS NULL AND "status" IN ('QUEUED', 'RETRY');

-- 3. Composite sorting index on booking for admin listings without status filter (e.g. recentBookings in dashboard)
CREATE INDEX IF NOT EXISTS "booking_adminId_createdAt_id_idx"
  ON "booking" ("adminId", "createdAt" DESC, "id" DESC);

-- 4. Composite sorting indexes on quote for admin listings with and without status filter
CREATE INDEX IF NOT EXISTS "quote_adminId_createdAt_id_idx"
  ON "quote" ("adminId", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "quote_adminId_status_createdAt_id_idx"
  ON "quote" ("adminId", "status", "createdAt" DESC, "id" DESC);

-- 5. Composite sorting indexes on estimate for admin listings with and without status filter
CREATE INDEX IF NOT EXISTS "estimate_adminId_createdAt_id_idx"
  ON "estimate" ("adminId", "createdAt" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "estimate_adminId_status_createdAt_id_idx"
  ON "estimate" ("adminId", "status", "createdAt" DESC, "id" DESC);

-- 6. Composite index on review for dashboard review_stats staff grouping
CREATE INDEX IF NOT EXISTS "review_adminId_status_staffId_idx"
  ON "review" ("adminId", "status", "staffId");
