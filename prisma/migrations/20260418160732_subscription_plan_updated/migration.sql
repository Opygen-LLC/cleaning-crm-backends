/*
  Warnings:

  - You are about to drop the column `planId` on the `Plan` table. All the data in the column will be lost.
  - You are about to drop the column `planId` on the `Subscription` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[subscriptionPlanId,interval]` on the table `Plan` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `subscriptionPlanId` to the `Plan` table without a default value. This is not possible if the table is not empty.
  - Added the required column `subscriptionPlanId` to the `Subscription` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Plan" DROP CONSTRAINT "Plan_planId_fkey";

-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_planId_fkey";

-- DropIndex
DROP INDEX "Plan_planId_interval_key";

-- AlterTable
ALTER TABLE "Plan" DROP COLUMN "planId",
ADD COLUMN     "subscriptionPlanId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Subscription" DROP COLUMN "planId",
ADD COLUMN     "subscriptionPlanId" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Plan_subscriptionPlanId_interval_key" ON "Plan"("subscriptionPlanId", "interval");

-- AddForeignKey
ALTER TABLE "Plan" ADD CONSTRAINT "Plan_subscriptionPlanId_fkey" FOREIGN KEY ("subscriptionPlanId") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_subscriptionPlanId_fkey" FOREIGN KEY ("subscriptionPlanId") REFERENCES "SubscriptionPlan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
