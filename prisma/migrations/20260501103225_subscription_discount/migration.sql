-- AlterTable
ALTER TABLE "Plan" ADD COLUMN     "discount" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
ADD COLUMN     "discountEndDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "SubscriptionPlan" ALTER COLUMN "name" SET DEFAULT 'GROWTH';
