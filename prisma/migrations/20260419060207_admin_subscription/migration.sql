/*
  Warnings:

  - Added the required column `planId` to the `Subscription` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "Subscription" DROP CONSTRAINT "Subscription_adminId_fkey";

-- AlterTable
ALTER TABLE "Subscription" ADD COLUMN     "planId" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "AdminProfile_createdAt_idx" ON "AdminProfile"("createdAt");

-- CreateIndex
CREATE INDEX "StaffProfile_adminId_staffRole_idx" ON "StaffProfile"("adminId", "staffRole");

-- CreateIndex
CREATE INDEX "Subscription_adminId_idx" ON "Subscription"("adminId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "Plan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
