-- Phase 2 — enterprise migration-history reconciliation
-- Generated from the checked-in migration history and the current multi-file Prisma schema.
-- Forward-only and data-preserving: no customer table/column is dropped by this migration.
-- It is intentionally tolerant of environments that previously received some changes through db push.

SET lock_timeout = '10s';
SET statement_timeout = '0';

-- ---------------------------------------------------------------------------
-- 1) Enum reconciliation
-- ---------------------------------------------------------------------------
ALTER TYPE "Currency" ADD VALUE IF NOT EXISTS 'NZD';
ALTER TYPE "Currency" ADD VALUE IF NOT EXISTS 'SGD';
ALTER TYPE "Currency" ADD VALUE IF NOT EXISTS 'ZAR';
ALTER TYPE "Currency" ADD VALUE IF NOT EXISTS 'INR';
ALTER TYPE "Currency" ADD VALUE IF NOT EXISTS 'AED';
ALTER TYPE "SubscriptionName" ADD VALUE IF NOT EXISTS 'CUSTOM';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'BANK_TRANSFER';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CASH';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'CHEQUE';
ALTER TYPE "PaymentMethod" ADD VALUE IF NOT EXISTS 'MANUAL';
ALTER TYPE "PaymentStatus" ADD VALUE IF NOT EXISTS 'PENDING_APPROVAL';
ALTER TYPE "Country" ADD VALUE IF NOT EXISTS 'COTE_D_IVOIRE';
DO $$ BEGIN
  CREATE TYPE "ServiceStatus" AS ENUM ('ACTIVE', 'INACTIVE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "BookingChangeRequestType" AS ENUM ('RESCHEDULE', 'CANCELLATION');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "BookingChangeRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "StaffStatus" AS ENUM ('ACTIVE', 'DEACTIVE', 'INACTIVE', 'ON_LEAVE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "LeaveStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "LeadStage" AS ENUM ('NEW', 'CONTACTED', 'QUOTE_SENT', 'WON', 'LOST');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "NoteType" AS ENUM ('GENERAL', 'CLIENT', 'STAFF', 'ISSUE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'SUSPENDED';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'PENDING_PAYMENT';
DO $$ BEGIN
  CREATE TYPE "PendingPlanChangeStatus" AS ENUM ('AWAITING_PAYMENT', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "NotificationType" AS ENUM ('BOOKING', 'QUOTE', 'PAYMENT', 'REVIEW', 'JOB', 'SUBSCRIPTION', 'GENERAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WebsiteStatus" AS ENUM ('PROVISIONED', 'DRAFT', 'PUBLISHED', 'SUSPENDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WebsitePageKind" AS ENUM ('HOME', 'SERVICES', 'ABOUT', 'REVIEWS', 'CONTACT', 'BOOK', 'ESTIMATE', 'CUSTOM');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "WebsiteDomainStatus" AS ENUM ('PENDING', 'VERIFYING', 'VERIFIED', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "RecurringFrequency" AS ENUM ('WEEKLY', 'BIWEEKLY', 'MONTHLY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "RecurringStatus" AS ENUM ('ACTIVE', 'PAUSED', 'CANCELLED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;


-- ---------------------------------------------------------------------------
-- 2) Create post-history tables when absent
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "ActivityLog" (
  "id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entityType" TEXT NOT NULL,
  "entityId" TEXT,
  "description" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "adminId" TEXT NOT NULL,
  CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "pricing_rules" (
  "id" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "rules" JSONB DEFAULT '[]'::jsonb NOT NULL,
  "addons" JSONB DEFAULT '[]'::jsonb NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "pricing_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notification" (
  "id" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "type" "NotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "relatedId" TEXT,
  "isRead" BOOLEAN DEFAULT false NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "notification_template" (
  "id" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "channel" TEXT DEFAULT 'EMAIL' NOT NULL,
  "subject" TEXT,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "push_subscription" (
  "id" TEXT NOT NULL,
  "endpoint" TEXT NOT NULL,
  "p256dh" TEXT NOT NULL,
  "auth" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "push_subscription_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "booking_change_request" (
  "id" TEXT NOT NULL,
  "type" "BookingChangeRequestType" NOT NULL,
  "status" "BookingChangeRequestStatus" DEFAULT 'PENDING' NOT NULL,
  "requestedDate" TIMESTAMP(3),
  "reason" TEXT,
  "decisionNote" TEXT,
  "decidedAt" TIMESTAMP(3),
  "decidedBy" TEXT,
  "bookingId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "booking_change_request_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "checklist_template" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "serviceType" "ServiceType",
  "serviceCatalogId" TEXT,
  "adminId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "checklist_template_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "checklist_task" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "required" BOOLEAN DEFAULT false NOT NULL,
  "sortOrder" INTEGER DEFAULT 0 NOT NULL,
  "templateId" TEXT NOT NULL,
  CONSTRAINT "checklist_task_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "job_checklist" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "templateId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "job_checklist_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "job_checklist_item" (
  "id" TEXT NOT NULL,
  "checklistId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "required" BOOLEAN DEFAULT false NOT NULL,
  "sortOrder" INTEGER DEFAULT 0 NOT NULL,
  "completed" BOOLEAN DEFAULT false NOT NULL,
  "completedAt" TIMESTAMP(3),
  "completedBy" TEXT,
  CONSTRAINT "job_checklist_item_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "job_note" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "type" "NoteType" DEFAULT 'GENERAL' NOT NULL,
  "body" TEXT NOT NULL,
  "pinned" BOOLEAN DEFAULT false NOT NULL,
  "authorName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "job_note_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "job_attachment" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "fileName" TEXT NOT NULL,
  "fileUrl" TEXT NOT NULL,
  "cloudinaryId" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "fileSizeBytes" INTEGER NOT NULL,
  "uploadedByRole" TEXT DEFAULT 'ADMIN' NOT NULL,
  "photoType" TEXT,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "job_attachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "lead" (
  "id" TEXT NOT NULL,
  "leadRef" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "phone" TEXT,
  "serviceInterest" TEXT NOT NULL,
  "estimatedMin" DECIMAL(10,2) DEFAULT 0 NOT NULL,
  "estimatedMax" DECIMAL(10,2) DEFAULT 0 NOT NULL,
  "stage" "LeadStage" DEFAULT 'NEW' NOT NULL,
  "notes" TEXT,
  "sourceRef" TEXT,
  "serviceCatalogId" TEXT,
  "sourceWebsiteId" TEXT,
  "adminId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lead_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "outbox_event" (
  "id" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "dedupeKey" TEXT,
  "payload" JSONB NOT NULL,
  "status" TEXT DEFAULT 'PENDING' NOT NULL,
  "attempts" INTEGER DEFAULT 0 NOT NULL,
  "maxAttempts" INTEGER DEFAULT 8 NOT NULL,
  "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "lockedAt" TIMESTAMP(3),
  "processedAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "quote_template" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "serviceType" TEXT,
  "serviceCatalogId" TEXT,
  "serviceNameSnapshot" TEXT,
  "notes" TEXT,
  "taxRate" DECIMAL(5,2) DEFAULT 20 NOT NULL,
  "usageCount" INTEGER DEFAULT 0 NOT NULL,
  "lastUsedAt" TIMESTAMP(3),
  "adminId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "quote_template_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "quote_template_line_item" (
  "id" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "quantity" INTEGER DEFAULT 1 NOT NULL,
  "unitPrice" DECIMAL(10,2) NOT NULL,
  "templateId" TEXT NOT NULL,
  CONSTRAINT "quote_template_line_item_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "recurring_schedule" (
  "id" TEXT NOT NULL,
  "scheduleRef" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "serviceType" "ServiceType",
  "serviceCatalogId" TEXT,
  "serviceNameSnapshot" TEXT,
  "priceSnapshot" DECIMAL(10,2),
  "durationSnapshot" TEXT,
  "address" TEXT NOT NULL,
  "durationMins" INTEGER NOT NULL,
  "total" DECIMAL(10,2) NOT NULL,
  "notes" TEXT,
  "frequency" "RecurringFrequency" NOT NULL,
  "dayOfWeek" "WeekDay" NOT NULL,
  "timeHour" INTEGER NOT NULL,
  "timeMinute" INTEGER NOT NULL,
  "status" "RecurringStatus" DEFAULT 'ACTIVE' NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "nextRunAt" TIMESTAMP(3) NOT NULL,
  "lastRunAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "recurring_schedule_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "recurring_staff_assignment" (
  "scheduleId" TEXT NOT NULL,
  "staffId" TEXT NOT NULL,
  CONSTRAINT "recurring_staff_assignment_pkey" PRIMARY KEY ("scheduleId", "staffId")
);

CREATE TABLE IF NOT EXISTS "review_token" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "used" BOOLEAN DEFAULT false NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "review_token_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "review" (
  "id" TEXT NOT NULL,
  "reviewTokenId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "staffId" TEXT,
  "clientName" TEXT NOT NULL,
  "rating" INTEGER NOT NULL,
  "comment" TEXT DEFAULT '' NOT NULL,
  "sentiment" TEXT DEFAULT 'neutral' NOT NULL,
  "status" TEXT DEFAULT 'pending' NOT NULL,
  "isPublished" BOOLEAN DEFAULT false NOT NULL,
  "tags" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL,
  "adminReply" TEXT,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "review_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "service_catalog" (
  "id" TEXT NOT NULL,
  "serviceName" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "basePriceGbp" DOUBLE PRECISION DEFAULT 0.0 NOT NULL,
  "duration" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "status" "ServiceStatus" DEFAULT 'ACTIVE' NOT NULL,
  "onlineBookingEnabled" BOOLEAN DEFAULT true NOT NULL,
  "legacyServiceType" "ServiceType",
  "adminId" TEXT NOT NULL,
  "addOns" JSONB DEFAULT '[]'::jsonb,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "service_catalog_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "StaffLeave" (
  "id" TEXT NOT NULL,
  "startDate" TIMESTAMP(3) NOT NULL,
  "endDate" TIMESTAMP(3) NOT NULL,
  "reason" TEXT,
  "status" "LeaveStatus" DEFAULT 'PENDING' NOT NULL,
  "adminNote" TEXT,
  "reviewedAt" TIMESTAMP(3),
  "staffId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StaffLeave_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "PendingPlanChange" (
  "id" TEXT NOT NULL,
  "status" "PendingPlanChangeStatus" DEFAULT 'AWAITING_PAYMENT' NOT NULL,
  "quotedAmount" DECIMAL(10,2) NOT NULL,
  "currency" "Currency" DEFAULT 'USD' NOT NULL,
  "submittedAt" TIMESTAMP(3),
  "reviewedAt" TIMESTAMP(3),
  "rejectionReason" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "subscriptionId" TEXT NOT NULL,
  "targetPlanId" TEXT NOT NULL,
  "couponId" TEXT,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PendingPlanChange_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "super_admin_config" (
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "super_admin_config_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "business_website" (
  "id" TEXT NOT NULL,
  "adminId" TEXT NOT NULL,
  "subdomain" TEXT NOT NULL,
  "status" "WebsiteStatus" DEFAULT 'PROVISIONED' NOT NULL,
  "templateId" TEXT DEFAULT 'clean-modern' NOT NULL,
  "templateVersion" TEXT DEFAULT '1.0.0' NOT NULL,
  "schemaVersion" INTEGER DEFAULT 1 NOT NULL,
  "primaryColor" TEXT DEFAULT '#0F766E' NOT NULL,
  "secondaryColor" TEXT DEFAULT '#0F172A' NOT NULL,
  "accentColor" TEXT DEFAULT '#14B8A6' NOT NULL,
  "font" TEXT,
  "logo" TEXT,
  "favicon" TEXT,
  "primaryBookingFormId" TEXT,
  "primaryEstimateFormId" TEXT,
  "bookingEnabled" BOOLEAN DEFAULT false NOT NULL,
  "bookingShowNavigation" BOOLEAN DEFAULT true NOT NULL,
  "bookingShowHeaderCta" BOOLEAN DEFAULT true NOT NULL,
  "bookingShowServiceCtas" BOOLEAN DEFAULT true NOT NULL,
  "bookingShowHomeCta" BOOLEAN DEFAULT true NOT NULL,
  "bookingShowAvailableSlots" BOOLEAN DEFAULT true NOT NULL,
  "bookingShowPrices" BOOLEAN DEFAULT true NOT NULL,
  "bookingShowStartingPrices" BOOLEAN DEFAULT true NOT NULL,
  "bookingShowServiceDuration" BOOLEAN DEFAULT true NOT NULL,
  "bookingCtaLabel" TEXT DEFAULT 'Book Now' NOT NULL,
  "estimateEnabled" BOOLEAN DEFAULT false NOT NULL,
  "metaTitle" TEXT,
  "metaDescription" TEXT,
  "socialImageUrl" TEXT,
  "indexSite" BOOLEAN DEFAULT true NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "publishedAt" TIMESTAMP(3),
  "publishedSnapshot" JSONB,
  "publishedRevisionNumber" INTEGER,
  CONSTRAINT "business_website_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "website_page" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "kind" "WebsitePageKind" NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "content" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "seoTitle" TEXT,
  "seoDescription" TEXT,
  "showInNavigation" BOOLEAN DEFAULT true NOT NULL,
  "isEnabled" BOOLEAN DEFAULT true NOT NULL,
  "sortOrder" INTEGER DEFAULT 0 NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "website_page_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "website_revision" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "revisionNumber" INTEGER NOT NULL,
  "snapshot" JSONB NOT NULL,
  "reason" TEXT,
  "createdByUserId" TEXT,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "website_revision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "website_domain" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "domain" TEXT NOT NULL,
  "status" "WebsiteDomainStatus" DEFAULT 'PENDING' NOT NULL,
  "verificationToken" TEXT NOT NULL,
  "requiredDns" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "isPrimary" BOOLEAN DEFAULT false NOT NULL,
  "verificationStartedAt" TIMESTAMP(3),
  "lastCheckedAt" TIMESTAMP(3),
  "verifiedAt" TIMESTAMP(3),
  "failureReason" TEXT,
  "provider" TEXT DEFAULT 'MANUAL' NOT NULL,
  "providerVerified" BOOLEAN DEFAULT false NOT NULL,
  "ownershipVerified" BOOLEAN DEFAULT false NOT NULL,
  "routingVerified" BOOLEAN DEFAULT false NOT NULL,
  "tlsStatus" TEXT DEFAULT 'PENDING' NOT NULL,
  "lastProviderSyncAt" TIMESTAMP(3),
  "providerData" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "website_domain_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "website_subdomain_alias" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "subdomain" TEXT NOT NULL,
  "redirectCode" INTEGER DEFAULT 308 NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "website_subdomain_alias_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "website_asset" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "publicId" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "mimeType" TEXT NOT NULL,
  "width" INTEGER,
  "height" INTEGER,
  "bytes" INTEGER,
  "altText" TEXT,
  "folder" TEXT NOT NULL,
  "metadata" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "website_asset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "website_analytics_event" (
  "id" TEXT NOT NULL,
  "websiteId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "path" TEXT DEFAULT '/' NOT NULL,
  "visitorHash" TEXT,
  "sessionHash" TEXT,
  "referrerHost" TEXT,
  "utmSource" TEXT,
  "utmMedium" TEXT,
  "utmCampaign" TEXT,
  "deviceType" TEXT,
  "metadata" JSONB DEFAULT '{}'::jsonb NOT NULL,
  "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL,
  CONSTRAINT "website_analytics_event_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- 3) Add columns introduced after the checked-in migration history
--    IF NOT EXISTS also converges partially db-pushed environments.
-- ---------------------------------------------------------------------------
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "action" TEXT NOT NULL;
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "entityType" TEXT NOT NULL;
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "entityId" TEXT;
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "description" TEXT NOT NULL;
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "metadata" JSONB;
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "ActivityLog" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "mobileNumber" TEXT;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "zipcode" TEXT;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "country" "Country";
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "state" TEXT;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "businessEmail" TEXT;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "businessType" TEXT;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "businessDescription" TEXT;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "businessHours" JSONB;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "website" TEXT;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "onboardingCompletedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL;
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "onboardingCompletedAt" TIMESTAMP(3);
ALTER TABLE "AdminProfile" ADD COLUMN IF NOT EXISTS "skippedSteps" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL;
ALTER TABLE "WorkLocation" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "WorkLocation" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
ALTER TABLE "WorkLocation" ADD COLUMN IF NOT EXISTS "geocodedAt" TIMESTAMP(3);
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "rules" JSONB DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "addons" JSONB DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "pricing_rules" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "type" "NotificationType" NOT NULL;
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "title" TEXT NOT NULL;
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "message" TEXT NOT NULL;
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "relatedId" TEXT;
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "isRead" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "notification" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "notification_template" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "notification_template" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "notification_template" ADD COLUMN IF NOT EXISTS "key" TEXT NOT NULL;
ALTER TABLE "notification_template" ADD COLUMN IF NOT EXISTS "channel" TEXT DEFAULT 'EMAIL' NOT NULL;
ALTER TABLE "notification_template" ADD COLUMN IF NOT EXISTS "subject" TEXT;
ALTER TABLE "notification_template" ADD COLUMN IF NOT EXISTS "body" TEXT NOT NULL;
ALTER TABLE "notification_template" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "notification_template" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "user" ADD COLUMN IF NOT EXISTS "country" TEXT;
ALTER TABLE "push_subscription" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "push_subscription" ADD COLUMN IF NOT EXISTS "endpoint" TEXT NOT NULL;
ALTER TABLE "push_subscription" ADD COLUMN IF NOT EXISTS "p256dh" TEXT NOT NULL;
ALTER TABLE "push_subscription" ADD COLUMN IF NOT EXISTS "auth" TEXT NOT NULL;
ALTER TABLE "push_subscription" ADD COLUMN IF NOT EXISTS "userId" TEXT NOT NULL;
ALTER TABLE "push_subscription" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "push_subscription" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "BillingHistory" ADD COLUMN IF NOT EXISTS "paymentProofUrl" TEXT;
ALTER TABLE "BillingHistory" ADD COLUMN IF NOT EXISTS "planChangeId" TEXT;
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "serviceNameSnapshot" TEXT;
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "priceSnapshot" DECIMAL(10,2);
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "durationSnapshot" TEXT;
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "addOnSnapshot" JSONB DEFAULT '[]'::jsonb;
ALTER TABLE "booking" ADD COLUMN IF NOT EXISTS "recurringScheduleId" TEXT;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "type" "BookingChangeRequestType" NOT NULL;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "status" "BookingChangeRequestStatus" DEFAULT 'PENDING' NOT NULL;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "requestedDate" TIMESTAMP(3);
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "reason" TEXT;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "decisionNote" TEXT;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "decidedAt" TIMESTAMP(3);
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "decidedBy" TEXT;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "bookingId" TEXT NOT NULL;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "clientId" TEXT NOT NULL;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "booking_change_request" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "checklist_template" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "checklist_template" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL;
ALTER TABLE "checklist_template" ADD COLUMN IF NOT EXISTS "serviceType" "ServiceType";
ALTER TABLE "checklist_template" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "checklist_template" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "checklist_template" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "checklist_template" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "checklist_task" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "checklist_task" ADD COLUMN IF NOT EXISTS "title" TEXT NOT NULL;
ALTER TABLE "checklist_task" ADD COLUMN IF NOT EXISTS "required" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "checklist_task" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "checklist_task" ADD COLUMN IF NOT EXISTS "templateId" TEXT NOT NULL;
ALTER TABLE "job_checklist" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "job_checklist" ADD COLUMN IF NOT EXISTS "jobId" TEXT NOT NULL;
ALTER TABLE "job_checklist" ADD COLUMN IF NOT EXISTS "templateId" TEXT NOT NULL;
ALTER TABLE "job_checklist" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "job_checklist" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "job_checklist_item" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "job_checklist_item" ADD COLUMN IF NOT EXISTS "checklistId" TEXT NOT NULL;
ALTER TABLE "job_checklist_item" ADD COLUMN IF NOT EXISTS "title" TEXT NOT NULL;
ALTER TABLE "job_checklist_item" ADD COLUMN IF NOT EXISTS "required" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "job_checklist_item" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "job_checklist_item" ADD COLUMN IF NOT EXISTS "completed" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "job_checklist_item" ADD COLUMN IF NOT EXISTS "completedAt" TIMESTAMP(3);
ALTER TABLE "job_checklist_item" ADD COLUMN IF NOT EXISTS "completedBy" TEXT;
ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "zipcode" TEXT;
ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "geocodedAt" TIMESTAMP(3);
ALTER TABLE "client" ADD COLUMN IF NOT EXISTS "portalAccessToken" TEXT;
ALTER TABLE "Coupon" ADD COLUMN IF NOT EXISTS "currency" "Currency";
ALTER TABLE "booking_form" ADD COLUMN IF NOT EXISTS "websiteManaged" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "booking_form" ADD COLUMN IF NOT EXISTS "maxBookingsPerSlot" INTEGER DEFAULT 1 NOT NULL;
ALTER TABLE "booking_form" ADD COLUMN IF NOT EXISTS "slotDurationMinutes" INTEGER DEFAULT 120 NOT NULL;
ALTER TABLE "booking_form" ADD COLUMN IF NOT EXISTS "bufferTimeMinutes" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "booking_form_service" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "serviceNameSnapshot" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "priceSnapshot" DECIMAL(10,2);
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "durationSnapshot" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "addOnIds" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "addOnSnapshot" JSONB DEFAULT '[]'::jsonb;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "totalSnapshot" DECIMAL(10,2);
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "convertedBookingId" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "convertedAt" TIMESTAMP(3);
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "sourceWebsiteId" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "source" TEXT DEFAULT 'PUBLIC_LINK' NOT NULL;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "sourcePage" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "utmSource" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "utmCampaign" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "propertyType" TEXT;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "bedrooms" INTEGER;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "bathrooms" INTEGER;
ALTER TABLE "booking_form_submission" ADD COLUMN IF NOT EXISTS "answers" JSONB;
ALTER TABLE "estimate_form_service" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "serviceNameSnapshot" TEXT;
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "priceSnapshot" DECIMAL(10,2);
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "durationSnapshot" TEXT;
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "sourceWebsiteId" TEXT;
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "city" TEXT;
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "answers" JSONB;
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "estimatedMin" DECIMAL(10,2);
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "estimatedMax" DECIMAL(10,2);
ALTER TABLE "estimate_form_submission" ADD COLUMN IF NOT EXISTS "pricingSnapshot" JSONB;
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "clientName" TEXT;
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "clientEmail" TEXT;
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "serviceAddress" TEXT;
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "linkedBookingRef" TEXT;
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "serviceNameSnapshot" TEXT;
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "lineItems" JSONB DEFAULT '[]'::jsonb;
ALTER TABLE "invoice" ADD COLUMN IF NOT EXISTS "taxAmount" DECIMAL(10,2);
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "serviceNameSnapshot" TEXT;
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "priceSnapshot" DECIMAL(10,2);
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "durationSnapshot" TEXT;
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
ALTER TABLE "job" ADD COLUMN IF NOT EXISTS "geocodedAt" TIMESTAMP(3);
ALTER TABLE "job_staff_assignment" ADD COLUMN IF NOT EXISTS "checkInAt" TIMESTAMP(3);
ALTER TABLE "job_staff_assignment" ADD COLUMN IF NOT EXISTS "checkOutAt" TIMESTAMP(3);
ALTER TABLE "job_staff_assignment" ADD COLUMN IF NOT EXISTS "hoursWorked" DECIMAL(6,2);
ALTER TABLE "job_note" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "job_note" ADD COLUMN IF NOT EXISTS "jobId" TEXT NOT NULL;
ALTER TABLE "job_note" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "job_note" ADD COLUMN IF NOT EXISTS "type" "NoteType" DEFAULT 'GENERAL' NOT NULL;
ALTER TABLE "job_note" ADD COLUMN IF NOT EXISTS "body" TEXT NOT NULL;
ALTER TABLE "job_note" ADD COLUMN IF NOT EXISTS "pinned" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "job_note" ADD COLUMN IF NOT EXISTS "authorName" TEXT NOT NULL;
ALTER TABLE "job_note" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "job_note" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "jobId" TEXT NOT NULL;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "fileName" TEXT NOT NULL;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "fileUrl" TEXT NOT NULL;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "cloudinaryId" TEXT NOT NULL;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "mimeType" TEXT NOT NULL;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "fileSizeBytes" INTEGER NOT NULL;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "uploadedByRole" TEXT DEFAULT 'ADMIN' NOT NULL;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "photoType" TEXT;
ALTER TABLE "job_attachment" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "leadRef" TEXT NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "email" TEXT NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "phone" TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "serviceInterest" TEXT NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "estimatedMin" DECIMAL(10,2) DEFAULT 0 NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "estimatedMax" DECIMAL(10,2) DEFAULT 0 NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "stage" "LeadStage" DEFAULT 'NEW' NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "sourceRef" TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "sourceWebsiteId" TEXT;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "lead" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "topic" TEXT NOT NULL;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "dedupeKey" TEXT;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "payload" JSONB NOT NULL;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'PENDING' NOT NULL;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "attempts" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "maxAttempts" INTEGER DEFAULT 8 NOT NULL;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "lockedAt" TIMESTAMP(3);
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "processedAt" TIMESTAMP(3);
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "lastError" TEXT;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "outbox_event" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "paymentProofUrl" TEXT;
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "approvedByUserId" TEXT;
ALTER TABLE "payment" ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;
ALTER TABLE "quote" ADD COLUMN IF NOT EXISTS "publicToken" VARCHAR(64);
ALTER TABLE "quote" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "quote" ADD COLUMN IF NOT EXISTS "serviceNameSnapshot" TEXT;
ALTER TABLE "quote" ADD COLUMN IF NOT EXISTS "respondedAt" TIMESTAMP(3);
ALTER TABLE "quote" ADD COLUMN IF NOT EXISTS "responseNote" TEXT;
ALTER TABLE "estimate" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "estimate" ADD COLUMN IF NOT EXISTS "serviceNameSnapshot" TEXT;
ALTER TABLE "estimate" ADD COLUMN IF NOT EXISTS "convertedToQuoteRef" TEXT;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "name" TEXT NOT NULL;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "serviceType" TEXT;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "serviceNameSnapshot" TEXT;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "taxRate" DECIMAL(5,2) DEFAULT 20 NOT NULL;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "usageCount" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "lastUsedAt" TIMESTAMP(3);
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "quote_template" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "quote_template_line_item" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "quote_template_line_item" ADD COLUMN IF NOT EXISTS "description" TEXT NOT NULL;
ALTER TABLE "quote_template_line_item" ADD COLUMN IF NOT EXISTS "quantity" INTEGER DEFAULT 1 NOT NULL;
ALTER TABLE "quote_template_line_item" ADD COLUMN IF NOT EXISTS "unitPrice" DECIMAL(10,2) NOT NULL;
ALTER TABLE "quote_template_line_item" ADD COLUMN IF NOT EXISTS "templateId" TEXT NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "scheduleRef" TEXT NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "clientId" TEXT NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "serviceType" "ServiceType";
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "serviceCatalogId" TEXT;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "serviceNameSnapshot" TEXT;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "priceSnapshot" DECIMAL(10,2);
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "durationSnapshot" TEXT;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "address" TEXT NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "durationMins" INTEGER NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "total" DECIMAL(10,2) NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "notes" TEXT;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "frequency" "RecurringFrequency" NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "dayOfWeek" "WeekDay" NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "timeHour" INTEGER NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "timeMinute" INTEGER NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "status" "RecurringStatus" DEFAULT 'ACTIVE' NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "startDate" TIMESTAMP(3) NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "nextRunAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "lastRunAt" TIMESTAMP(3);
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "recurring_schedule" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "recurring_staff_assignment" ADD COLUMN IF NOT EXISTS "scheduleId" TEXT NOT NULL;
ALTER TABLE "recurring_staff_assignment" ADD COLUMN IF NOT EXISTS "staffId" TEXT NOT NULL;
ALTER TABLE "review_token" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "review_token" ADD COLUMN IF NOT EXISTS "token" TEXT NOT NULL;
ALTER TABLE "review_token" ADD COLUMN IF NOT EXISTS "jobId" TEXT NOT NULL;
ALTER TABLE "review_token" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "review_token" ADD COLUMN IF NOT EXISTS "used" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "review_token" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "review_token" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "reviewTokenId" TEXT NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "jobId" TEXT NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "staffId" TEXT;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "clientName" TEXT NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "rating" INTEGER NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "comment" TEXT DEFAULT '' NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "sentiment" TEXT DEFAULT 'neutral' NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "status" TEXT DEFAULT 'pending' NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "isPublished" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "tags" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "adminReply" TEXT;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "review" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "serviceName" TEXT NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "description" TEXT NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "basePriceGbp" DOUBLE PRECISION DEFAULT 0.0 NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "duration" TEXT NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "category" TEXT NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "status" "ServiceStatus" DEFAULT 'ACTIVE' NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "onlineBookingEnabled" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "legacyServiceType" "ServiceType";
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "addOns" JSONB DEFAULT '[]'::jsonb;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "service_catalog" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "latitude" DOUBLE PRECISION;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "longitude" DOUBLE PRECISION;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "geocodedAt" TIMESTAMP(3);
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "hourlyRate" DOUBLE PRECISION;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "startDate" TIMESTAMP(3) NOT NULL;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "specialty" TEXT[] DEFAULT ARRAY[]::TEXT[] NOT NULL;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "status" "StaffStatus" DEFAULT 'ACTIVE' NOT NULL;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "emergencyName" TEXT;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "emergencyMobileNumber" TEXT;
ALTER TABLE "StaffProfile" ADD COLUMN IF NOT EXISTS "adminNote" TEXT;
ALTER TABLE "StaffLeave" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "StaffLeave" ADD COLUMN IF NOT EXISTS "startDate" TIMESTAMP(3) NOT NULL;
ALTER TABLE "StaffLeave" ADD COLUMN IF NOT EXISTS "endDate" TIMESTAMP(3) NOT NULL;
ALTER TABLE "StaffLeave" ADD COLUMN IF NOT EXISTS "reason" TEXT;
ALTER TABLE "StaffLeave" ADD COLUMN IF NOT EXISTS "status" "LeaveStatus" DEFAULT 'PENDING' NOT NULL;
ALTER TABLE "StaffLeave" ADD COLUMN IF NOT EXISTS "adminNote" TEXT;
ALTER TABLE "StaffLeave" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "StaffLeave" ADD COLUMN IF NOT EXISTS "staffId" TEXT NOT NULL;
ALTER TABLE "StaffLeave" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "StaffLeave" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "baseCharge" DECIMAL(10,2) DEFAULT 0.0 NOT NULL;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "pricePerStaff" DECIMAL(10,2) DEFAULT 0.0 NOT NULL;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "pricePerClient" DECIMAL(10,2) DEFAULT 0.0 NOT NULL;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "pricePerBooking" DECIMAL(10,2) DEFAULT 0.0 NOT NULL;
ALTER TABLE "Plan" ADD COLUMN IF NOT EXISTS "discountEndDate" TIMESTAMP(3);
ALTER TABLE "SubscriptionPlan" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "SubscriptionPlan" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "SubscriptionPlan" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3);
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "status" "PendingPlanChangeStatus" DEFAULT 'AWAITING_PAYMENT' NOT NULL;
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "quotedAmount" DECIMAL(10,2) NOT NULL;
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "currency" "Currency" DEFAULT 'USD' NOT NULL;
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "submittedAt" TIMESTAMP(3);
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "reviewedAt" TIMESTAMP(3);
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "rejectionReason" TEXT;
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "subscriptionId" TEXT NOT NULL;
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "targetPlanId" TEXT NOT NULL;
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "couponId" TEXT;
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "PendingPlanChange" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "super_admin_config" ADD COLUMN IF NOT EXISTS "key" TEXT NOT NULL;
ALTER TABLE "super_admin_config" ADD COLUMN IF NOT EXISTS "value" TEXT NOT NULL;
ALTER TABLE "super_admin_config" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "adminId" TEXT NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "subdomain" TEXT NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "status" "WebsiteStatus" DEFAULT 'PROVISIONED' NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "templateId" TEXT DEFAULT 'clean-modern' NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "templateVersion" TEXT DEFAULT '1.0.0' NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "schemaVersion" INTEGER DEFAULT 1 NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "primaryColor" TEXT DEFAULT '#0F766E' NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "secondaryColor" TEXT DEFAULT '#0F172A' NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "accentColor" TEXT DEFAULT '#14B8A6' NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "font" TEXT;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "logo" TEXT;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "favicon" TEXT;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "primaryBookingFormId" TEXT;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "primaryEstimateFormId" TEXT;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "bookingEnabled" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "bookingShowNavigation" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "bookingShowHeaderCta" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "bookingShowServiceCtas" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "bookingShowHomeCta" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "bookingShowAvailableSlots" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "bookingShowPrices" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "bookingShowStartingPrices" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "bookingShowServiceDuration" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "bookingCtaLabel" TEXT DEFAULT 'Book Now' NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "estimateEnabled" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "metaTitle" TEXT;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "metaDescription" TEXT;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "socialImageUrl" TEXT;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "indexSite" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "publishedAt" TIMESTAMP(3);
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "publishedSnapshot" JSONB;
ALTER TABLE "business_website" ADD COLUMN IF NOT EXISTS "publishedRevisionNumber" INTEGER;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "websiteId" TEXT NOT NULL;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "kind" "WebsitePageKind" NOT NULL;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "slug" TEXT NOT NULL;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "title" TEXT NOT NULL;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "content" JSONB DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "seoTitle" TEXT;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "seoDescription" TEXT;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "showInNavigation" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "isEnabled" BOOLEAN DEFAULT true NOT NULL;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "sortOrder" INTEGER DEFAULT 0 NOT NULL;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "website_page" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "website_revision" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "website_revision" ADD COLUMN IF NOT EXISTS "websiteId" TEXT NOT NULL;
ALTER TABLE "website_revision" ADD COLUMN IF NOT EXISTS "revisionNumber" INTEGER NOT NULL;
ALTER TABLE "website_revision" ADD COLUMN IF NOT EXISTS "snapshot" JSONB NOT NULL;
ALTER TABLE "website_revision" ADD COLUMN IF NOT EXISTS "reason" TEXT;
ALTER TABLE "website_revision" ADD COLUMN IF NOT EXISTS "createdByUserId" TEXT;
ALTER TABLE "website_revision" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "websiteId" TEXT NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "domain" TEXT NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "status" "WebsiteDomainStatus" DEFAULT 'PENDING' NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "verificationToken" TEXT NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "requiredDns" JSONB DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "isPrimary" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "verificationStartedAt" TIMESTAMP(3);
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "lastCheckedAt" TIMESTAMP(3);
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "verifiedAt" TIMESTAMP(3);
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "failureReason" TEXT;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "provider" TEXT DEFAULT 'MANUAL' NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "providerVerified" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "ownershipVerified" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "routingVerified" BOOLEAN DEFAULT false NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "tlsStatus" TEXT DEFAULT 'PENDING' NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "lastProviderSyncAt" TIMESTAMP(3);
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "providerData" JSONB DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "website_domain" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL;
ALTER TABLE "website_subdomain_alias" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "website_subdomain_alias" ADD COLUMN IF NOT EXISTS "websiteId" TEXT NOT NULL;
ALTER TABLE "website_subdomain_alias" ADD COLUMN IF NOT EXISTS "subdomain" TEXT NOT NULL;
ALTER TABLE "website_subdomain_alias" ADD COLUMN IF NOT EXISTS "redirectCode" INTEGER DEFAULT 308 NOT NULL;
ALTER TABLE "website_subdomain_alias" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "websiteId" TEXT NOT NULL;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "publicId" TEXT NOT NULL;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "url" TEXT NOT NULL;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "mimeType" TEXT NOT NULL;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "width" INTEGER;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "height" INTEGER;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "bytes" INTEGER;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "altText" TEXT;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "folder" TEXT NOT NULL;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "metadata" JSONB DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "website_asset" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "id" TEXT NOT NULL;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "websiteId" TEXT NOT NULL;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "eventType" TEXT NOT NULL;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "path" TEXT DEFAULT '/' NOT NULL;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "visitorHash" TEXT;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "sessionHash" TEXT;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "referrerHost" TEXT;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "utmSource" TEXT;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "utmMedium" TEXT;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "utmCampaign" TEXT;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "deviceType" TEXT;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "metadata" JSONB DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "website_analytics_event" ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP NOT NULL;

-- ---------------------------------------------------------------------------
-- 4) Lossless transforms and backfills for legacy populated tables
-- ---------------------------------------------------------------------------
-- SubscriptionPlan.features used to be TEXT[]. Preserve every label while moving to JSONB.
DO $$
DECLARE current_type text;
BEGIN
  SELECT data_type INTO current_type
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'SubscriptionPlan' AND column_name = 'features';
  IF current_type = 'ARRAY' THEN
    ALTER TABLE "SubscriptionPlan" ALTER COLUMN "features" DROP DEFAULT;
    ALTER TABLE "SubscriptionPlan" ALTER COLUMN "features" TYPE JSONB
      USING COALESCE(to_jsonb("features"), '[]'::jsonb);
  END IF;
END $$;
ALTER TABLE "SubscriptionPlan" ALTER COLUMN "features" SET DEFAULT '[]'::jsonb;
UPDATE "SubscriptionPlan" SET "features" = '[]'::jsonb WHERE "features" IS NULL;
ALTER TABLE "SubscriptionPlan" ALTER COLUMN "features" SET NOT NULL;

UPDATE "SubscriptionPlan" SET "updatedAt" = COALESCE("updatedAt", "createdAt", CURRENT_TIMESTAMP) WHERE "updatedAt" IS NULL;
ALTER TABLE "SubscriptionPlan" ALTER COLUMN "updatedAt" SET NOT NULL;

-- Client servicePreference moved from ServiceType to a catalog-compatible String.
DO $$
DECLARE udt text;
BEGIN
  SELECT udt_name INTO udt FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = 'client' AND column_name = 'servicePreference';
  IF udt = 'ServiceType' THEN
    ALTER TABLE "client" ALTER COLUMN "servicePreference" DROP DEFAULT;
    ALTER TABLE "client" ALTER COLUMN "servicePreference" TYPE TEXT
      USING COALESCE("servicePreference"::text, '');
  END IF;
END $$;
UPDATE "client" SET "servicePreference" = '' WHERE "servicePreference" IS NULL;
ALTER TABLE "client" ALTER COLUMN "servicePreference" SET DEFAULT '';
ALTER TABLE "client" ALTER COLUMN "servicePreference" SET NOT NULL;

-- Current Client requires these fields. Legacy postcode is retained for historical compatibility.
ALTER TABLE "client" ALTER COLUMN "postcode" SET DEFAULT '';
UPDATE "client" SET "phone" = '' WHERE "phone" IS NULL;
UPDATE "client" SET "country" = '' WHERE "country" IS NULL;
UPDATE "client" SET "zipcode" = COALESCE(NULLIF("zipcode", ''), "postcode", '') WHERE "zipcode" IS NULL OR "zipcode" = '';
UPDATE "client" SET "portalAccessToken" = gen_random_uuid()::text WHERE "portalAccessToken" IS NULL OR btrim("portalAccessToken") = '';
ALTER TABLE "client" ALTER COLUMN "phone" SET NOT NULL;
ALTER TABLE "client" ALTER COLUMN "country" SET NOT NULL;
ALTER TABLE "client" ALTER COLUMN "zipcode" SET NOT NULL;
ALTER TABLE "client" ALTER COLUMN "portalAccessToken" SET NOT NULL;

-- Legacy required creator/address/tax columns must have defaults because current Prisma no longer writes them.
ALTER TABLE "client_note" ALTER COLUMN "createdBy" SET DEFAULT '';
ALTER TABLE "invoice" ALTER COLUMN "address" SET DEFAULT '';
ALTER TABLE "invoice" ALTER COLUMN "tax" SET DEFAULT 0;

-- Invoice became a standalone client snapshot. Backfill from the retained legacy relation before relaxing it.
UPDATE "invoice" i
SET
  "clientName" = COALESCE(i."clientName", c."name", 'Legacy client'),
  "clientEmail" = COALESCE(i."clientEmail", c."email", ''),
  "serviceAddress" = COALESCE(i."serviceAddress", i."address", ''),
  "taxAmount" = COALESCE(i."taxAmount", i."tax", 0),
  "serviceNameSnapshot" = COALESCE(i."serviceNameSnapshot", i."serviceType"::text)
FROM "client" c
WHERE i."clientId" = c."id";

UPDATE "invoice"
SET
  "clientName" = COALESCE("clientName", 'Legacy client'),
  "clientEmail" = COALESCE("clientEmail", ''),
  "serviceAddress" = COALESCE("serviceAddress", "address", ''),
  "taxAmount" = COALESCE("taxAmount", "tax", 0),
  "serviceNameSnapshot" = COALESCE("serviceNameSnapshot", "serviceType"::text)
WHERE "clientName" IS NULL OR "clientEmail" IS NULL OR "serviceAddress" IS NULL OR "taxAmount" IS NULL;

UPDATE "invoice" i
SET "lineItems" = COALESCE(items.payload, '[]'::jsonb)
FROM (
  SELECT "invoiceId",
         jsonb_agg(jsonb_build_object(
           'description', "description",
           'quantity', "quantity",
           'unitPrice', "unitPrice",
           'total', "total"
         ) ORDER BY "id") AS payload
  FROM "invoice_line_item"
  GROUP BY "invoiceId"
) items
WHERE items."invoiceId" = i."id" AND (i."lineItems" IS NULL OR i."lineItems" = '[]'::jsonb);

UPDATE "invoice" i
SET "linkedBookingRef" = b."bookingRef"
FROM "booking" b
WHERE i."bookingId" = b."id" AND i."linkedBookingRef" IS NULL;

ALTER TABLE "invoice" ALTER COLUMN "clientName" SET NOT NULL;
ALTER TABLE "invoice" ALTER COLUMN "clientEmail" SET NOT NULL;
ALTER TABLE "invoice" ALTER COLUMN "serviceAddress" SET NOT NULL;
ALTER TABLE "invoice" ALTER COLUMN "taxAmount" SET NOT NULL;

-- Old serviceType/client relations remain readable but are no longer canonical/current-required.
ALTER TABLE "booking" ALTER COLUMN "serviceType" DROP NOT NULL;
ALTER TABLE "booking_form_service" ALTER COLUMN "serviceType" DROP NOT NULL;
ALTER TABLE "booking_form_submission" ALTER COLUMN "serviceType" DROP NOT NULL;
ALTER TABLE "estimate" ALTER COLUMN "serviceType" DROP NOT NULL;
ALTER TABLE "estimate_form_service" ALTER COLUMN "serviceType" DROP NOT NULL;
ALTER TABLE "estimate_form_submission" ALTER COLUMN "serviceType" DROP NOT NULL;
ALTER TABLE "job" ALTER COLUMN "serviceType" DROP NOT NULL;
ALTER TABLE "quote" ALTER COLUMN "serviceType" DROP NOT NULL;
ALTER TABLE "invoice" ALTER COLUMN "serviceType" DROP NOT NULL;
ALTER TABLE "invoice" ALTER COLUMN "clientId" DROP NOT NULL;

-- ---------------------------------------------------------------------------
-- 5) Current Prisma indexes / uniqueness constraints
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "ActivityLog_adminId_idx" ON "ActivityLog"("adminId");
CREATE INDEX IF NOT EXISTS "ActivityLog_action_idx" ON "ActivityLog"("action");
CREATE INDEX IF NOT EXISTS "ActivityLog_entityType_idx" ON "ActivityLog"("entityType");
CREATE INDEX IF NOT EXISTS "ActivityLog_createdAt_idx" ON "ActivityLog"("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "AdminProfile_userId_key" ON "AdminProfile"("userId");
CREATE INDEX IF NOT EXISTS "AdminProfile_createdAt_idx" ON "AdminProfile"("createdAt");
CREATE INDEX IF NOT EXISTS "WorkLocation_adminId_idx" ON "WorkLocation"("adminId");
CREATE UNIQUE INDEX IF NOT EXISTS "notification_preference_adminId_key" ON "notification_preference"("adminId");
CREATE UNIQUE INDEX IF NOT EXISTS "pricing_rules_adminId_key" ON "pricing_rules"("adminId");
CREATE INDEX IF NOT EXISTS "notification_adminId_isRead_idx" ON "notification"("adminId", "isRead");
CREATE INDEX IF NOT EXISTS "notification_adminId_createdAt_idx" ON "notification"("adminId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "notification_template_adminId_key_key" ON "notification_template"("adminId", "key");
CREATE INDEX IF NOT EXISTS "notification_template_adminId_idx" ON "notification_template"("adminId");
CREATE UNIQUE INDEX IF NOT EXISTS "user_email_key" ON "user"("email");
CREATE INDEX IF NOT EXISTS "user_role_idx" ON "user"("role");
CREATE UNIQUE INDEX IF NOT EXISTS "push_subscription_endpoint_key" ON "push_subscription"("endpoint");
CREATE INDEX IF NOT EXISTS "push_subscription_userId_idx" ON "push_subscription"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "session_token_key" ON "session"("token");
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"("userId");
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" ON "verification"("identifier");
CREATE INDEX IF NOT EXISTS "BillingHistory_status_createdAt_idx" ON "BillingHistory"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "BillingHistory_subscriptionId_idx" ON "BillingHistory"("subscriptionId");
CREATE INDEX IF NOT EXISTS "BillingHistory_planChangeId_createdAt_idx" ON "BillingHistory"("planChangeId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "booking_bookingRef_key" ON "booking"("bookingRef");
CREATE INDEX IF NOT EXISTS "booking_adminId_status_idx" ON "booking"("adminId", "status");
CREATE INDEX IF NOT EXISTS "booking_adminId_status_createdAt_idx" ON "booking"("adminId", "status", "createdAt" DESC);
CREATE INDEX IF NOT EXISTS "booking_clientId_idx" ON "booking"("clientId");
CREATE INDEX IF NOT EXISTS "booking_scheduledDate_idx" ON "booking"("scheduledDate");
CREATE INDEX IF NOT EXISTS "booking_serviceCatalogId_idx" ON "booking"("serviceCatalogId");
CREATE INDEX IF NOT EXISTS "booking_change_request_adminId_status_idx" ON "booking_change_request"("adminId", "status");
CREATE INDEX IF NOT EXISTS "booking_change_request_bookingId_idx" ON "booking_change_request"("bookingId");
CREATE INDEX IF NOT EXISTS "booking_change_request_clientId_idx" ON "booking_change_request"("clientId");
CREATE INDEX IF NOT EXISTS "checklist_template_adminId_idx" ON "checklist_template"("adminId");
CREATE INDEX IF NOT EXISTS "checklist_template_serviceCatalogId_idx" ON "checklist_template"("serviceCatalogId");
CREATE INDEX IF NOT EXISTS "checklist_task_templateId_idx" ON "checklist_task"("templateId");
CREATE UNIQUE INDEX IF NOT EXISTS "job_checklist_jobId_templateId_key" ON "job_checklist"("jobId", "templateId");
CREATE INDEX IF NOT EXISTS "job_checklist_adminId_idx" ON "job_checklist"("adminId");
CREATE INDEX IF NOT EXISTS "job_checklist_item_checklistId_idx" ON "job_checklist_item"("checklistId");
CREATE UNIQUE INDEX IF NOT EXISTS "client_portalAccessToken_key" ON "client"("portalAccessToken");
CREATE UNIQUE INDEX IF NOT EXISTS "client_email_adminId_key" ON "client"("email", "adminId");
CREATE INDEX IF NOT EXISTS "client_adminId_idx" ON "client"("adminId");
CREATE INDEX IF NOT EXISTS "client_status_idx" ON "client"("status");
CREATE INDEX IF NOT EXISTS "client_note_clientId_idx" ON "client_note"("clientId");
CREATE UNIQUE INDEX IF NOT EXISTS "Coupon_code_key" ON "Coupon"("code");
CREATE UNIQUE INDEX IF NOT EXISTS "CouponUsage_couponId_adminId_key" ON "CouponUsage"("couponId", "adminId");
CREATE UNIQUE INDEX IF NOT EXISTS "expense_expenseRef_key" ON "expense"("expenseRef");
CREATE INDEX IF NOT EXISTS "expense_adminId_category_idx" ON "expense"("adminId", "category");
CREATE INDEX IF NOT EXISTS "expense_date_idx" ON "expense"("date");
CREATE INDEX IF NOT EXISTS "expense_adminId_date_idx" ON "expense"("adminId", "date");
CREATE UNIQUE INDEX IF NOT EXISTS "booking_form_slug_key" ON "booking_form"("slug");
CREATE INDEX IF NOT EXISTS "booking_form_adminId_idx" ON "booking_form"("adminId");
CREATE INDEX IF NOT EXISTS "booking_form_adminId_published_idx" ON "booking_form"("adminId", "published");
CREATE INDEX IF NOT EXISTS "booking_form_field_formId_idx" ON "booking_form_field"("formId");
CREATE UNIQUE INDEX IF NOT EXISTS "booking_form_service_formId_serviceCatalogId_key" ON "booking_form_service"("formId", "serviceCatalogId");
CREATE INDEX IF NOT EXISTS "booking_form_service_formId_serviceType_idx" ON "booking_form_service"("formId", "serviceType");
CREATE INDEX IF NOT EXISTS "booking_form_service_serviceCatalogId_idx" ON "booking_form_service"("serviceCatalogId");
CREATE UNIQUE INDEX IF NOT EXISTS "booking_form_submission_ref_key" ON "booking_form_submission"("ref");
CREATE UNIQUE INDEX IF NOT EXISTS "booking_form_submission_convertedBookingId_key" ON "booking_form_submission"("convertedBookingId");
CREATE INDEX IF NOT EXISTS "booking_form_submission_formId_status_idx" ON "booking_form_submission"("formId", "status");
CREATE INDEX IF NOT EXISTS "booking_form_submission_serviceCatalogId_idx" ON "booking_form_submission"("serviceCatalogId");
CREATE INDEX IF NOT EXISTS "booking_form_submission_sourceWebsiteId_createdAt_idx" ON "booking_form_submission"("sourceWebsiteId", "createdAt");
CREATE INDEX IF NOT EXISTS "booking_form_submission_source_createdAt_idx" ON "booking_form_submission"("source", "createdAt");
CREATE INDEX IF NOT EXISTS "booking_form_submission_utmSource_createdAt_idx" ON "booking_form_submission"("utmSource", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "booking_form_submission_formId_idempotencyKey_key" ON "booking_form_submission"("formId", "idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_form_slug_key" ON "estimate_form"("slug");
CREATE INDEX IF NOT EXISTS "estimate_form_adminId_idx" ON "estimate_form"("adminId");
CREATE INDEX IF NOT EXISTS "estimate_form_field_formId_idx" ON "estimate_form_field"("formId");
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_form_service_formId_serviceCatalogId_key" ON "estimate_form_service"("formId", "serviceCatalogId");
CREATE INDEX IF NOT EXISTS "estimate_form_service_formId_serviceType_idx" ON "estimate_form_service"("formId", "serviceType");
CREATE INDEX IF NOT EXISTS "estimate_form_service_serviceCatalogId_idx" ON "estimate_form_service"("serviceCatalogId");
CREATE INDEX IF NOT EXISTS "estimate_form_add_on_formId_idx" ON "estimate_form_add_on"("formId");
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_form_submission_ref_key" ON "estimate_form_submission"("ref");
CREATE INDEX IF NOT EXISTS "estimate_form_submission_formId_status_idx" ON "estimate_form_submission"("formId", "status");
CREATE INDEX IF NOT EXISTS "estimate_form_submission_serviceCatalogId_idx" ON "estimate_form_submission"("serviceCatalogId");
CREATE INDEX IF NOT EXISTS "estimate_form_submission_sourceWebsiteId_createdAt_idx" ON "estimate_form_submission"("sourceWebsiteId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_form_submission_formId_idempotencyKey_key" ON "estimate_form_submission"("formId", "idempotencyKey");
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_invoiceRef_key" ON "invoice"("invoiceRef");
CREATE UNIQUE INDEX IF NOT EXISTS "invoice_bookingId_key" ON "invoice"("bookingId");
CREATE INDEX IF NOT EXISTS "invoice_adminId_idx" ON "invoice"("adminId");
CREATE INDEX IF NOT EXISTS "invoice_adminId_status_idx" ON "invoice"("adminId", "status");
CREATE INDEX IF NOT EXISTS "invoice_dueDate_idx" ON "invoice"("dueDate");
CREATE INDEX IF NOT EXISTS "invoice_adminId_status_paidDate_idx" ON "invoice"("adminId", "status", "paidDate");
CREATE UNIQUE INDEX IF NOT EXISTS "job_jobRef_key" ON "job"("jobRef");
CREATE UNIQUE INDEX IF NOT EXISTS "job_bookingId_key" ON "job"("bookingId");
CREATE INDEX IF NOT EXISTS "job_adminId_status_idx" ON "job"("adminId", "status");
CREATE INDEX IF NOT EXISTS "job_clientId_idx" ON "job"("clientId");
CREATE INDEX IF NOT EXISTS "job_scheduledDate_idx" ON "job"("scheduledDate");
CREATE INDEX IF NOT EXISTS "job_serviceCatalogId_idx" ON "job"("serviceCatalogId");
CREATE INDEX IF NOT EXISTS "job_adminId_createdAt_idx" ON "job"("adminId", "createdAt");
CREATE INDEX IF NOT EXISTS "job_adminId_status_updatedAt_idx" ON "job"("adminId", "status", "updatedAt");
CREATE INDEX IF NOT EXISTS "job_staff_assignment_staffId_idx" ON "job_staff_assignment"("staffId");
CREATE INDEX IF NOT EXISTS "job_note_jobId_idx" ON "job_note"("jobId");
CREATE INDEX IF NOT EXISTS "job_note_adminId_idx" ON "job_note"("adminId");
CREATE INDEX IF NOT EXISTS "job_attachment_jobId_idx" ON "job_attachment"("jobId");
CREATE INDEX IF NOT EXISTS "job_attachment_adminId_idx" ON "job_attachment"("adminId");
CREATE UNIQUE INDEX IF NOT EXISTS "lead_leadRef_key" ON "lead"("leadRef");
CREATE UNIQUE INDEX IF NOT EXISTS "lead_email_adminId_key" ON "lead"("email", "adminId");
CREATE INDEX IF NOT EXISTS "lead_adminId_idx" ON "lead"("adminId");
CREATE INDEX IF NOT EXISTS "lead_adminId_phone_idx" ON "lead"("adminId", "phone");
CREATE INDEX IF NOT EXISTS "lead_adminId_serviceCatalogId_idx" ON "lead"("adminId", "serviceCatalogId");
CREATE INDEX IF NOT EXISTS "lead_sourceWebsiteId_createdAt_idx" ON "lead"("sourceWebsiteId", "createdAt");
CREATE INDEX IF NOT EXISTS "lead_stage_idx" ON "lead"("stage");
CREATE UNIQUE INDEX IF NOT EXISTS "Review_adminId_key" ON "Review"("adminId");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_gateway_config_adminId_key" ON "payment_gateway_config"("adminId");
CREATE INDEX IF NOT EXISTS "invoice_line_item_invoiceId_idx" ON "invoice_line_item"("invoiceId");
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_event_dedupeKey_key" ON "outbox_event"("dedupeKey");
CREATE INDEX IF NOT EXISTS "outbox_event_status_nextAttemptAt_createdAt_idx" ON "outbox_event"("status", "nextAttemptAt", "createdAt");
CREATE INDEX IF NOT EXISTS "outbox_event_lockedAt_idx" ON "outbox_event"("lockedAt");
CREATE INDEX IF NOT EXISTS "outbox_event_processedAt_createdAt_idx" ON "outbox_event"("processedAt", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "payment_paymentRef_key" ON "payment"("paymentRef");
CREATE INDEX IF NOT EXISTS "payment_adminId_idx" ON "payment"("adminId");
CREATE INDEX IF NOT EXISTS "payment_invoiceId_idx" ON "payment"("invoiceId");
CREATE UNIQUE INDEX IF NOT EXISTS "quote_quoteRef_key" ON "quote"("quoteRef");
CREATE UNIQUE INDEX IF NOT EXISTS "quote_publicToken_key" ON "quote"("publicToken");
CREATE INDEX IF NOT EXISTS "quote_adminId_status_idx" ON "quote"("adminId", "status");
CREATE INDEX IF NOT EXISTS "quote_clientId_idx" ON "quote"("clientId");
CREATE INDEX IF NOT EXISTS "quote_serviceCatalogId_idx" ON "quote"("serviceCatalogId");
CREATE INDEX IF NOT EXISTS "quote_line_item_quoteId_idx" ON "quote_line_item"("quoteId");
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_estimateRef_key" ON "estimate"("estimateRef");
CREATE INDEX IF NOT EXISTS "estimate_adminId_status_idx" ON "estimate"("adminId", "status");
CREATE INDEX IF NOT EXISTS "estimate_clientId_idx" ON "estimate"("clientId");
CREATE INDEX IF NOT EXISTS "estimate_serviceCatalogId_idx" ON "estimate"("serviceCatalogId");
CREATE INDEX IF NOT EXISTS "estimate_line_item_estimateId_idx" ON "estimate_line_item"("estimateId");
CREATE INDEX IF NOT EXISTS "quote_template_adminId_idx" ON "quote_template"("adminId");
CREATE INDEX IF NOT EXISTS "quote_template_serviceCatalogId_idx" ON "quote_template"("serviceCatalogId");
CREATE INDEX IF NOT EXISTS "quote_template_line_item_templateId_idx" ON "quote_template_line_item"("templateId");
CREATE UNIQUE INDEX IF NOT EXISTS "recurring_schedule_scheduleRef_key" ON "recurring_schedule"("scheduleRef");
CREATE INDEX IF NOT EXISTS "recurring_schedule_adminId_status_idx" ON "recurring_schedule"("adminId", "status");
CREATE INDEX IF NOT EXISTS "recurring_schedule_nextRunAt_status_idx" ON "recurring_schedule"("nextRunAt", "status");
CREATE INDEX IF NOT EXISTS "recurring_schedule_serviceCatalogId_idx" ON "recurring_schedule"("serviceCatalogId");
CREATE UNIQUE INDEX IF NOT EXISTS "review_token_token_key" ON "review_token"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "review_token_jobId_key" ON "review_token"("jobId");
CREATE INDEX IF NOT EXISTS "review_token_adminId_idx" ON "review_token"("adminId");
CREATE INDEX IF NOT EXISTS "review_adminId_status_idx" ON "review"("adminId", "status");
CREATE INDEX IF NOT EXISTS "review_staffId_idx" ON "review"("staffId");
CREATE INDEX IF NOT EXISTS "review_jobId_idx" ON "review"("jobId");
CREATE UNIQUE INDEX IF NOT EXISTS "service_catalog_serviceName_adminId_key" ON "service_catalog"("serviceName", "adminId");
CREATE INDEX IF NOT EXISTS "service_catalog_adminId_category_status_idx" ON "service_catalog"("adminId", "category", "status");
CREATE INDEX IF NOT EXISTS "service_catalog_adminId_legacyServiceType_idx" ON "service_catalog"("adminId", "legacyServiceType");
CREATE UNIQUE INDEX IF NOT EXISTS "StaffProfile_userId_key" ON "StaffProfile"("userId");
CREATE INDEX IF NOT EXISTS "StaffProfile_adminId_staffRole_idx" ON "StaffProfile"("adminId", "staffRole");
CREATE UNIQUE INDEX IF NOT EXISTS "StaffAvailability_staffId_day_key" ON "StaffAvailability"("staffId", "day");
CREATE INDEX IF NOT EXISTS "StaffLeave_staffId_status_endDate_idx" ON "StaffLeave"("staffId", "status", "endDate");
CREATE UNIQUE INDEX IF NOT EXISTS "Plan_subscriptionPlanId_interval_key" ON "Plan"("subscriptionPlanId", "interval");
CREATE UNIQUE INDEX IF NOT EXISTS "SubscriptionPlan_name_key" ON "SubscriptionPlan"("name");
CREATE INDEX IF NOT EXISTS "Subscription_adminId_idx" ON "Subscription"("adminId");
CREATE INDEX IF NOT EXISTS "Subscription_status_isTrial_currentPeriodEnd_idx" ON "Subscription"("status", "isTrial", "currentPeriodEnd");
CREATE INDEX IF NOT EXISTS "Subscription_status_isTrial_trialEndsAt_idx" ON "Subscription"("status", "isTrial", "trialEndsAt");
CREATE INDEX IF NOT EXISTS "PendingPlanChange_subscriptionId_status_createdAt_idx" ON "PendingPlanChange"("subscriptionId", "status", "createdAt");
CREATE INDEX IF NOT EXISTS "PendingPlanChange_status_expiresAt_idx" ON "PendingPlanChange"("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "PendingPlanChange_status_createdAt_idx" ON "PendingPlanChange"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "PendingPlanChange_couponId_status_idx" ON "PendingPlanChange"("couponId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "business_website_adminId_key" ON "business_website"("adminId");
CREATE UNIQUE INDEX IF NOT EXISTS "business_website_subdomain_key" ON "business_website"("subdomain");
CREATE INDEX IF NOT EXISTS "business_website_status_idx" ON "business_website"("status");
CREATE INDEX IF NOT EXISTS "business_website_templateId_templateVersion_idx" ON "business_website"("templateId", "templateVersion");
CREATE UNIQUE INDEX IF NOT EXISTS "website_page_websiteId_slug_key" ON "website_page"("websiteId", "slug");
CREATE INDEX IF NOT EXISTS "website_page_websiteId_sortOrder_idx" ON "website_page"("websiteId", "sortOrder");
CREATE INDEX IF NOT EXISTS "website_page_websiteId_kind_idx" ON "website_page"("websiteId", "kind");
CREATE UNIQUE INDEX IF NOT EXISTS "website_revision_websiteId_revisionNumber_key" ON "website_revision"("websiteId", "revisionNumber");
CREATE INDEX IF NOT EXISTS "website_revision_websiteId_createdAt_idx" ON "website_revision"("websiteId", "createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "website_domain_domain_key" ON "website_domain"("domain");
CREATE UNIQUE INDEX IF NOT EXISTS "website_domain_verificationToken_key" ON "website_domain"("verificationToken");
CREATE INDEX IF NOT EXISTS "website_domain_websiteId_status_idx" ON "website_domain"("websiteId", "status");
CREATE INDEX IF NOT EXISTS "website_domain_websiteId_isPrimary_createdAt_idx" ON "website_domain"("websiteId", "isPrimary", "createdAt");
CREATE INDEX IF NOT EXISTS "website_domain_verificationStartedAt_idx" ON "website_domain"("verificationStartedAt");
CREATE UNIQUE INDEX IF NOT EXISTS "website_subdomain_alias_subdomain_key" ON "website_subdomain_alias"("subdomain");
CREATE INDEX IF NOT EXISTS "website_subdomain_alias_websiteId_idx" ON "website_subdomain_alias"("websiteId");
CREATE UNIQUE INDEX IF NOT EXISTS "website_asset_websiteId_publicId_key" ON "website_asset"("websiteId", "publicId");
CREATE INDEX IF NOT EXISTS "website_asset_websiteId_createdAt_idx" ON "website_asset"("websiteId", "createdAt");
CREATE INDEX IF NOT EXISTS "website_asset_websiteId_folder_createdAt_idx" ON "website_asset"("websiteId", "folder", "createdAt");
CREATE INDEX IF NOT EXISTS "website_analytics_event_websiteId_createdAt_idx" ON "website_analytics_event"("websiteId", "createdAt");
CREATE INDEX IF NOT EXISTS "website_analytics_event_websiteId_eventType_createdAt_idx" ON "website_analytics_event"("websiteId", "eventType", "createdAt");
CREATE INDEX IF NOT EXISTS "website_analytics_event_websiteId_path_createdAt_idx" ON "website_analytics_event"("websiteId", "path", "createdAt");
CREATE INDEX IF NOT EXISTS "website_analytics_event_websiteId_visitorHash_createdAt_idx" ON "website_analytics_event"("websiteId", "visitorHash", "createdAt");
CREATE INDEX IF NOT EXISTS "website_analytics_event_createdAt_idx" ON "website_analytics_event"("createdAt");

-- Raw SQL indexes referenced by the schema but missing from checked-in migration history.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS "client_name_trgm_idx" ON "client" USING GIN ("name" gin_trgm_ops);
CREATE INDEX IF NOT EXISTS "client_email_trgm_idx" ON "client" USING GIN ("email" gin_trgm_ops);
CREATE UNIQUE INDEX IF NOT EXISTS "booking_form_service_legacy_unique"
  ON "booking_form_service" ("formId", "serviceType")
  WHERE "serviceCatalogId" IS NULL AND "serviceType" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "estimate_form_service_legacy_unique"
  ON "estimate_form_service" ("formId", "serviceType")
  WHERE "serviceCatalogId" IS NULL AND "serviceType" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 6) Foreign keys — add only when the named constraint is absent
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ActivityLog_adminId_fkey' AND conrelid = "ActivityLog"::regclass) THEN
    ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AdminProfile_userId_fkey' AND conrelid = "AdminProfile"::regclass) THEN
    ALTER TABLE "AdminProfile" ADD CONSTRAINT "AdminProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'WorkLocation_adminId_fkey' AND conrelid = "WorkLocation"::regclass) THEN
    ALTER TABLE "WorkLocation" ADD CONSTRAINT "WorkLocation_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_preference_adminId_fkey' AND conrelid = "notification_preference"::regclass) THEN
    ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pricing_rules_adminId_fkey' AND conrelid = "pricing_rules"::regclass) THEN
    ALTER TABLE "pricing_rules" ADD CONSTRAINT "pricing_rules_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_adminId_fkey' AND conrelid = "notification"::regclass) THEN
    ALTER TABLE "notification" ADD CONSTRAINT "notification_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_template_adminId_fkey' AND conrelid = "notification_template"::regclass) THEN
    ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'push_subscription_userId_fkey' AND conrelid = "push_subscription"::regclass) THEN
    ALTER TABLE "push_subscription" ADD CONSTRAINT "push_subscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_userId_fkey' AND conrelid = "session"::regclass) THEN
    ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'account_userId_fkey' AND conrelid = "account"::regclass) THEN
    ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillingHistory_subscriptionId_fkey' AND conrelid = "BillingHistory"::regclass) THEN
    ALTER TABLE "BillingHistory" ADD CONSTRAINT "BillingHistory_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'BillingHistory_planChangeId_fkey' AND conrelid = "BillingHistory"::regclass) THEN
    ALTER TABLE "BillingHistory" ADD CONSTRAINT "BillingHistory_planChangeId_fkey" FOREIGN KEY ("planChangeId") REFERENCES "PendingPlanChange"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_adminId_fkey' AND conrelid = "booking"::regclass) THEN
    ALTER TABLE "booking" ADD CONSTRAINT "booking_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_serviceCatalogId_fkey' AND conrelid = "booking"::regclass) THEN
    ALTER TABLE "booking" ADD CONSTRAINT "booking_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_clientId_fkey' AND conrelid = "booking"::regclass) THEN
    ALTER TABLE "booking" ADD CONSTRAINT "booking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_quoteId_fkey' AND conrelid = "booking"::regclass) THEN
    ALTER TABLE "booking" ADD CONSTRAINT "booking_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_recurringScheduleId_fkey' AND conrelid = "booking"::regclass) THEN
    ALTER TABLE "booking" ADD CONSTRAINT "booking_recurringScheduleId_fkey" FOREIGN KEY ("recurringScheduleId") REFERENCES "recurring_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_staff_assignment_bookingId_fkey' AND conrelid = "booking_staff_assignment"::regclass) THEN
    ALTER TABLE "booking_staff_assignment" ADD CONSTRAINT "booking_staff_assignment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_staff_assignment_staffId_fkey' AND conrelid = "booking_staff_assignment"::regclass) THEN
    ALTER TABLE "booking_staff_assignment" ADD CONSTRAINT "booking_staff_assignment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_change_request_bookingId_fkey' AND conrelid = "booking_change_request"::regclass) THEN
    ALTER TABLE "booking_change_request" ADD CONSTRAINT "booking_change_request_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_change_request_clientId_fkey' AND conrelid = "booking_change_request"::regclass) THEN
    ALTER TABLE "booking_change_request" ADD CONSTRAINT "booking_change_request_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_change_request_adminId_fkey' AND conrelid = "booking_change_request"::regclass) THEN
    ALTER TABLE "booking_change_request" ADD CONSTRAINT "booking_change_request_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checklist_template_adminId_fkey' AND conrelid = "checklist_template"::regclass) THEN
    ALTER TABLE "checklist_template" ADD CONSTRAINT "checklist_template_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checklist_template_serviceCatalogId_fkey' AND conrelid = "checklist_template"::regclass) THEN
    ALTER TABLE "checklist_template" ADD CONSTRAINT "checklist_template_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'checklist_task_templateId_fkey' AND conrelid = "checklist_task"::regclass) THEN
    ALTER TABLE "checklist_task" ADD CONSTRAINT "checklist_task_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "checklist_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_checklist_jobId_fkey' AND conrelid = "job_checklist"::regclass) THEN
    ALTER TABLE "job_checklist" ADD CONSTRAINT "job_checklist_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_checklist_templateId_fkey' AND conrelid = "job_checklist"::regclass) THEN
    ALTER TABLE "job_checklist" ADD CONSTRAINT "job_checklist_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "checklist_template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_checklist_adminId_fkey' AND conrelid = "job_checklist"::regclass) THEN
    ALTER TABLE "job_checklist" ADD CONSTRAINT "job_checklist_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_checklist_item_checklistId_fkey' AND conrelid = "job_checklist_item"::regclass) THEN
    ALTER TABLE "job_checklist_item" ADD CONSTRAINT "job_checklist_item_checklistId_fkey" FOREIGN KEY ("checklistId") REFERENCES "job_checklist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_adminId_fkey' AND conrelid = "client"::regclass) THEN
    ALTER TABLE "client" ADD CONSTRAINT "client_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'client_note_clientId_fkey' AND conrelid = "client_note"::regclass) THEN
    ALTER TABLE "client_note" ADD CONSTRAINT "client_note_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CouponUsage_adminId_fkey' AND conrelid = "CouponUsage"::regclass) THEN
    ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CouponUsage_couponId_fkey' AND conrelid = "CouponUsage"::regclass) THEN
    ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CouponUsage_subscriptionId_fkey' AND conrelid = "CouponUsage"::regclass) THEN
    ALTER TABLE "CouponUsage" ADD CONSTRAINT "CouponUsage_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expense_adminId_fkey' AND conrelid = "expense"::regclass) THEN
    ALTER TABLE "expense" ADD CONSTRAINT "expense_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_form_adminId_fkey' AND conrelid = "booking_form"::regclass) THEN
    ALTER TABLE "booking_form" ADD CONSTRAINT "booking_form_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_form_field_formId_fkey' AND conrelid = "booking_form_field"::regclass) THEN
    ALTER TABLE "booking_form_field" ADD CONSTRAINT "booking_form_field_formId_fkey" FOREIGN KEY ("formId") REFERENCES "booking_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_form_service_formId_fkey' AND conrelid = "booking_form_service"::regclass) THEN
    ALTER TABLE "booking_form_service" ADD CONSTRAINT "booking_form_service_formId_fkey" FOREIGN KEY ("formId") REFERENCES "booking_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_form_service_serviceCatalogId_fkey' AND conrelid = "booking_form_service"::regclass) THEN
    ALTER TABLE "booking_form_service" ADD CONSTRAINT "booking_form_service_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_form_submission_formId_fkey' AND conrelid = "booking_form_submission"::regclass) THEN
    ALTER TABLE "booking_form_submission" ADD CONSTRAINT "booking_form_submission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "booking_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_form_submission_serviceCatalogId_fkey' AND conrelid = "booking_form_submission"::regclass) THEN
    ALTER TABLE "booking_form_submission" ADD CONSTRAINT "booking_form_submission_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_form_submission_convertedBookingId_fkey' AND conrelid = "booking_form_submission"::regclass) THEN
    ALTER TABLE "booking_form_submission" ADD CONSTRAINT "booking_form_submission_convertedBookingId_fkey" FOREIGN KEY ("convertedBookingId") REFERENCES "booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_form_submission_sourceWebsiteId_fkey' AND conrelid = "booking_form_submission"::regclass) THEN
    ALTER TABLE "booking_form_submission" ADD CONSTRAINT "booking_form_submission_sourceWebsiteId_fkey" FOREIGN KEY ("sourceWebsiteId") REFERENCES "business_website"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_form_adminId_fkey' AND conrelid = "estimate_form"::regclass) THEN
    ALTER TABLE "estimate_form" ADD CONSTRAINT "estimate_form_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_form_field_formId_fkey' AND conrelid = "estimate_form_field"::regclass) THEN
    ALTER TABLE "estimate_form_field" ADD CONSTRAINT "estimate_form_field_formId_fkey" FOREIGN KEY ("formId") REFERENCES "estimate_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_form_service_formId_fkey' AND conrelid = "estimate_form_service"::regclass) THEN
    ALTER TABLE "estimate_form_service" ADD CONSTRAINT "estimate_form_service_formId_fkey" FOREIGN KEY ("formId") REFERENCES "estimate_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_form_service_serviceCatalogId_fkey' AND conrelid = "estimate_form_service"::regclass) THEN
    ALTER TABLE "estimate_form_service" ADD CONSTRAINT "estimate_form_service_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_form_add_on_formId_fkey' AND conrelid = "estimate_form_add_on"::regclass) THEN
    ALTER TABLE "estimate_form_add_on" ADD CONSTRAINT "estimate_form_add_on_formId_fkey" FOREIGN KEY ("formId") REFERENCES "estimate_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_form_submission_formId_fkey' AND conrelid = "estimate_form_submission"::regclass) THEN
    ALTER TABLE "estimate_form_submission" ADD CONSTRAINT "estimate_form_submission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "estimate_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_form_submission_serviceCatalogId_fkey' AND conrelid = "estimate_form_submission"::regclass) THEN
    ALTER TABLE "estimate_form_submission" ADD CONSTRAINT "estimate_form_submission_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_form_submission_sourceWebsiteId_fkey' AND conrelid = "estimate_form_submission"::regclass) THEN
    ALTER TABLE "estimate_form_submission" ADD CONSTRAINT "estimate_form_submission_sourceWebsiteId_fkey" FOREIGN KEY ("sourceWebsiteId") REFERENCES "business_website"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_serviceCatalogId_fkey' AND conrelid = "invoice"::regclass) THEN
    ALTER TABLE "invoice" ADD CONSTRAINT "invoice_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_adminId_fkey' AND conrelid = "invoice"::regclass) THEN
    ALTER TABLE "invoice" ADD CONSTRAINT "invoice_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_bookingId_fkey' AND conrelid = "invoice"::regclass) THEN
    ALTER TABLE "invoice" ADD CONSTRAINT "invoice_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_clientId_fkey' AND conrelid = "invoice"::regclass) THEN
    ALTER TABLE "invoice" ADD CONSTRAINT "invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_adminId_fkey' AND conrelid = "job"::regclass) THEN
    ALTER TABLE "job" ADD CONSTRAINT "job_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_serviceCatalogId_fkey' AND conrelid = "job"::regclass) THEN
    ALTER TABLE "job" ADD CONSTRAINT "job_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_bookingId_fkey' AND conrelid = "job"::regclass) THEN
    ALTER TABLE "job" ADD CONSTRAINT "job_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_clientId_fkey' AND conrelid = "job"::regclass) THEN
    ALTER TABLE "job" ADD CONSTRAINT "job_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_estimateId_fkey' AND conrelid = "job"::regclass) THEN
    ALTER TABLE "job" ADD CONSTRAINT "job_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_quoteId_fkey' AND conrelid = "job"::regclass) THEN
    ALTER TABLE "job" ADD CONSTRAINT "job_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_staff_assignment_jobId_fkey' AND conrelid = "job_staff_assignment"::regclass) THEN
    ALTER TABLE "job_staff_assignment" ADD CONSTRAINT "job_staff_assignment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_staff_assignment_staffId_fkey' AND conrelid = "job_staff_assignment"::regclass) THEN
    ALTER TABLE "job_staff_assignment" ADD CONSTRAINT "job_staff_assignment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_note_jobId_fkey' AND conrelid = "job_note"::regclass) THEN
    ALTER TABLE "job_note" ADD CONSTRAINT "job_note_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_note_adminId_fkey' AND conrelid = "job_note"::regclass) THEN
    ALTER TABLE "job_note" ADD CONSTRAINT "job_note_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_attachment_jobId_fkey' AND conrelid = "job_attachment"::regclass) THEN
    ALTER TABLE "job_attachment" ADD CONSTRAINT "job_attachment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'job_attachment_adminId_fkey' AND conrelid = "job_attachment"::regclass) THEN
    ALTER TABLE "job_attachment" ADD CONSTRAINT "job_attachment_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_adminId_fkey' AND conrelid = "lead"::regclass) THEN
    ALTER TABLE "lead" ADD CONSTRAINT "lead_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_serviceCatalogId_fkey' AND conrelid = "lead"::regclass) THEN
    ALTER TABLE "lead" ADD CONSTRAINT "lead_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_sourceWebsiteId_fkey' AND conrelid = "lead"::regclass) THEN
    ALTER TABLE "lead" ADD CONSTRAINT "lead_sourceWebsiteId_fkey" FOREIGN KEY ("sourceWebsiteId") REFERENCES "business_website"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Payment_adminId_fkey' AND conrelid = "Payment"::regclass) THEN
    ALTER TABLE "Payment" ADD CONSTRAINT "Payment_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Review_adminId_fkey' AND conrelid = "Review"::regclass) THEN
    ALTER TABLE "Review" ADD CONSTRAINT "Review_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_gateway_config_adminId_fkey' AND conrelid = "payment_gateway_config"::regclass) THEN
    ALTER TABLE "payment_gateway_config" ADD CONSTRAINT "payment_gateway_config_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoice_line_item_invoiceId_fkey' AND conrelid = "invoice_line_item"::regclass) THEN
    ALTER TABLE "invoice_line_item" ADD CONSTRAINT "invoice_line_item_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_adminId_fkey' AND conrelid = "payment"::regclass) THEN
    ALTER TABLE "payment" ADD CONSTRAINT "payment_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payment_invoiceId_fkey' AND conrelid = "payment"::regclass) THEN
    ALTER TABLE "payment" ADD CONSTRAINT "payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_adminId_fkey' AND conrelid = "quote"::regclass) THEN
    ALTER TABLE "quote" ADD CONSTRAINT "quote_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_clientId_fkey' AND conrelid = "quote"::regclass) THEN
    ALTER TABLE "quote" ADD CONSTRAINT "quote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_serviceCatalogId_fkey' AND conrelid = "quote"::regclass) THEN
    ALTER TABLE "quote" ADD CONSTRAINT "quote_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_line_item_quoteId_fkey' AND conrelid = "quote_line_item"::regclass) THEN
    ALTER TABLE "quote_line_item" ADD CONSTRAINT "quote_line_item_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_adminId_fkey' AND conrelid = "estimate"::regclass) THEN
    ALTER TABLE "estimate" ADD CONSTRAINT "estimate_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_clientId_fkey' AND conrelid = "estimate"::regclass) THEN
    ALTER TABLE "estimate" ADD CONSTRAINT "estimate_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_serviceCatalogId_fkey' AND conrelid = "estimate"::regclass) THEN
    ALTER TABLE "estimate" ADD CONSTRAINT "estimate_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'estimate_line_item_estimateId_fkey' AND conrelid = "estimate_line_item"::regclass) THEN
    ALTER TABLE "estimate_line_item" ADD CONSTRAINT "estimate_line_item_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_template_adminId_fkey' AND conrelid = "quote_template"::regclass) THEN
    ALTER TABLE "quote_template" ADD CONSTRAINT "quote_template_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_template_serviceCatalogId_fkey' AND conrelid = "quote_template"::regclass) THEN
    ALTER TABLE "quote_template" ADD CONSTRAINT "quote_template_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'quote_template_line_item_templateId_fkey' AND conrelid = "quote_template_line_item"::regclass) THEN
    ALTER TABLE "quote_template_line_item" ADD CONSTRAINT "quote_template_line_item_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "quote_template"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_schedule_adminId_fkey' AND conrelid = "recurring_schedule"::regclass) THEN
    ALTER TABLE "recurring_schedule" ADD CONSTRAINT "recurring_schedule_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_schedule_serviceCatalogId_fkey' AND conrelid = "recurring_schedule"::regclass) THEN
    ALTER TABLE "recurring_schedule" ADD CONSTRAINT "recurring_schedule_serviceCatalogId_fkey" FOREIGN KEY ("serviceCatalogId") REFERENCES "service_catalog"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_schedule_clientId_fkey' AND conrelid = "recurring_schedule"::regclass) THEN
    ALTER TABLE "recurring_schedule" ADD CONSTRAINT "recurring_schedule_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_staff_assignment_scheduleId_fkey' AND conrelid = "recurring_staff_assignment"::regclass) THEN
    ALTER TABLE "recurring_staff_assignment" ADD CONSTRAINT "recurring_staff_assignment_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "recurring_schedule"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_staff_assignment_staffId_fkey' AND conrelid = "recurring_staff_assignment"::regclass) THEN
    ALTER TABLE "recurring_staff_assignment" ADD CONSTRAINT "recurring_staff_assignment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_token_jobId_fkey' AND conrelid = "review_token"::regclass) THEN
    ALTER TABLE "review_token" ADD CONSTRAINT "review_token_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_token_adminId_fkey' AND conrelid = "review_token"::regclass) THEN
    ALTER TABLE "review_token" ADD CONSTRAINT "review_token_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_reviewTokenId_fkey' AND conrelid = "review"::regclass) THEN
    ALTER TABLE "review" ADD CONSTRAINT "review_reviewTokenId_fkey" FOREIGN KEY ("reviewTokenId") REFERENCES "review_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'review_adminId_fkey' AND conrelid = "review"::regclass) THEN
    ALTER TABLE "review" ADD CONSTRAINT "review_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_catalog_adminId_fkey' AND conrelid = "service_catalog"::regclass) THEN
    ALTER TABLE "service_catalog" ADD CONSTRAINT "service_catalog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffProfile_userId_fkey' AND conrelid = "StaffProfile"::regclass) THEN
    ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffProfile_adminId_fkey' AND conrelid = "StaffProfile"::regclass) THEN
    ALTER TABLE "StaffProfile" ADD CONSTRAINT "StaffProfile_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffAvailability_staffId_fkey' AND conrelid = "StaffAvailability"::regclass) THEN
    ALTER TABLE "StaffAvailability" ADD CONSTRAINT "StaffAvailability_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'StaffLeave_staffId_fkey' AND conrelid = "StaffLeave"::regclass) THEN
    ALTER TABLE "StaffLeave" ADD CONSTRAINT "StaffLeave_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Plan_subscriptionPlanId_fkey' AND conrelid = "Plan"::regclass) THEN
    ALTER TABLE "Plan" ADD CONSTRAINT "Plan_subscriptionPlanId_fkey" FOREIGN KEY ("subscriptionPlanId") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Subscription_adminId_fkey' AND conrelid = "Subscription"::regclass) THEN
    ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Subscription_planId_fkey' AND conrelid = "Subscription"::regclass) THEN
    ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Subscription_couponId_fkey' AND conrelid = "Subscription"::regclass) THEN
    ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Subscription_subscriptionPlanId_fkey' AND conrelid = "Subscription"::regclass) THEN
    ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_subscriptionPlanId_fkey" FOREIGN KEY ("subscriptionPlanId") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PendingPlanChange_subscriptionId_fkey' AND conrelid = "PendingPlanChange"::regclass) THEN
    ALTER TABLE "PendingPlanChange" ADD CONSTRAINT "PendingPlanChange_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PendingPlanChange_targetPlanId_fkey' AND conrelid = "PendingPlanChange"::regclass) THEN
    ALTER TABLE "PendingPlanChange" ADD CONSTRAINT "PendingPlanChange_targetPlanId_fkey" FOREIGN KEY ("targetPlanId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PendingPlanChange_couponId_fkey' AND conrelid = "PendingPlanChange"::regclass) THEN
    ALTER TABLE "PendingPlanChange" ADD CONSTRAINT "PendingPlanChange_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_website_adminId_fkey' AND conrelid = "business_website"::regclass) THEN
    ALTER TABLE "business_website" ADD CONSTRAINT "business_website_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_website_primaryBookingFormId_fkey' AND conrelid = "business_website"::regclass) THEN
    ALTER TABLE "business_website" ADD CONSTRAINT "business_website_primaryBookingFormId_fkey" FOREIGN KEY ("primaryBookingFormId") REFERENCES "booking_form"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'business_website_primaryEstimateFormId_fkey' AND conrelid = "business_website"::regclass) THEN
    ALTER TABLE "business_website" ADD CONSTRAINT "business_website_primaryEstimateFormId_fkey" FOREIGN KEY ("primaryEstimateFormId") REFERENCES "estimate_form"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_page_websiteId_fkey' AND conrelid = "website_page"::regclass) THEN
    ALTER TABLE "website_page" ADD CONSTRAINT "website_page_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "business_website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_revision_websiteId_fkey' AND conrelid = "website_revision"::regclass) THEN
    ALTER TABLE "website_revision" ADD CONSTRAINT "website_revision_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "business_website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_domain_websiteId_fkey' AND conrelid = "website_domain"::regclass) THEN
    ALTER TABLE "website_domain" ADD CONSTRAINT "website_domain_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "business_website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_subdomain_alias_websiteId_fkey' AND conrelid = "website_subdomain_alias"::regclass) THEN
    ALTER TABLE "website_subdomain_alias" ADD CONSTRAINT "website_subdomain_alias_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "business_website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_asset_websiteId_fkey' AND conrelid = "website_asset"::regclass) THEN
    ALTER TABLE "website_asset" ADD CONSTRAINT "website_asset_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "business_website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'website_analytics_event_websiteId_fkey' AND conrelid = "website_analytics_event"::regclass) THEN
    ALTER TABLE "website_analytics_event" ADD CONSTRAINT "website_analytics_event_websiteId_fkey" FOREIGN KEY ("websiteId") REFERENCES "business_website"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- Migration intentionally performs no DROP TABLE / DROP COLUMN / TRUNCATE.
-- Legacy structural data is retained; application reconciliation runs after migrate deploy.
