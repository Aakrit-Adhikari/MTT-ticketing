-- History of reschedules: what the booking was on, what it moved to, when, by whom, and why.
CREATE TABLE "Reschedule" (
  "id" UUID NOT NULL,
  "bookingId" UUID NOT NULL,
  "direction" "SegmentDirection" NOT NULL,
  "fromFlightNumber" TEXT NOT NULL,
  "fromDepartureAt" TIMESTAMP(3) NOT NULL,
  "toFlightNumber" TEXT NOT NULL,
  "toDepartureAt" TIMESTAMP(3) NOT NULL,
  "note" TEXT,
  "doneById" UUID,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Reschedule_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Reschedule_bookingId_idx" ON "Reschedule"("bookingId");
CREATE INDEX "Reschedule_createdAt_idx" ON "Reschedule"("createdAt");
ALTER TABLE "Reschedule" ADD CONSTRAINT "Reschedule_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reschedule" ADD CONSTRAINT "Reschedule_doneById_fkey" FOREIGN KEY ("doneById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
