/*
  Warnings:

  - You are about to drop the column `state` on the `AdminProfile` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "AdminProfile" DROP COLUMN "state",
ADD COLUMN     "businessEmail" TEXT,
ADD COLUMN     "businessType" TEXT,
ADD COLUMN     "website" TEXT;
