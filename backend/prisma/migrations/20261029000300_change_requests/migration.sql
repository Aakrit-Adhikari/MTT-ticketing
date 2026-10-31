-- CreateEnum
CREATE TYPE "ChangeRequestType" AS ENUM ('CANCEL_REFUND', 'RESCHEDULE');
CREATE TYPE "ChangeRequestStatus" AS ENUM ('OPEN', 'DONE', 'REJECTED');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN "rescheduledCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "BookingSegment" ADD COLUMN "originalFlightId" UUID;

-- CreateTable
CREATE TABLE "ChangeRequest" (
    "id" UUID NOT NULL,
    "bookingId" UUID NOT NULL,
    "type" "ChangeRequestType" NOT NULL,
    "status" "ChangeRequestStatus" NOT NULL DEFAULT 'OPEN',
    "message" TEXT NOT NULL,
    "preferredDate" TEXT,
    "staffNote" TEXT,
    "refundAmount" DECIMAL(12,2),
    "resolvedById" UUID,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChangeRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChangeRequest_bookingId_idx" ON "ChangeRequest"("bookingId");
CREATE INDEX "ChangeRequest_status_createdAt_idx" ON "ChangeRequest"("status", "createdAt");

-- A customer can have only one OPEN request of each type per booking (prevents duplicate submissions / spam).
CREATE UNIQUE INDEX "ChangeRequest_one_open_per_type" ON "ChangeRequest"("bookingId", "type") WHERE status = 'OPEN';

-- AddForeignKey
ALTER TABLE "ChangeRequest" ADD CONSTRAINT "ChangeRequest_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
