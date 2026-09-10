-- Phase 2: make MediaAsset the authoritative storage reference while retaining
-- legacy URL columns for a zero-downtime migration of existing rows.
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "imageMediaAssetId" TEXT;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "businessLogoMediaAssetId" TEXT;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "mediaAssetId" TEXT;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "storageKey" TEXT;
ALTER TABLE "job_attachment" ALTER COLUMN "cloudinaryId" DROP NOT NULL;
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "paymentProofMediaAssetId" TEXT;
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "receiptUrl" TEXT;
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "receiptMediaAssetId" TEXT;
ALTER TABLE "BillingHistory" ADD COLUMN IF NOT EXISTS "paymentProofMediaAssetId" TEXT;
ALTER TABLE "expense" ADD COLUMN IF NOT EXISTS "receiptMediaAssetId" TEXT;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "mediaAssetId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "user_imageMediaAssetId_key" ON "user"("imageMediaAssetId");
CREATE UNIQUE INDEX IF NOT EXISTS "AdminProfile_businessLogoMediaAssetId_key" ON "AdminProfile"("businessLogoMediaAssetId");
CREATE UNIQUE INDEX IF NOT EXISTS "job_attachment_mediaAssetId_key" ON "job_attachment"("mediaAssetId");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_paymentProofMediaAssetId_key" ON "payment"("paymentProofMediaAssetId");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_receiptMediaAssetId_key" ON "payment"("receiptMediaAssetId");
CREATE UNIQUE INDEX IF NOT EXISTS "BillingHistory_paymentProofMediaAssetId_key" ON "BillingHistory"("paymentProofMediaAssetId");
CREATE UNIQUE INDEX IF NOT EXISTS "expense_receiptMediaAssetId_key" ON "expense"("receiptMediaAssetId");
CREATE UNIQUE INDEX IF NOT EXISTS "website_asset_mediaAssetId_key" ON "website_asset"("mediaAssetId");
