-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'DELETED');

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "mobileNumber" TEXT,
ADD COLUMN     "status" "AccountStatus" NOT NULL DEFAULT 'PENDING';
