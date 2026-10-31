-- Sectors: named offerings with no origin/destination/arrival (e.g. mountain flights).
CREATE TABLE "Sector" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Sector_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Sector_name_key" ON "Sector"("name");

ALTER TABLE "Flight" ALTER COLUMN "originId" DROP NOT NULL,
  ALTER COLUMN "destinationId" DROP NOT NULL,
  ALTER COLUMN "arrivalAt" DROP NOT NULL,
  ADD COLUMN "sectorId" UUID;
ALTER TABLE "Flight" ADD CONSTRAINT "Flight_sectorId_fkey" FOREIGN KEY ("sectorId") REFERENCES "Sector"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Flight_sectorId_departureAt_idx" ON "Flight"("sectorId", "departureAt");

ALTER TABLE "Flight" DROP CONSTRAINT "flight_times_ordered";
ALTER TABLE "Flight" DROP CONSTRAINT "flight_route_distinct";
ALTER TABLE "Flight" ADD CONSTRAINT "flight_times_ordered" CHECK ("arrivalAt" IS NULL OR "arrivalAt" > "departureAt");
ALTER TABLE "Flight" ADD CONSTRAINT "flight_route_distinct" CHECK ("originId" IS NULL OR "originId" <> "destinationId");
-- Exactly one kind: a route flight (both airports + arrival) or a sector flight (sector only).
ALTER TABLE "Flight" ADD CONSTRAINT "flight_kind" CHECK (
  ("sectorId" IS NULL AND "originId" IS NOT NULL AND "destinationId" IS NOT NULL AND "arrivalAt" IS NOT NULL)
  OR ("sectorId" IS NOT NULL AND "originId" IS NULL AND "destinationId" IS NULL)
);

-- The day the customer asked to fly (captured at inquiry; staff can edit it and move the booking to a nearby flight).
ALTER TABLE "Booking" ADD COLUMN "requestedDate" DATE,
  ADD COLUMN "requestedReturnDate" DATE;
