/*
  Warnings:

  - Added the required column `startDate` to the `StaffProfile` table without a default value. This is not possible if the table is not empty.
  - Made the column `mobileNumber` on table `StaffProfile` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "WeekDay" AS ENUM ('SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY');

-- AlterTable
ALTER TABLE "StaffProfile" ADD COLUMN     "address" TEXT,
ADD COLUMN     "adminNote" TEXT,
ADD COLUMN     "emergencyMobileNumber" TEXT,
ADD COLUMN     "emergencyName" TEXT,
ADD COLUMN     "hourlyRate" DOUBLE PRECISION,
ADD COLUMN     "specialty" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "startDate" TIMESTAMP(3) NOT NULL,
ALTER COLUMN "mobileNumber" SET NOT NULL;

-- CreateTable
CREATE TABLE "StaffAvailability" (
    "id" TEXT NOT NULL,
    "day" "WeekDay" NOT NULL,
    "startTime" TEXT,
    "endTime" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "staffId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffAvailability_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffAvailability_staffId_day_key" ON "StaffAvailability"("staffId", "day");

-- AddForeignKey
ALTER TABLE "StaffAvailability" ADD CONSTRAINT "StaffAvailability_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "StaffProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
