/*
  Warnings:

  - The `country` column on the `AdminProfile` table would be dropped and recreated. This will lead to data loss if there is data in the column.

*/
-- AlterTable
ALTER TABLE "AdminProfile" DROP COLUMN "country",
ADD COLUMN     "country" "Country";
