-- Time adjusted for one ticket on the same flight (delay), and the airline's ticket PDFs.
ALTER TABLE "BookingSegment" ADD COLUMN "actualDepartureAt" TIMESTAMP(3);

CREATE TABLE "TicketFile" (
  "id" UUID NOT NULL,
  "bookingId" UUID NOT NULL,
  "filename" TEXT NOT NULL,
  "size" INTEGER NOT NULL,
  "data" BYTEA NOT NULL,
  "uploadedByName" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "TicketFile_bookingId_idx" ON "TicketFile"("bookingId");
ALTER TABLE "TicketFile" ADD CONSTRAINT "TicketFile_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;
