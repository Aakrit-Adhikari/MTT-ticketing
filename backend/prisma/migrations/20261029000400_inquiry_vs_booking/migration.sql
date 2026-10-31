-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('WEBSITE', 'STAFF');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "source" "BookingSource" NOT NULL DEFAULT 'WEBSITE';
ALTER TABLE "Booking" ADD COLUMN "confirmedAt" TIMESTAMP(3);

-- Existing confirmed/ticketed rows are bookings already.
UPDATE "Booking" SET "confirmedAt" = "updatedAt" WHERE status IN ('CONFIRMED', 'TICKETED');

-- CreateIndex
CREATE INDEX "Booking_confirmedAt_idx" ON "Booking"("confirmedAt");
