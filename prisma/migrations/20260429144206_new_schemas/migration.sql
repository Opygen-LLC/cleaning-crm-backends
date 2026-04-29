/*
  Warnings:

  - You are about to drop the column `country` on the `user` table. All the data in the column will be lost.
  - You are about to drop the column `mobileNumber` on the `user` table. All the data in the column will be lost.
  - You are about to drop the `Payment` table. If the table is not empty, all the data it contains will be lost.
  - Added the required column `city` to the `AdminProfile` table without a default value. This is not possible if the table is not empty.
  - Added the required column `country` to the `AdminProfile` table without a default value. This is not possible if the table is not empty.
  - Added the required column `state` to the `AdminProfile` table without a default value. This is not possible if the table is not empty.
  - Added the required column `zipcode` to the `AdminProfile` table without a default value. This is not possible if the table is not empty.
  - Made the column `address` on table `AdminProfile` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "PaymentGateway" AS ENUM ('STRIPE', 'PAYPAL', 'NONE');

-- CreateEnum
CREATE TYPE "Country" AS ENUM ('AFGHANISTAN', 'ALBANIA', 'ALGERIA', 'ANDORRA', 'ANGOLA', 'ANTIGUA_AND_BARBUDA', 'ARGENTINA', 'ARMENIA', 'AUSTRALIA', 'AUSTRIA', 'AZERBAIJAN', 'BAHAMAS', 'BAHRAIN', 'BANGLADESH', 'BARBADOS', 'BELARUS', 'BELGIUM', 'BELIZE', 'BENIN', 'BHUTAN', 'BOLIVIA', 'BOSNIA_AND_HERZEGOVINA', 'BOTSWANA', 'BRAZIL', 'BRUNEI', 'BULGARIA', 'BURKINA_FASO', 'BURUNDI', 'CABO_VERDE', 'CAMBODIA', 'CAMEROON', 'CANADA', 'CENTRAL_AFRICAN_REPUBLIC', 'CHAD', 'CHILE', 'CHINA', 'COLOMBIA', 'COMOROS', 'CONGO_DEMOCRATIC_REPUBLIC', 'CONGO_REPUBLIC', 'COSTA_RICA', 'CROATIA', 'CUBA', 'CYPRUS', 'CZECHIA', 'DENMARK', 'DJIBOUTI', 'DOMINICA', 'DOMINICAN_REPUBLIC', 'ECUADOR', 'EGYPT', 'EL_SALVADOR', 'EQUATORIAL_GUINEA', 'ERITREA', 'ESTONIA', 'ESWATINI', 'ETHIOPIA', 'FIJI', 'FINLAND', 'FRANCE', 'GABON', 'GAMBIA', 'GEORGIA', 'GERMANY', 'GHANA', 'GREECE', 'GRENADA', 'GUATEMALA', 'GUINEA', 'GUINEA_BISSAU', 'GUYANA', 'HAITI', 'HONDURAS', 'HUNGARY', 'ICELAND', 'INDIA', 'INDONESIA', 'IRAN', 'IRAQ', 'IRELAND', 'ISRAEL', 'ITALY', 'JAMAICA', 'JAPAN', 'JORDAN', 'KAZAKHSTAN', 'KENYA', 'KIRIBATI', 'KOREA_NORTH', 'KOREA_SOUTH', 'KOSOVO', 'KUWAIT', 'KYRGYZSTAN', 'LAOS', 'LATVIA', 'LEBANON', 'LESOTHO', 'LIBERIA', 'LIBYA', 'LIECHTENSTEIN', 'LITHUANIA', 'LUXEMBOURG', 'MADAGASCAR', 'MALAWI', 'MALAYSIA', 'MALDIVES', 'MALI', 'MALTA', 'MARSHALL_ISLANDS', 'MAURITANIA', 'MAURITIUS', 'MEXICO', 'MICRONESIA', 'MOLDOVA', 'MONACO', 'MONGOLIA', 'MONTENEGRO', 'MOROCCO', 'MOZAMBIQUE', 'MYANMAR', 'NAMIBIA', 'NAURU', 'NEPAL', 'NETHERLANDS', 'NEW_ZEALAND', 'NICARAGUA', 'NIGER', 'NIGERIA', 'NORTH_MACEDONIA', 'NORWAY', 'OMAN', 'PAKISTAN', 'PALAU', 'PALESTINE', 'PANAMA', 'PAPUA_NEW_GUINEA', 'PARAGUAY', 'PERU', 'PHILIPPINES', 'POLAND', 'PORTUGAL', 'QATAR', 'ROMANIA', 'RUSSIA', 'RWANDA', 'SAINT_KITTS_AND_NEVIS', 'SAINT_LUCIA', 'SAINT_VINCENT_AND_THE_GRENADINES', 'SAMOA', 'SAN_MARINO', 'SAO_TOME_AND_PRINCIPE', 'SAUDI_ARABIA', 'SENEGAL', 'SERBIA', 'SEYCHELLES', 'SIERRA_LEONE', 'SINGAPORE', 'SLOVAKIA', 'SLOVENIA', 'SOLOMON_ISLANDS', 'SOMALIA', 'SOUTH_AFRICA', 'SOUTH_SUDAN', 'SPAIN', 'SRI_LANKA', 'SUDAN', 'SURINAME', 'SWEDEN', 'SWITZERLAND', 'SYRIA', 'TAJIKISTAN', 'TANZANIA', 'THAILAND', 'TIMOR_LESTE', 'TOGO', 'TONGA', 'TRINIDAD_AND_TOBAGO', 'TUNISIA', 'TURKEY', 'TURKMENISTAN', 'TUVALU', 'UGANDA', 'UKRAINE', 'UNITED_ARAB_EMIRATES', 'UNITED_KINGDOM', 'UNITED_STATES', 'URUGUAY', 'UZBEKISTAN', 'VANUATU', 'VATICAN_CITY', 'VENEZUELA', 'VIETNAM', 'YEMEN', 'ZAMBIA', 'ZIMBABWE');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'BLOCKED');

-- CreateEnum
CREATE TYPE "ServiceType" AS ENUM ('RESIDENTIAL_CLEAN', 'DEEP_CLEAN', 'OFFICE_CLEAN', 'END_OF_TENANCY', 'CARPET_CLEAN', 'WINDOW_CLEAN', 'MOVE_IN_OUT_CLEAN');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'CONVERTED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ExpenseCategory" AS ENUM ('EQUIPMENT_AND_SUPPLIES', 'STAFF_WAGES', 'VEHICLE_AND_FUEL', 'MARKETING', 'INSURANCE', 'SOFTWARE_AND_TOOLS', 'TRAINING', 'OFFICE_AND_ADMIN', 'OTHER');

-- CreateEnum
CREATE TYPE "ExpenseFrequency" AS ENUM ('WEEKLY', 'MONTHLY', 'QUARTERLY', 'ANNUALLY');

-- CreateEnum
CREATE TYPE "FormSubmissionStatus" AS ENUM ('NEW', 'REVIEWED', 'CONVERTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "EstimateSubmissionStatus" AS ENUM ('NEW', 'QUOTED', 'CONVERTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "FormFieldType" AS ENUM ('TEXT', 'EMAIL', 'PHONE', 'TEXTAREA', 'SELECT', 'ADDRESS', 'DATE', 'NUMBER');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('EMAIL', 'APP', 'SMS');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "Currency" ADD VALUE 'EUR';
ALTER TYPE "Currency" ADD VALUE 'GBP';
ALTER TYPE "Currency" ADD VALUE 'CAD';
ALTER TYPE "Currency" ADD VALUE 'AUD';

-- DropForeignKey
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_adminId_fkey";

-- AlterTable
ALTER TABLE "AdminProfile" ADD COLUMN     "brandColor" TEXT DEFAULT '#000000',
ADD COLUMN     "city" TEXT NOT NULL,
ADD COLUMN     "country" TEXT NOT NULL,
ADD COLUMN     "mobileNumber" TEXT,
ADD COLUMN     "state" TEXT NOT NULL,
ADD COLUMN     "zipcode" TEXT NOT NULL,
ALTER COLUMN "address" SET NOT NULL;

-- AlterTable
ALTER TABLE "StaffProfile" ADD COLUMN     "mobileNumber" TEXT;

-- AlterTable
ALTER TABLE "user" DROP COLUMN "country",
DROP COLUMN "mobileNumber";

-- DropTable
DROP TABLE "Payment";

-- CreateTable
CREATE TABLE "WorkLocation" (
    "id" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "postcode" TEXT,
    "notes" TEXT,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkLocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_gateway_config" (
    "id" TEXT NOT NULL,
    "activeGateway" "PaymentGateway" NOT NULL DEFAULT 'NONE',
    "stripeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "stripePublishableKey" TEXT,
    "stripeSecretKeyMasked" TEXT,
    "stripeWebhookSecretMasked" TEXT,
    "stripeTestMode" BOOLEAN NOT NULL DEFAULT true,
    "stripeConnectedAccountId" TEXT,
    "paypalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "paypalClientId" TEXT,
    "paypalClientSecretMasked" TEXT,
    "paypalTestMode" BOOLEAN NOT NULL DEFAULT true,
    "paypalConnectedMerchantId" TEXT,
    "invoicePaymentLink" BOOLEAN NOT NULL DEFAULT true,
    "quotePaymentLink" BOOLEAN NOT NULL DEFAULT false,
    "autoSendReceipt" BOOLEAN NOT NULL DEFAULT true,
    "adminId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_gateway_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" TEXT NOT NULL,
    "emailNewBooking" BOOLEAN NOT NULL DEFAULT true,
    "emailBookingCancelled" BOOLEAN NOT NULL DEFAULT true,
    "emailBookingReminder" BOOLEAN NOT NULL DEFAULT true,
    "emailQuoteAccepted" BOOLEAN NOT NULL DEFAULT true,
    "emailQuoteDeclined" BOOLEAN NOT NULL DEFAULT true,
    "emailInvoicePaid" BOOLEAN NOT NULL DEFAULT true,
    "emailInvoiceOverdue" BOOLEAN NOT NULL DEFAULT true,
    "emailNewClient" BOOLEAN NOT NULL DEFAULT false,
    "emailStaffAssigned" BOOLEAN NOT NULL DEFAULT false,
    "emailWeeklySummary" BOOLEAN NOT NULL DEFAULT true,
    "appNewBooking" BOOLEAN NOT NULL DEFAULT true,
    "appJobStatusChange" BOOLEAN NOT NULL DEFAULT true,
    "appQuoteUpdate" BOOLEAN NOT NULL DEFAULT true,
    "appInvoiceUpdate" BOOLEAN NOT NULL DEFAULT false,
    "appClientMessage" BOOLEAN NOT NULL DEFAULT true,
    "smsBookingReminder" BOOLEAN NOT NULL DEFAULT false,
    "smsJobAssigned" BOOLEAN NOT NULL DEFAULT false,
    "reminderHoursBefore" INTEGER NOT NULL DEFAULT 24,
    "digestTime" TEXT NOT NULL DEFAULT '08:00',
    "adminId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking" (
    "id" TEXT NOT NULL,
    "bookingRef" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'SCHEDULED',
    "serviceType" "ServiceType" NOT NULL,
    "address" TEXT NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "durationMins" INTEGER NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "adminId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "quoteId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_staff_assignment" (
    "bookingId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_staff_assignment_pkey" PRIMARY KEY ("bookingId","staffId")
);

-- CreateTable
CREATE TABLE "client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "addressLine1" TEXT NOT NULL,
    "addressLine2" TEXT,
    "city" TEXT NOT NULL,
    "postcode" TEXT NOT NULL,
    "country" TEXT,
    "servicePreference" "ServiceType",
    "totalSpend" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "totalBookings" INTEGER NOT NULL DEFAULT 0,
    "avatar" TEXT,
    "lastBookingDate" TIMESTAMP(3),
    "joinedDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_note" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense" (
    "id" TEXT NOT NULL,
    "expenseRef" TEXT NOT NULL,
    "category" "ExpenseCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "date" TIMESTAMP(3) NOT NULL,
    "paidBy" TEXT NOT NULL,
    "receipt" TEXT,
    "isRecurring" BOOLEAN NOT NULL DEFAULT false,
    "recurringFrequency" "ExpenseFrequency",
    "notes" TEXT,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_form" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "headline" TEXT NOT NULL,
    "subheading" TEXT,
    "accentColor" TEXT NOT NULL DEFAULT '#000000',
    "showReviews" BOOLEAN NOT NULL DEFAULT true,
    "ctaLabel" TEXT DEFAULT 'Request booking',
    "confirmationMessage" TEXT,
    "availableDays" TEXT[],
    "blockedDates" TEXT[],
    "timeSlots" TEXT[],
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_form_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_form_field" (
    "id" TEXT NOT NULL,
    "type" "FormFieldType" NOT NULL,
    "label" TEXT NOT NULL,
    "placeholder" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "options" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "formId" TEXT NOT NULL,

    CONSTRAINT "booking_form_field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_form_service" (
    "id" TEXT NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priceLabel" TEXT,
    "duration" TEXT,
    "formId" TEXT NOT NULL,

    CONSTRAINT "booking_form_service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_form_submission" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" "FormSubmissionStatus" NOT NULL DEFAULT 'NEW',
    "serviceType" "ServiceType" NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "timeSlot" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "notes" TEXT,
    "formId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_form_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_form" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "headline" TEXT NOT NULL,
    "subheading" TEXT,
    "accentColor" TEXT NOT NULL DEFAULT '#000000',
    "showReviews" BOOLEAN NOT NULL DEFAULT true,
    "ctaLabel" TEXT DEFAULT 'Get my free estimate',
    "confirmationMessage" TEXT,
    "coveredPostcodes" TEXT[],
    "coveredCities" TEXT[],
    "showLiveEstimate" BOOLEAN NOT NULL DEFAULT true,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimate_form_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_form_field" (
    "id" TEXT NOT NULL,
    "type" "FormFieldType" NOT NULL,
    "label" TEXT NOT NULL,
    "placeholder" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "options" TEXT[],
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "formId" TEXT NOT NULL,

    CONSTRAINT "estimate_form_field_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_form_service" (
    "id" TEXT NOT NULL,
    "serviceType" "ServiceType" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "basePrice" DECIMAL(10,2),
    "formId" TEXT NOT NULL,

    CONSTRAINT "estimate_form_service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_form_add_on" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "formId" TEXT NOT NULL,

    CONSTRAINT "estimate_form_add_on_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_form_submission" (
    "id" TEXT NOT NULL,
    "ref" TEXT NOT NULL,
    "status" "EstimateSubmissionStatus" NOT NULL DEFAULT 'NEW',
    "serviceType" "ServiceType" NOT NULL,
    "bedrooms" INTEGER NOT NULL,
    "bathrooms" INTEGER NOT NULL,
    "addOnIds" TEXT[],
    "postcode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "notes" TEXT,
    "formId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "estimate_form_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice" (
    "id" TEXT NOT NULL,
    "invoiceRef" TEXT NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "serviceType" "ServiceType" NOT NULL,
    "address" TEXT NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "tax" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "issuedDate" TIMESTAMP(3) NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "paidDate" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "notes" TEXT,
    "internalNotes" TEXT,
    "adminId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "bookingId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_item" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "invoiceId" TEXT NOT NULL,

    CONSTRAINT "invoice_line_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job" (
    "id" TEXT NOT NULL,
    "jobRef" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'SCHEDULED',
    "serviceType" "ServiceType" NOT NULL,
    "address" TEXT NOT NULL,
    "scheduledDate" TIMESTAMP(3) NOT NULL,
    "durationMins" INTEGER NOT NULL,
    "notes" TEXT,
    "quoteId" TEXT,
    "estimateId" TEXT,
    "bookingId" TEXT,
    "adminId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_staff_assignment" (
    "jobId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_staff_assignment_pkey" PRIMARY KEY ("jobId","staffId")
);

-- CreateTable
CREATE TABLE "payment" (
    "id" TEXT NOT NULL,
    "paymentRef" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" "Currency" NOT NULL DEFAULT 'USD',
    "method" "PaymentMethod" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "transactionId" TEXT,
    "invoiceUrl" TEXT,
    "refundAmount" DECIMAL(10,2),
    "gatewayPaymentId" TEXT,
    "gatewayCustomerId" TEXT,
    "adminId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote" (
    "id" TEXT NOT NULL,
    "quoteRef" TEXT NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'DRAFT',
    "serviceType" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "tax" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "internalNotes" TEXT,
    "sentAt" TIMESTAMP(3),
    "adminId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_line_item" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "quoteId" TEXT NOT NULL,

    CONSTRAINT "quote_line_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate" (
    "id" TEXT NOT NULL,
    "estimateRef" TEXT NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "serviceType" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "labourCost" DECIMAL(10,2) NOT NULL,
    "materialCost" DECIMAL(10,2) NOT NULL,
    "overheadCost" DECIMAL(10,2) NOT NULL,
    "marginPercent" DECIMAL(5,2) NOT NULL,
    "subtotal" DECIMAL(10,2) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "tax" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "notes" TEXT,
    "internalNotes" TEXT,
    "sentAt" TIMESTAMP(3),
    "convertedToBookingRef" TEXT,
    "adminId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_line_item" (
    "id" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(10,2) NOT NULL,
    "total" DECIMAL(10,2) NOT NULL,
    "estimateId" TEXT NOT NULL,

    CONSTRAINT "estimate_line_item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WorkLocation_adminId_idx" ON "WorkLocation"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "payment_gateway_config_adminId_key" ON "payment_gateway_config"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_adminId_key" ON "notification_preference"("adminId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_bookingRef_key" ON "booking"("bookingRef");

-- CreateIndex
CREATE INDEX "booking_adminId_status_idx" ON "booking"("adminId", "status");

-- CreateIndex
CREATE INDEX "booking_clientId_idx" ON "booking"("clientId");

-- CreateIndex
CREATE INDEX "booking_scheduledDate_idx" ON "booking"("scheduledDate");

-- CreateIndex
CREATE INDEX "client_adminId_idx" ON "client"("adminId");

-- CreateIndex
CREATE INDEX "client_status_idx" ON "client"("status");

-- CreateIndex
CREATE UNIQUE INDEX "client_email_adminId_key" ON "client"("email", "adminId");

-- CreateIndex
CREATE INDEX "client_note_clientId_idx" ON "client_note"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "expense_expenseRef_key" ON "expense"("expenseRef");

-- CreateIndex
CREATE INDEX "expense_adminId_category_idx" ON "expense"("adminId", "category");

-- CreateIndex
CREATE INDEX "expense_date_idx" ON "expense"("date");

-- CreateIndex
CREATE UNIQUE INDEX "booking_form_slug_key" ON "booking_form"("slug");

-- CreateIndex
CREATE INDEX "booking_form_adminId_idx" ON "booking_form"("adminId");

-- CreateIndex
CREATE INDEX "booking_form_field_formId_idx" ON "booking_form_field"("formId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_form_service_formId_serviceType_key" ON "booking_form_service"("formId", "serviceType");

-- CreateIndex
CREATE UNIQUE INDEX "booking_form_submission_ref_key" ON "booking_form_submission"("ref");

-- CreateIndex
CREATE INDEX "booking_form_submission_formId_status_idx" ON "booking_form_submission"("formId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "estimate_form_slug_key" ON "estimate_form"("slug");

-- CreateIndex
CREATE INDEX "estimate_form_adminId_idx" ON "estimate_form"("adminId");

-- CreateIndex
CREATE INDEX "estimate_form_field_formId_idx" ON "estimate_form_field"("formId");

-- CreateIndex
CREATE UNIQUE INDEX "estimate_form_service_formId_serviceType_key" ON "estimate_form_service"("formId", "serviceType");

-- CreateIndex
CREATE INDEX "estimate_form_add_on_formId_idx" ON "estimate_form_add_on"("formId");

-- CreateIndex
CREATE UNIQUE INDEX "estimate_form_submission_ref_key" ON "estimate_form_submission"("ref");

-- CreateIndex
CREATE INDEX "estimate_form_submission_formId_status_idx" ON "estimate_form_submission"("formId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_invoiceRef_key" ON "invoice"("invoiceRef");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_bookingId_key" ON "invoice"("bookingId");

-- CreateIndex
CREATE INDEX "invoice_adminId_status_idx" ON "invoice"("adminId", "status");

-- CreateIndex
CREATE INDEX "invoice_clientId_idx" ON "invoice"("clientId");

-- CreateIndex
CREATE INDEX "invoice_dueDate_idx" ON "invoice"("dueDate");

-- CreateIndex
CREATE INDEX "invoice_line_item_invoiceId_idx" ON "invoice_line_item"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "job_jobRef_key" ON "job"("jobRef");

-- CreateIndex
CREATE UNIQUE INDEX "job_bookingId_key" ON "job"("bookingId");

-- CreateIndex
CREATE INDEX "job_adminId_status_idx" ON "job"("adminId", "status");

-- CreateIndex
CREATE INDEX "job_clientId_idx" ON "job"("clientId");

-- CreateIndex
CREATE INDEX "job_scheduledDate_idx" ON "job"("scheduledDate");

-- CreateIndex
CREATE UNIQUE INDEX "payment_paymentRef_key" ON "payment"("paymentRef");

-- CreateIndex
CREATE INDEX "payment_adminId_idx" ON "payment"("adminId");

-- CreateIndex
CREATE INDEX "payment_invoiceId_idx" ON "payment"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "quote_quoteRef_key" ON "quote"("quoteRef");

-- CreateIndex
CREATE INDEX "quote_adminId_status_idx" ON "quote"("adminId", "status");

-- CreateIndex
CREATE INDEX "quote_clientId_idx" ON "quote"("clientId");

-- CreateIndex
CREATE INDEX "quote_line_item_quoteId_idx" ON "quote_line_item"("quoteId");

-- CreateIndex
CREATE UNIQUE INDEX "estimate_estimateRef_key" ON "estimate"("estimateRef");

-- CreateIndex
CREATE INDEX "estimate_adminId_status_idx" ON "estimate"("adminId", "status");

-- CreateIndex
CREATE INDEX "estimate_clientId_idx" ON "estimate"("clientId");

-- CreateIndex
CREATE INDEX "estimate_line_item_estimateId_idx" ON "estimate_line_item"("estimateId");

-- AddForeignKey
ALTER TABLE "WorkLocation" ADD CONSTRAINT "WorkLocation_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_gateway_config" ADD CONSTRAINT "payment_gateway_config_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking" ADD CONSTRAINT "booking_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_staff_assignment" ADD CONSTRAINT "booking_staff_assignment_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_staff_assignment" ADD CONSTRAINT "booking_staff_assignment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client" ADD CONSTRAINT "client_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_note" ADD CONSTRAINT "client_note_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense" ADD CONSTRAINT "expense_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_form" ADD CONSTRAINT "booking_form_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_form_field" ADD CONSTRAINT "booking_form_field_formId_fkey" FOREIGN KEY ("formId") REFERENCES "booking_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_form_service" ADD CONSTRAINT "booking_form_service_formId_fkey" FOREIGN KEY ("formId") REFERENCES "booking_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_form_submission" ADD CONSTRAINT "booking_form_submission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "booking_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_form" ADD CONSTRAINT "estimate_form_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_form_field" ADD CONSTRAINT "estimate_form_field_formId_fkey" FOREIGN KEY ("formId") REFERENCES "estimate_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_form_service" ADD CONSTRAINT "estimate_form_service_formId_fkey" FOREIGN KEY ("formId") REFERENCES "estimate_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_form_add_on" ADD CONSTRAINT "estimate_form_add_on_formId_fkey" FOREIGN KEY ("formId") REFERENCES "estimate_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_form_submission" ADD CONSTRAINT "estimate_form_submission_formId_fkey" FOREIGN KEY ("formId") REFERENCES "estimate_form"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice" ADD CONSTRAINT "invoice_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_item" ADD CONSTRAINT "invoice_line_item_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quote"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "estimate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job" ADD CONSTRAINT "job_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_staff_assignment" ADD CONSTRAINT "job_staff_assignment_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_staff_assignment" ADD CONSTRAINT "job_staff_assignment_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment" ADD CONSTRAINT "payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote" ADD CONSTRAINT "quote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_line_item" ADD CONSTRAINT "quote_line_item_quoteId_fkey" FOREIGN KEY ("quoteId") REFERENCES "quote"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate" ADD CONSTRAINT "estimate_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate" ADD CONSTRAINT "estimate_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_line_item" ADD CONSTRAINT "estimate_line_item_estimateId_fkey" FOREIGN KEY ("estimateId") REFERENCES "estimate"("id") ON DELETE CASCADE ON UPDATE CASCADE;
