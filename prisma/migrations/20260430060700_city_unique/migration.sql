/*
  Warnings:

  - A unique constraint covering the columns `[city]` on the table `WorkLocation` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "WorkLocation_city_key" ON "WorkLocation"("city");
