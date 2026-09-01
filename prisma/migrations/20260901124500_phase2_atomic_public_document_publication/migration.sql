-- Phase 2: one publication invariant for Quotes and Estimates.
ALTER TABLE "quote" ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);
ALTER TABLE "estimate" ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);

-- Draft documents are private capabilities. Existing quote drafts historically
-- received tokens at creation time; remove those inactive credentials.
UPDATE "quote"
SET "publicToken" = NULL,
    "publishedAt" = NULL,
    "sentAt" = NULL
WHERE "status" = 'DRAFT';

UPDATE "estimate"
SET "publicToken" = NULL,
    "publishedAt" = NULL,
    "sentAt" = NULL
WHERE "status" = 'DRAFT';

-- Existing non-draft rows were already intended to be public. Stamp the first
-- known publication moment from the strongest historical timestamp available.
UPDATE "quote"
SET "publishedAt" = COALESCE("publishedAt", "sentAt", "updatedAt", "createdAt")
WHERE "status" <> 'DRAFT';

UPDATE "estimate"
SET "publishedAt" = COALESCE("publishedAt", "sentAt", "updatedAt", "createdAt")
WHERE "status" <> 'DRAFT';

-- Before this release SENT always meant an actual send attempt. Preserve that
-- legacy meaning. New PUBLISH intent can intentionally have sentAt = NULL.
UPDATE "quote"
SET "sentAt" = COALESCE("sentAt", "publishedAt", "updatedAt", "createdAt")
WHERE "status" = 'SENT' AND "sentAt" IS NULL;

UPDATE "estimate"
SET "sentAt" = COALESCE("sentAt", "publishedAt", "updatedAt", "createdAt")
WHERE "status" = 'SENT' AND "sentAt" IS NULL;
