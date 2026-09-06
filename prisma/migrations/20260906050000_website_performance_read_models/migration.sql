-- Deployment precondition: run perf:website:reconcile (read-only), review the
-- report, drain writers, then prisma migrate deploy BEFORE the new API starts.
-- Lock/statement timeouts fail deployment instead of quietly using stale counters.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';
LOCK TABLE "business_website" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "website_revision" IN SHARE ROW EXCLUSIVE MODE;
ALTER TABLE "business_website"
  ADD COLUMN "publishedDesignMetadata" JSONB,
  ADD COLUMN "publicationDeliveryEventId" TEXT,
  ADD COLUMN "publicationDeliveryReceipt" JSONB;

-- Reconcile monotonically. A draft may legitimately have no historical row
-- (e.g. autosave); never lower its counter to MAX(history).
UPDATE "business_website" AS w
SET "draftRevisionNumber" = GREATEST(w."draftRevisionNumber", COALESCE(w."publishedRevisionNumber",0),
  COALESCE((SELECT MAX(r."revisionNumber") FROM "website_revision" r WHERE r."websiteId" = w.id),0));
ALTER TABLE "business_website" ADD CONSTRAINT "business_website_revision_counter_valid"
  CHECK ("draftRevisionNumber" >= 0 AND "draftRevisionNumber" >= COALESCE("publishedRevisionNumber",0));

CREATE FUNCTION website_revision_counter_monotonic() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."draftRevisionNumber" < OLD."draftRevisionNumber" THEN
    RAISE EXCEPTION 'Website draft revision cannot move backwards' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER website_revision_counter_monotonic BEFORE UPDATE OF "draftRevisionNumber"
  ON "business_website" FOR EACH ROW EXECUTE FUNCTION website_revision_counter_monotonic();

-- Retains compatibility with old revision writers during a rolling deployment.
-- Existing application advisory locks and the UNIQUE(websiteId,revisionNumber)
-- constraint remain the concurrency boundary; no lock or isolation is removed.
CREATE FUNCTION website_revision_counter_advance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "business_website" SET "draftRevisionNumber" = GREATEST("draftRevisionNumber", NEW."revisionNumber")
  WHERE id = NEW."websiteId" AND "draftRevisionNumber" < NEW."revisionNumber";
  RETURN NEW;
END $$;
CREATE TRIGGER website_revision_counter_advance AFTER INSERT ON "website_revision"
  FOR EACH ROW EXECUTE FUNCTION website_revision_counter_advance();

CREATE FUNCTION website_publication_design_metadata() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."publishedDesignMetadata" := CASE
    WHEN jsonb_typeof(NEW."publishedSnapshot"->'website')='object'
      AND jsonb_typeof(NEW."publishedSnapshot"->'website'->'templateId')='string'
      AND jsonb_typeof(NEW."publishedSnapshot"->'website'->'templateVersion')='string'
    THEN jsonb_build_object('website', jsonb_build_object(
      'templateId', NEW."publishedSnapshot"->'website'->'templateId',
      'templateVersion', NEW."publishedSnapshot"->'website'->'templateVersion',
      'websiteDesign', NEW."publishedSnapshot"->'website'->'websiteDesign'))
    ELSE NULL END;
  RETURN NEW;
END $$;
CREATE TRIGGER website_publication_design_metadata BEFORE INSERT OR UPDATE OF "publishedSnapshot"
  ON "business_website" FOR EACH ROW EXECUTE FUNCTION website_publication_design_metadata();
UPDATE "business_website" SET "publishedSnapshot"="publishedSnapshot" WHERE "publishedSnapshot" IS NOT NULL;

-- Only an actual recorded delivery can become a readiness proof. No synthetic
-- ready=true for legacy PUBLISHED rows without a receipt. The preflight repair
-- tool can enqueue their verification through the existing outbox after review.
WITH latest AS (
  SELECT DISTINCT ON (e.payload->>'websiteId') e.payload->>'websiteId' AS website_id,
    e.id, e.payload->'receipt' AS receipt
  FROM "outbox_event" e
  WHERE e.topic='PUBLIC_WEBSITE_CACHE_INVALIDATION_REQUESTED'
    AND e.payload ? 'delivery'
  ORDER BY e.payload->>'websiteId', e."createdAt" DESC, e.id DESC
)
UPDATE "business_website" w SET "publicationDeliveryEventId"=l.id,
  "publicationDeliveryReceipt"=CASE WHEN jsonb_typeof(l.receipt)='object' THEN l.receipt ELSE NULL END
FROM latest l WHERE w.id=l.website_id;
COMMIT;
